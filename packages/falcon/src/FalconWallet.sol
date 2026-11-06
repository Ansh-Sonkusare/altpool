// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FalconSig} from "./FalconSig.sol";

/// A frame-transaction account whose only authority is a Falcon-512 signature (post-quantum), verified on-chain by the
/// shared ZKNOX verifier inside the VERIFY frame. EIP-8141 has no native Falcon scheme, so the signature rides in an
/// ARBITRARY entry and this contract is the scheme.
///
/// Frames: 0 VERIFY (target = this wallet, data = one byte), 1 SENDER (target = this wallet, data = execute(...)).
/// VERIFY is ~3.6M gas, so these transactions only fit the alt mempool; ethrex's public mempool caps VERIFY at 100k.
contract FalconWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable verifier;
    /// keccak256 of the NTT-domain public key as 32 big-endian words (see FalconSig).
    bytes32 public immutable pkHash;

    error BadSignatureEntry();
    error BadFalconSignature();
    error OnlySelf();
    error CallFailed(bytes returndata);

    constructor(address verifier_, bytes32 pkHash_) payable {
        verifier = verifier_;
        pkHash = pkHash_;
    }

    /// Takes ETH (a QuietSend withdrawal lands here). VERIFY data must be non-empty or it routes here and never approves.
    receive() external payable {}

    fallback() external {
        if (txparam(TxParam.SIGNATURE_COUNT) != 1) revert BadSignatureEntry();
        // Scheme 0 = ARBITRARY; MSG 0 = the entry signs the canonical sig hash, not an attacker-chosen message.
        if (sigparam(0, SigParam.SCHEME) != 0 || sigparam(0, SigParam.MSG) != 0) revert BadSignatureEntry();
        if (sigparam(0, SigParam.SIGNATURE_LENGTH) != FalconSig.SIG_LEN) revert BadSignatureEntry();
        bytes32 digest = bytes32(txparam(TxParam.SIG_HASH));
        if (!FalconSig.check(verifier, pkHash, digest, sigdatacopy(0, FalconSig.SIG_LEN, 0))) revert BadFalconSignature();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Spend. Reachable only from a SENDER frame whose target is this wallet (caller = tx.sender = this wallet).
    function execute(address to, uint256 value, bytes calldata data) external returns (bytes memory ret) {
        if (msg.sender != address(this)) revert OnlySelf();
        bool ok;
        (ok, ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
    }
}
