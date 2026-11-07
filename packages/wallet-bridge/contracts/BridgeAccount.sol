// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {BridgeLib} from "./BridgeLib.sol";

/// An EIP-8141 account controlled by an ordinary browser wallet. No wallet can sign a type-0x06 frame tx, but every
/// wallet can sign EIP-712 typed data, and this account's VERIFY frame checks exactly that with ecrecover.
///
/// VERIFY frame data picks the mode (calldata == frame data; one tag byte, which no public selector starts with):
///   0x01                                     Mode A: signature entry 0 is ARBITRARY and carries the owner's EIP-712
///                                            FrameTx signature (r||s||v). Prefix [self_verify] or [expiry, self_verify].
///   0x02 || abi.encode(Session, bytes sig)   Mode B: signature entry 0 is SECP256K1 by `session.key` over SIG_HASH
///                                            (protocol-checked); `sig` is the owner's EIP-712 Session signature.
///                                            Prefix [expiry_verify(0x8141), self_verify]; the expiry deadline must be
///                                            <= session.validUntil.
/// Validation reads only immutables, the tx, and the ecrecover precompile: no storage, so no stake is needed.
contract BridgeAccount is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable OWNER;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 internal constant SCHEME_ARBITRARY = 0;
    uint256 internal constant SCHEME_SECP256K1 = 1;
    uint256 internal constant MODE_VERIFY = 1;
    uint256 internal constant MODE_SENDER = 2;
    address internal constant EXPIRY_VERIFIER = address(0x8141);
    uint256 internal constant EXPIRY_GAS_MAX = 10_000;
    /// Mode B checks every body frame; a bound keeps validation gas bounded.
    uint256 internal constant MAX_FRAMES = 8;

    error NotSender();
    error BadMode(uint8 tag);
    error BadSignatureCount(uint256 count);
    error BadScheme(uint256 scheme);
    error BadMsg();
    error NotOwner(address recovered);
    error BadLayout();
    error BadExpiry();
    error SessionExpired(uint256 deadline, uint64 validUntil);
    error WrongSessionKey(address signer);
    error TargetNotAllowed(uint256 frame, address target);
    error ValueTooHigh(uint256 frame, uint256 value);
    error CostTooHigh(uint256 maxCost);

    constructor(address owner) payable {
        OWNER = owner;
        DOMAIN_SEPARATOR = BridgeLib.domainSeparator(block.chainid, address(this));
    }

    receive() external payable {}

    fallback() external payable {
        if (address(uint160(txparam(TxParam.SENDER))) != address(this)) revert NotSender();
        if (txparam(TxParam.SIGNATURE_COUNT) != 1) revert BadSignatureCount(txparam(TxParam.SIGNATURE_COUNT));
        uint8 tag = msg.data.length == 0 ? 0 : uint8(msg.data[0]);
        if (tag == 0x01 && msg.data.length == 1) _verifyOwner();
        else if (tag == 0x02) _verifySession();
        else revert BadMode(tag);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Mode A. `to`/`value` are read from the frame right after this VERIFY frame, which must be a SENDER frame.
    function _verifyOwner() private view {
        if (sigparam(0, SigParam.SCHEME) != SCHEME_ARBITRARY) revert BadScheme(sigparam(0, SigParam.SCHEME));
        uint256 call = txparam(TxParam.CURRENT_FRAME_INDEX) + 1;
        uint256 frameCount = txparam(TxParam.FRAME_COUNT);
        if (call >= frameCount || frameparam(call, FrameParam.MODE) != MODE_SENDER) revert BadLayout();
        BridgeLib.FrameTx memory t = BridgeLib.FrameTx({
            sigHash: bytes32(txparam(TxParam.SIG_HASH)),
            to: address(uint160(frameparam(call, FrameParam.RESOLVED_TARGET))),
            value: frameparam(call, FrameParam.VALUE),
            nonce: txparam(TxParam.NONCE),
            frameCount: frameCount,
            maxFeePerGas: txparam(TxParam.MAX_FEE)
        });
        uint256 len = sigparam(0, SigParam.SIGNATURE_LENGTH);
        if (len != 65) revert BridgeLib.BadSignatureLength(len);
        bytes memory sig = sigdatacopy(0, 65, 0);
        address signer = BridgeLib.recover(BridgeLib.digest(DOMAIN_SEPARATOR, BridgeLib.hashFrameTx(t)), sig);
        if (signer != OWNER) revert NotOwner(signer);
    }

    /// Mode B. Frame 0 is the expiry verifier, frame 1 is this VERIFY frame, frames 2.. are SENDER calls in limits.
    function _verifySession() private view {
        (BridgeLib.Session memory s, bytes memory ownerSig) = abi.decode(msg.data[1:], (BridgeLib.Session, bytes));
        address signer = BridgeLib.recover(BridgeLib.digest(DOMAIN_SEPARATOR, BridgeLib.hashSession(s)), ownerSig);
        if (signer != OWNER) revert NotOwner(signer);

        // Entry 0 is checked by the protocol against SIG_HASH only when its msg is empty; an explicit msg would let
        // any old signature by the session key authorise this tx (SIGPARAM gives the signer, not what it signed).
        if (sigparam(0, SigParam.SCHEME) != SCHEME_SECP256K1) revert BadScheme(sigparam(0, SigParam.SCHEME));
        if (sigparam(0, SigParam.MSG) != 0) revert BadMsg();
        address key = address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER)));
        if (key != s.key) revert WrongSessionKey(key);

        uint256 frameCount = txparam(TxParam.FRAME_COUNT);
        if (txparam(TxParam.CURRENT_FRAME_INDEX) != 1 || frameCount < 3 || frameCount > MAX_FRAMES) revert BadLayout();
        if (
            address(uint160(frameparam(0, FrameParam.RESOLVED_TARGET))) != EXPIRY_VERIFIER
                || frameparam(0, FrameParam.MODE) != MODE_VERIFY
                || frameparam(0, FrameParam.EXECUTION_GAS_LIMIT) > EXPIRY_GAS_MAX
                || frameparam(0, FrameParam.DATA_LENGTH) != 8
        ) revert BadExpiry();
        // The expiry verifier enforces "now <= deadline" (TIMESTAMP is banned here); we bound the deadline.
        uint256 deadline = uint256(framedataload(0, 0)) >> 192;
        if (deadline > s.validUntil) revert SessionExpired(deadline, s.validUntil);

        uint256 maxCost = txparam(TxParam.MAX_COST);
        if (maxCost > s.maxCostPerTx) revert CostTooHigh(maxCost);
        for (uint256 i = 2; i < frameCount; i++) {
            if (frameparam(i, FrameParam.MODE) != MODE_SENDER) revert BadLayout();
            address target = address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET)));
            if (s.target != address(0) && target != s.target) revert TargetNotAllowed(i, target);
            uint256 value = frameparam(i, FrameParam.VALUE);
            if (value > s.maxValuePerTx) revert ValueTooHigh(i, value);
        }
    }

    /// EIP-1271 for dapps: the owner's EIP-712 signature over Message(hash) under this account's domain.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        bytes32 d = BridgeLib.digest(DOMAIN_SEPARATOR, BridgeLib.hashMessage(hash));
        if (signature.length != 65) return 0xffffffff;
        try this.recoverSigner(d, signature) returns (address signer) {
            return signer == OWNER ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
        } catch {
            return 0xffffffff;
        }
    }

    /// Exposed for isValidSignature's try/catch and for off-chain digest parity checks.
    function recoverSigner(bytes32 hash, bytes calldata signature) external pure returns (address) {
        return BridgeLib.recover(hash, signature);
    }

    /// The Mode A digest the wallet signs, for parity checks against viem's hashTypedData.
    function frameTxDigest(BridgeLib.FrameTx calldata t) external view returns (bytes32) {
        return BridgeLib.digest(DOMAIN_SEPARATOR, BridgeLib.hashFrameTx(t));
    }

    /// The Mode B digest the wallet signs.
    function sessionDigest(BridgeLib.Session calldata s) external view returns (bytes32) {
        return BridgeLib.digest(DOMAIN_SEPARATOR, BridgeLib.hashSession(s));
    }
}
