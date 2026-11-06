// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitRelayChecks, IRootPool, IVerifier} from "../src/ExitRelayChecks.sol";
import {ExitRelayRR} from "../src/ExitRelayRR.sol";
import {MockVerifier, InputPinningVerifier} from "./ExitRelayChecks.t.sol";

contract HarnessRR {
    function checkStaticRR(
        ExitRelayChecks.TxView memory t,
        ExitRelayChecks.Withdraw memory w,
        address self,
        address pool,
        uint256 fee
    ) external pure {
        ExitRelayChecks.checkStaticRR(t, w, self, pool, fee);
    }

    function checkRootRef(bytes32 refSource, bytes32 refRoot, bytes32 rootSource, bytes32 root) external pure {
        ExitRelayChecks.checkRootRef(refSource, refRoot, rootSource, root);
    }

    function checkProof(IVerifier verifier, ExitRelayChecks.Withdraw memory w, bytes memory proof) external view {
        ExitRelayChecks.checkProof(verifier, w, proof);
    }
}

contract RootPool is IRootPool {
    bytes32 public getLastRoot;

    function set(bytes32 r) external {
        getLastRoot = r;
    }
}

/// Etched at 0x8272: records the last write so publishRoot's calldata and caller can be checked.
contract RecentRootsRecorder {
    address public writer;
    bytes public written;

    fallback() external {
        writer = msg.sender;
        written = msg.data;
    }
}

contract Reverter {
    fallback() external {
        revert();
    }
}

contract ExitRelayRRTest is Test {
    HarnessRR h = new HarnessRR();
    MockVerifier verifier = new MockVerifier();
    RootPool pool = new RootPool();

    address constant SELF = address(0xE11);
    uint256 constant FEE = 1e16;
    bytes32 constant ROOT = bytes32(uint256(0xabc));
    bytes32 constant NH = bytes32(uint256(0xdef));
    bytes32 constant SOURCE = keccak256("source");
    address constant RECIPIENT = address(0xBEEF);
    uint256 constant CASES = 24;

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

    /// The baseline with malformed shape `i` applied, and the error ExitRelay's checkStatic gives for it.
    function malformed(uint256 i)
        internal
        view
        returns (ExitRelayChecks.TxView memory t, ExitRelayChecks.Withdraw memory w, bytes4 err)
    {
        t = baseTx();
        w = baseWithdraw();
        if (i == 0) (t.frameCount, err) = (4, ExitRelayChecks.BadFrameCount.selector);
        else if (i == 1) (t.expiry.target, err) = (address(0x8142), ExitRelayChecks.BadExpiryFrame.selector);
        else if (i == 2) (t.expiry.mode, err) = (2, ExitRelayChecks.BadExpiryFrame.selector);
        else if (i == 3) (t.expiry.gas, err) = (10_001, ExitRelayChecks.BadExpiryFrame.selector);
        else if (i == 4) (t.verify.target, err) = (address(0xBAD), ExitRelayChecks.BadVerifyFrame.selector);
        else if (i == 5) (t.verify.mode, err) = (2, ExitRelayChecks.BadVerifyFrame.selector);
        else if (i == 6) (t.verify.gas, err) = (450_001, ExitRelayChecks.BadVerifyFrame.selector);
        else if (i == 7) (t.withdraw.target, err) = (address(0xBAD), ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 8) (t.withdraw.mode, err) = (1, ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 9) (t.withdraw.value, err) = (1, ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 10) (t.withdraw.gas, err) = (699_999, ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 11) (t.withdraw.gas, err) = (1_000_001, ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 12) (t.withdraw.stateGas, err) = (300_001, ExitRelayChecks.BadWithdrawFrame.selector);
        else if (i == 13) (t.maxCost, err) = (FEE + 1, ExitRelayChecks.CostTooHigh.selector);
        else if (i == 14) (w.selector, err) = (bytes4(0xb214faa5), ExitRelayChecks.BadSelector.selector);
        else if (i == 15) (w.relayer, err) = (address(0xdEaD), ExitRelayChecks.BadRelayer.selector);
        else if (i == 16) (w.fee, err) = (FEE - 1, ExitRelayChecks.BadFee.selector);
        else if (i == 17) (w.refund, err) = (1, ExitRelayChecks.BadRefund.selector);
        else if (i == 18) (w.proofLength, err) = (255, ExitRelayChecks.BadProofLength.selector);
        else if (i == 19) (t.nonceKeyCount, err) = (2, ExitRelayChecks.BadNonce.selector);
        else if (i == 20) (t.nonceKey0, err) = (uint256(NH) + 1, ExitRelayChecks.BadNonce.selector);
        else if (i == 21) (t.nonceSeq, err) = (1, ExitRelayChecks.BadNonce.selector);
        else if (i == 22) (t.sigCount, err) = (2, ExitRelayChecks.TooManySignatures.selector);
        else if (i == 23) (w.root, err) = (bytes32(0), ExitRelayChecks.BadRoot.selector);
    }

    function test_rr_static_baselinePasses() public view {
        h.checkStaticRR(baseTx(), baseWithdraw(), SELF, address(pool), FEE);
        ExitRelayChecks.TxView memory t = baseTx();
        t.withdraw.gas = 700_000;
        t.sigCount = 1;
        h.checkStaticRR(t, baseWithdraw(), SELF, address(pool), FEE);
    }

    function test_rr_static_rejectsEveryMalformedShape() public {
        for (uint256 i; i < CASES; i++) {
            (ExitRelayChecks.TxView memory t, ExitRelayChecks.Withdraw memory w, bytes4 err) = malformed(i);
            vm.expectRevert(err);
            h.checkStaticRR(t, w, SELF, address(pool), FEE);
        }
    }

    function test_rootRef_happyPathPasses() public view {
        h.checkRootRef(SOURCE, ROOT, SOURCE, ROOT);
    }

    function test_rootRef_BadRootSource() public {
        vm.expectRevert(ExitRelayChecks.BadRootSource.selector);
        h.checkRootRef(keccak256("other"), ROOT, SOURCE, ROOT);
        // The source is checked first: a foreign namespace never reaches the root comparison.
        vm.expectRevert(ExitRelayChecks.BadRootSource.selector);
        h.checkRootRef(keccak256("other"), bytes32(uint256(1)), SOURCE, ROOT);
    }

    function test_rootRef_UnknownRoot() public {
        vm.expectRevert(ExitRelayChecks.UnknownRoot.selector);
        h.checkRootRef(SOURCE, bytes32(uint256(ROOT) + 1), SOURCE, ROOT);
    }

    function test_proof_happyPathPasses() public view {
        h.checkProof(verifier, baseWithdraw(), new bytes(256));
    }

    function test_proof_publicInputsInVerifierOrder() public {
        uint256[6] memory input =
            [uint256(ROOT), uint256(NH), uint256(uint160(RECIPIENT)), uint256(uint160(SELF)), FEE, 0];
        h.checkProof(new InputPinningVerifier(input), baseWithdraw(), new bytes(256));
    }

    function test_proof_BadProof() public {
        verifier.set(false, false);
        vm.expectRevert(ExitRelayChecks.BadProof.selector);
        h.checkProof(verifier, baseWithdraw(), new bytes(256));
    }

    function test_proof_VerifierReverted() public {
        verifier.set(true, true);
        vm.expectRevert(ExitRelayChecks.VerifierReverted.selector);
        h.checkProof(verifier, baseWithdraw(), new bytes(256));
    }

    function test_relay_rootSourceAndHelper() public {
        ExitRelayRR relay = new ExitRelayRR(address(pool), address(verifier), FEE);
        assertEq(relay.rootSource(), keccak256(abi.encodePacked(address(relay), bytes32(0))));
        assertEq(keccak256(relay.rootRefHelper().code), keccak256(hex"5f35602035b65f5260205ff3"));
    }

    function test_relay_publishRootWritesSaltAndRoot() public {
        ExitRelayRR relay = new ExitRelayRR(address(pool), address(verifier), FEE);
        vm.etch(address(0x8272), address(new RecentRootsRecorder()).code);
        pool.set(ROOT);
        vm.expectEmit(true, false, false, false, address(relay));
        emit ExitRelayRR.RootPublished(ROOT);
        relay.publishRoot();
        RecentRootsRecorder rec = RecentRootsRecorder(address(0x8272));
        assertEq(rec.writer(), address(relay));
        assertEq(rec.written(), abi.encodePacked(bytes32(0), ROOT));
    }

    function test_relay_publishRootRequiresWrite() public {
        ExitRelayRR relay = new ExitRelayRR(address(pool), address(verifier), FEE);
        vm.etch(address(0x8272), address(new Reverter()).code);
        vm.expectRevert(bytes("8272 write failed"));
        relay.publishRoot();
    }
}
