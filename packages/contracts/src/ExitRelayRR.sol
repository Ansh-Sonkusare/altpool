// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {HelperCalls} from "@forshtat/hegota-support/contracts/internal/HelperCalls.sol";
import {ExitRelayChecks, IRootPool, IVerifier} from "./ExitRelayChecks.sol";

/// ExitRelay whose VERIFY reads the root from an EIP-8272 recent-root reference (0xB6) instead of pool storage and
/// skips isSpent, so it touches no foreign storage (FOCIL-eligible). Spec: derisk/notes/r13-recent-roots.md §5.
/// Frames: 0 VERIFY expiry (0x8141), 1 VERIFY this contract with empty data, 2 SENDER pool.withdraw; the tx carries
/// one recent-root reference { rootSource, publish slot, root }.
contract ExitRelayRR is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable pool;
    address public immutable verifier;
    uint256 public immutable fee;
    /// This contract's EIP-8272 namespace: keccak256(address(this) ‖ salt 0).
    bytes32 public immutable rootSource;
    /// 12-byte RECENTROOTREFLOAD reader: (index, field) in, the reference word out. hegota-support has no 0xB6 wrapper.
    address public immutable rootRefHelper;

    address private constant RECENT_ROOTS = address(0x8272);

    event RootPublished(bytes32 indexed root);

    constructor(address pool_, address verifier_, uint256 fee_) payable {
        pool = pool_;
        verifier = verifier_;
        fee = fee_;
        rootSource = keccak256(abi.encodePacked(address(this), bytes32(0)));
        // PUSH12 5f35602035b65f5260205ff3, PUSH0, MSTORE, RETURN(20, 12). Runtime: PUSH0 CALLDATALOAD (index),
        // PUSH1 0x20 CALLDATALOAD (field), RECENTROOTREFLOAD, PUSH0 MSTORE, RETURN(0, 32).
        bytes memory init = hex"6b5f35602035b65f5260205ff35f52600c6014f3";
        address h;
        assembly ("memory-safe") {
            h := create(0, add(init, 0x20), mload(init))
        }
        require(h != address(0), "0xB6 helper deploy failed");
        rootRefHelper = h;
    }

    /// Empty: the pool pays the fee here after APPROVE, so a revert would fail the withdraw.
    receive() external payable {}

    /// The registry keys stakes on msg.sender, so the relay stakes itself. No unlock path.
    function stake(address registry, uint32 delay) external payable {
        (bool ok,) = registry.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", delay));
        require(ok, "addStake failed");
    }

    /// Permissionless: only ever copies the pool's real current root into this contract's 8272 namespace.
    function publishRoot() external {
        bytes32 r = IRootPool(pool).getLastRoot();
        (bool ok,) = RECENT_ROOTS.call(abi.encodePacked(bytes32(0), r));
        require(ok, "8272 write failed");
        emit RootPublished(r);
    }

    fallback() external {
        ExitRelayChecks.TxView memory t = ExitRelayChecks.TxView({
            frameCount: txparam(TxParam.FRAME_COUNT),
            expiry: _frame(0, false),
            verify: _frame(1, false),
            withdraw: _frame(2, true),
            maxCost: txparam(TxParam.MAX_COST),
            nonceKeyCount: txparam(TxParam.NONCE_KEY_COUNT),
            nonceKey0: txparam(TxParam.NONCE_KEY_0),
            nonceSeq: txparam(TxParam.NONCE),
            sigCount: txparam(TxParam.SIGNATURE_COUNT)
        });
        uint256 proofOffset = uint256(framedataload(4, 2));
        ExitRelayChecks.Withdraw memory w = ExitRelayChecks.Withdraw({
            selector: bytes4(framedataload(0, 2)),
            root: framedataload(36, 2),
            nullifierHash: framedataload(68, 2),
            recipient: address(uint160(uint256(framedataload(100, 2)))),
            relayer: address(uint160(uint256(framedataload(132, 2)))),
            fee: uint256(framedataload(164, 2)),
            refund: uint256(framedataload(196, 2)),
            proofLength: uint256(framedataload(4 + proofOffset, 2))
        });
        ExitRelayChecks.checkStaticRR(t, w, address(this), pool, fee);
        // A missing reference 0 halts 0xB6, which invalidates the tx; the slot window is enforced by consensus.
        ExitRelayChecks.checkRootRef(_rootRef(0, 0), _rootRef(0, 2), rootSource, w.root);
        bytes memory proof = framedatacopy(4 + proofOffset + 32, w.proofLength, 2);
        ExitRelayChecks.checkProof(IVerifier(verifier), w, proof);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Value and state gas are only checked on the withdraw frame; skipping them elsewhere saves helper calls.
    function _frame(uint256 i, bool full) private view returns (ExitRelayChecks.Frame memory f) {
        f.target = address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET)));
        f.mode = frameparam(i, FrameParam.MODE);
        f.gas = frameparam(i, FrameParam.EXECUTION_GAS_LIMIT);
        if (full) {
            f.value = frameparam(i, FrameParam.VALUE);
            f.stateGas = frameparam(i, FrameParam.STATE_GAS_LIMIT);
        }
    }

    /// RECENTROOTREFLOAD(index, field): field 0 source_id, 1 slot, 2 root.
    function _rootRef(uint256 index, uint256 field) private view returns (bytes32) {
        return bytes32(HelperCalls.readWord(rootRefHelper, abi.encode(index, field)));
    }
}
