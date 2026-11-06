// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {ExitRelayChecks, IPool, IVerifier} from "./ExitRelayChecks.sol";

/// Sends QuietSend withdrawals as EIP-8141 frame transactions and is repaid from the fee. Native mode only.
/// Frames: 0 VERIFY expiry (0x8141), 1 VERIFY this contract with data abi.encode(rootIdx), 2 SENDER pool.withdraw.
/// Spec: research repo docs/03.
contract ExitRelay is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable pool;
    address public immutable verifier;
    uint256 public immutable fee;

    constructor(address pool_, address verifier_, uint256 fee_) payable {
        pool = pool_;
        verifier = verifier_;
        fee = fee_;
    }

    /// Empty: the pool pays the fee here after APPROVE, so a revert would fail the withdraw.
    receive() external payable {}

    /// The registry keys stakes on msg.sender, so the relay stakes itself. No unlock path.
    function stake(address registry, uint32 delay) external payable {
        (bool ok,) = registry.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", delay));
        require(ok, "addStake failed");
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
        uint256 rootIdx = uint256(framedataload(0, 1));
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
        ExitRelayChecks.checkStatic(t, w, rootIdx, address(this), pool, fee, _refund());
        bytes memory proof = framedatacopy(4 + proofOffset + 32, w.proofLength, 2);
        ExitRelayChecks.checkState(IPool(pool), IVerifier(verifier), w, rootIdx, proof);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// ETH the SENDER frame forwards to the recipient through the pool's `refund`; 0 for ETH pools.
    function _refund() internal view virtual returns (uint256) {
        return 0;
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
}
