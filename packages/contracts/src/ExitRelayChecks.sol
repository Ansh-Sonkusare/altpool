// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPool {
    function roots(uint256) external view returns (bytes32);
    function isSpent(bytes32) external view returns (bool);
}

interface IVerifier {
    function verifyProof(bytes calldata proof, uint256[6] calldata input) external view returns (bool);
}

/// ExitRelay's VERIFY checks over already-read values, so forge can test them without frame opcodes (docs/03).
library ExitRelayChecks {
    struct Frame {
        address target;
        uint256 mode;
        uint256 value;
        uint256 gas;
        uint256 stateGas;
    }

    struct TxView {
        uint256 frameCount;
        Frame expiry;
        Frame verify;
        Frame withdraw;
        uint256 maxCost;
        uint256 nonceKeyCount;
        uint256 nonceKey0;
        uint256 nonceSeq;
        uint256 sigCount;
    }

    struct Withdraw {
        bytes4 selector;
        bytes32 root;
        bytes32 nullifierHash;
        address recipient;
        address relayer;
        uint256 fee;
        uint256 refund;
        uint256 proofLength;
    }

    address internal constant EXPIRY_VERIFIER = address(0x8141);
    uint256 internal constant MODE_VERIFY = 1;
    uint256 internal constant MODE_SENDER = 2;
    uint256 internal constant EXPIRY_GAS_MAX = 10_000;
    uint256 internal constant VERIFY_GAS_MAX = 350_000;
    uint256 internal constant WITHDRAW_GAS_MIN = 700_000;
    uint256 internal constant WITHDRAW_GAS_MAX = 1_000_000;
    uint256 internal constant WITHDRAW_STATE_GAS_MAX = 250_000;
    uint256 internal constant ROOT_HISTORY = 100;
    uint256 internal constant PROOF_LENGTH = 256;
    bytes4 internal constant WITHDRAW_SELECTOR = 0x21a0adb6;

    error BadFrameCount();
    error BadExpiryFrame();
    error BadVerifyFrame();
    error BadWithdrawFrame();
    error CostTooHigh();
    error BadSelector();
    error BadRelayer();
    error BadFee();
    error BadRefund();
    error BadProofLength();
    error BadNonce();
    error TooManySignatures();
    error BadRoot();
    error UnknownRoot();
    error NullifierSpent();
    error BadProof();

    function checkStatic(TxView memory t, Withdraw memory w, uint256 rootIdx, address self, address pool, uint256 fee)
        internal
        pure
    {
        if (t.frameCount != 3) revert BadFrameCount();
        if (t.expiry.target != EXPIRY_VERIFIER || t.expiry.mode != MODE_VERIFY || t.expiry.gas > EXPIRY_GAS_MAX) {
            revert BadExpiryFrame();
        }
        if (t.verify.target != self || t.verify.mode != MODE_VERIFY || t.verify.gas > VERIFY_GAS_MAX) {
            revert BadVerifyFrame();
        }
        Frame memory f = t.withdraw;
        if (
            f.target != pool || f.mode != MODE_SENDER || f.value != 0 || f.gas < WITHDRAW_GAS_MIN
                || f.gas > WITHDRAW_GAS_MAX || f.stateGas > WITHDRAW_STATE_GAS_MAX
        ) revert BadWithdrawFrame();
        if (t.maxCost > fee) revert CostTooHigh();
        if (w.selector != WITHDRAW_SELECTOR) revert BadSelector();
        if (w.relayer != self) revert BadRelayer();
        if (w.fee != fee) revert BadFee();
        if (w.refund != 0) revert BadRefund();
        if (w.proofLength != PROOF_LENGTH) revert BadProofLength();
        if (t.nonceKeyCount != 1 || t.nonceKey0 != uint256(w.nullifierHash) || t.nonceSeq != 0) revert BadNonce();
        // One signature is allowed for a gateway that insists on a placeholder; ExitRelay never reads it and
        // CostTooHigh bounds what it can cost.
        if (t.sigCount > 1) revert TooManySignatures();
        if (w.root == 0 || rootIdx >= ROOT_HISTORY) revert BadRoot();
    }

    /// Pool reads by index only: `isKnownRoot`, `currentRootIndex` and `nextIndex` change on every deposit and
    /// would force every pending send to re-validate. The pairing runs last so bad sends fail cheaply.
    function checkState(IPool pool, IVerifier verifier, Withdraw memory w, uint256 rootIdx, bytes memory proof)
        internal
        view
    {
        if (pool.roots(rootIdx) != w.root) revert UnknownRoot();
        if (pool.isSpent(w.nullifierHash)) revert NullifierSpent();
        uint256[6] memory input = [
            uint256(w.root),
            uint256(w.nullifierHash),
            uint256(uint160(w.recipient)),
            uint256(uint160(w.relayer)),
            w.fee,
            0
        ];
        // The v2.0 verifier reverts on some malformed proofs; any failure is BadProof.
        try verifier.verifyProof(proof, input) returns (bool ok) {
            if (!ok) revert BadProof();
        } catch {
            revert BadProof();
        }
    }
}
