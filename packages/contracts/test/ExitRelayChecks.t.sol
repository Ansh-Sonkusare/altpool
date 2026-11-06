// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitRelayChecks, IPool, IVerifier} from "../src/ExitRelayChecks.sol";

contract Harness {
    function checkStatic(
        ExitRelayChecks.TxView memory t,
        ExitRelayChecks.Withdraw memory w,
        uint256 rootIdx,
        address self,
        address pool,
        uint256 fee
    ) external pure {
        ExitRelayChecks.checkStatic(t, w, rootIdx, self, pool, fee);
    }

    function checkState(IPool pool, IVerifier verifier, ExitRelayChecks.Withdraw memory w, uint256 rootIdx, bytes memory proof)
        external
        view
    {
        ExitRelayChecks.checkState(pool, verifier, w, rootIdx, proof);
    }
}

contract MockPool is IPool {
    mapping(uint256 => bytes32) public roots;
    mapping(bytes32 => bool) public isSpent;

    function setRoot(uint256 i, bytes32 r) external {
        roots[i] = r;
    }

    function setSpent(bytes32 nh) external {
        isSpent[nh] = true;
    }
}

contract MockVerifier is IVerifier {
    bool public result = true;
    bool public reverts;

    function set(bool result_, bool reverts_) external {
        result = result_;
        reverts = reverts_;
    }

    function verifyProof(bytes calldata, uint256[6] calldata) external view returns (bool) {
        require(!reverts, "verifier-gte-snark-scalar-field");
        return result;
    }
}

/// Accepts only the exact public inputs it was told to expect, so the input ordering is pinned.
contract InputPinningVerifier is IVerifier {
    bytes32 public immutable want;

    constructor(uint256[6] memory input) {
        want = keccak256(abi.encode(input));
    }

    function verifyProof(bytes calldata proof, uint256[6] calldata input) external view returns (bool) {
        return proof.length == 256 && keccak256(abi.encode(input)) == want;
    }
}

contract ExitRelayChecksTest is Test {
    Harness h = new Harness();
    MockPool pool = new MockPool();
    MockVerifier verifier = new MockVerifier();

    address constant SELF = address(0xE11);
    uint256 constant FEE = 1e16;
    uint256 constant ROOT_IDX = 7;
    bytes32 constant ROOT = bytes32(uint256(0xabc));
    bytes32 constant NH = bytes32(uint256(0xdef));
    address constant RECIPIENT = address(0xBEEF);

    function frame(address target, uint256 mode, uint256 gas) internal pure returns (ExitRelayChecks.Frame memory) {
        return ExitRelayChecks.Frame({target: target, mode: mode, value: 0, gas: gas, stateGas: 0});
    }

    function baseTx() internal view returns (ExitRelayChecks.TxView memory t) {
        t.frameCount = 3;
        t.expiry = frame(address(0x8141), 1, 10_000);
        t.verify = frame(SELF, 1, 450_000);
        t.withdraw = frame(address(pool), 2, 1_000_000);
        t.withdraw.stateGas = 300_000;
        t.maxCost = FEE;
        t.nonceKeyCount = 1;
        t.nonceKey0 = uint256(NH);
        t.nonceSeq = 0;
        t.sigCount = 0;
    }

    function baseWithdraw() internal pure returns (ExitRelayChecks.Withdraw memory) {
        return ExitRelayChecks.Withdraw({
            selector: 0x21a0adb6,
            root: ROOT,
            nullifierHash: NH,
            recipient: RECIPIENT,
            relayer: SELF,
            fee: FEE,
            refund: 0,
            proofLength: 256
        });
    }

    function checkStatic(ExitRelayChecks.TxView memory t, ExitRelayChecks.Withdraw memory w, uint256 rootIdx)
        internal
        view
    {
        h.checkStatic(t, w, rootIdx, SELF, address(pool), FEE);
    }

    function expectStatic(bytes4 err, ExitRelayChecks.TxView memory t, ExitRelayChecks.Withdraw memory w) internal {
        vm.expectRevert(err);
        checkStatic(t, w, ROOT_IDX);
    }

    function test_static_baselinePasses() public view {
        checkStatic(baseTx(), baseWithdraw(), ROOT_IDX);
        ExitRelayChecks.TxView memory t = baseTx();
        t.withdraw.gas = 700_000;
        t.sigCount = 1;
        checkStatic(t, baseWithdraw(), 99);
    }

    function test_BadFrameCount() public {
        ExitRelayChecks.TxView memory t = baseTx();
        t.frameCount = 4;
        expectStatic(ExitRelayChecks.BadFrameCount.selector, t, baseWithdraw());
    }

    function test_BadExpiryFrame() public {
        bytes4 e = ExitRelayChecks.BadExpiryFrame.selector;
        ExitRelayChecks.TxView memory t = baseTx();
        t.expiry.target = address(0x8142);
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.expiry.mode = 2;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.expiry.gas = 10_001;
        expectStatic(e, t, baseWithdraw());
    }

    function test_BadVerifyFrame() public {
        bytes4 e = ExitRelayChecks.BadVerifyFrame.selector;
        ExitRelayChecks.TxView memory t = baseTx();
        t.verify.target = address(0xBAD);
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.verify.mode = 2;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.verify.gas = 450_001;
        expectStatic(e, t, baseWithdraw());
    }

    function test_BadWithdrawFrame() public {
        bytes4 e = ExitRelayChecks.BadWithdrawFrame.selector;
        ExitRelayChecks.TxView memory t = baseTx();
        t.withdraw.target = address(0xBAD);
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.withdraw.mode = 1;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.withdraw.value = 1;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.withdraw.gas = 699_999;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.withdraw.gas = 1_000_001;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.withdraw.stateGas = 300_001;
        expectStatic(e, t, baseWithdraw());
    }

    function test_CostTooHigh() public {
        ExitRelayChecks.TxView memory t = baseTx();
        t.maxCost = FEE + 1;
        expectStatic(ExitRelayChecks.CostTooHigh.selector, t, baseWithdraw());
    }

    function test_BadSelector() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.selector = 0xb214faa5;
        expectStatic(ExitRelayChecks.BadSelector.selector, baseTx(), w);
    }

    function test_BadRelayer() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.relayer = address(0xdEaD);
        expectStatic(ExitRelayChecks.BadRelayer.selector, baseTx(), w);
    }

    function test_BadFee() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.fee = FEE - 1;
        expectStatic(ExitRelayChecks.BadFee.selector, baseTx(), w);
    }

    function test_BadRefund() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.refund = 1;
        expectStatic(ExitRelayChecks.BadRefund.selector, baseTx(), w);
    }

    function test_BadProofLength() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.proofLength = 255;
        expectStatic(ExitRelayChecks.BadProofLength.selector, baseTx(), w);
    }

    function test_BadNonce() public {
        bytes4 e = ExitRelayChecks.BadNonce.selector;
        ExitRelayChecks.TxView memory t = baseTx();
        t.nonceKeyCount = 2;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.nonceKey0 = uint256(NH) + 1;
        expectStatic(e, t, baseWithdraw());
        t = baseTx();
        t.nonceSeq = 1;
        expectStatic(e, t, baseWithdraw());
    }

    function test_TooManySignatures() public {
        ExitRelayChecks.TxView memory t = baseTx();
        t.sigCount = 2;
        expectStatic(ExitRelayChecks.TooManySignatures.selector, t, baseWithdraw());
    }

    function test_BadRoot() public {
        ExitRelayChecks.Withdraw memory w = baseWithdraw();
        w.root = 0;
        expectStatic(ExitRelayChecks.BadRoot.selector, baseTx(), w);
        vm.expectRevert(ExitRelayChecks.BadRoot.selector);
        checkStatic(baseTx(), baseWithdraw(), 100);
    }

    function test_state_happyPathPasses() public {
        pool.setRoot(ROOT_IDX, ROOT);
        h.checkState(pool, verifier, baseWithdraw(), ROOT_IDX, new bytes(256));
    }

    function test_state_publicInputsInVerifierOrder() public {
        pool.setRoot(ROOT_IDX, ROOT);
        uint256[6] memory input =
            [uint256(ROOT), uint256(NH), uint256(uint160(RECIPIENT)), uint256(uint160(SELF)), FEE, 0];
        h.checkState(pool, new InputPinningVerifier(input), baseWithdraw(), ROOT_IDX, new bytes(256));
    }

    function test_UnknownRoot() public {
        pool.setRoot(ROOT_IDX + 1, ROOT);
        vm.expectRevert(ExitRelayChecks.UnknownRoot.selector);
        h.checkState(pool, verifier, baseWithdraw(), ROOT_IDX, new bytes(256));
    }

    function test_NullifierSpent() public {
        pool.setRoot(ROOT_IDX, ROOT);
        pool.setSpent(NH);
        vm.expectRevert(ExitRelayChecks.NullifierSpent.selector);
        h.checkState(pool, verifier, baseWithdraw(), ROOT_IDX, new bytes(256));
    }

    function test_BadProof_false() public {
        pool.setRoot(ROOT_IDX, ROOT);
        verifier.set(false, false);
        vm.expectRevert(ExitRelayChecks.BadProof.selector);
        h.checkState(pool, verifier, baseWithdraw(), ROOT_IDX, new bytes(256));
    }

    function test_VerifierReverted() public {
        pool.setRoot(ROOT_IDX, ROOT);
        verifier.set(true, true);
        vm.expectRevert(ExitRelayChecks.VerifierReverted.selector);
        h.checkState(pool, verifier, baseWithdraw(), ROOT_IDX, new bytes(256));
    }
}
