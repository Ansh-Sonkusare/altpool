// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {ExitRelayChecks, IPool, IVerifier} from "./ExitRelayChecks.sol";
import {IWETH9, Settler, Terms} from "./Settler.sol";
import {SettlerFactory} from "./SettlerFactory.sol";
import {InvoiceBook} from "./InvoiceBook.sol";

/// PayRelayWETH's VERIFY checks over already-read values, so forge can test them without frame opcodes.
/// Layout (src/pay.ts): 0 VERIFY expiry, 1 VERIFY this, 2 SENDER pool.withdraw (outside the batch), 3 DEFAULT
/// factory.deploy(terms), 4 SENDER settler.unwrap, 5 SENDER settler.swap, 6 SENDER book.settle(id, settler),
/// 7 SENDER settler.sweep, 8 DEFAULT settler.assertSettled; 3..7 atomic, 8 closes the batch.
library PayChecks {
    struct Frame {
        address target;
        uint256 mode;
        uint256 flags;
        uint256 value;
        uint256 gas;
        uint256 stateGas;
    }

    struct PayView {
        uint256 frameCount;
        Frame[9] frames;
        bytes4 deploySelector;
        uint256 deployLength;
        bytes terms;
        /// Calldata of frames 4..8.
        bytes[5] calls;
        uint256 maxCost;
        uint256 nonceKeyCount;
        uint256 nonceKey0;
        uint256 nonceSeq;
        uint256 sigCount;
    }

    struct Config {
        address self;
        address pool;
        uint256 fee;
        address factory;
        address book;
        bytes32 settlerCodeHash;
    }

    uint256 internal constant FRAME_COUNT = 9;
    uint256 internal constant MODE_DEFAULT = 0;
    uint256 internal constant ATOMIC = 0x4;
    /// Simulated 550,095 (3-frame VERIFY 374.5k + ~175k of frame-opcode reads for the 9-frame pins); fixed work, no
    /// input-dependent loops.
    uint256 internal constant PAY_VERIFY_GAS_MAX = 600_000;
    /// The nonce key is consumed at APPROVE even if a later frame fails; a few retries per note stay possible.
    uint256 internal constant MAX_NONCE_SEQ = 2;
    uint256 internal constant TERMS_LENGTH = 160;
    /// Frames 4..8 carry a 4-byte selector, settle 68 bytes; VERIFY copies no more than this.
    uint256 internal constant MAX_CALL_LENGTH = 68;

    error BadBatchFrame(uint256 index);
    error BadTerms();
    error BadSettler();

    /// Execution and state gas floors of frames 3..8, equal to src/pay.ts's limits: a rewrapper may raise them (bounded
    /// by maxCost <= fee) but cannot starve the batch into a revert that parks the funds.
    function floors() internal pure returns (uint256[6] memory gas, uint256[6] memory state) {
        gas = [uint256(400_000), 100_000, 400_000, 150_000, 300_000, 100_000];
        state = [uint256(11_000_000), 100_000, 400_000, 300_000, 200_000, 0];
    }

    function check(PayView memory t, ExitRelayChecks.Withdraw memory w, uint256 rootIdx, Config memory c)
        internal
        pure
        returns (address settler, Terms memory terms)
    {
        if (t.frameCount != FRAME_COUNT) revert ExitRelayChecks.BadFrameCount();
        Frame memory f = t.frames[0];
        if (
            f.target != ExitRelayChecks.EXPIRY_VERIFIER || f.mode != ExitRelayChecks.MODE_VERIFY
                || f.gas > ExitRelayChecks.EXPIRY_GAS_MAX
        ) revert ExitRelayChecks.BadExpiryFrame();
        f = t.frames[1];
        if (f.target != c.self || f.mode != ExitRelayChecks.MODE_VERIFY || f.gas > PAY_VERIFY_GAS_MAX) {
            revert ExitRelayChecks.BadVerifyFrame();
        }
        f = t.frames[2];
        if (
            f.target != c.pool || f.mode != ExitRelayChecks.MODE_SENDER || f.flags != 0 || f.value != 0
                || f.gas < ExitRelayChecks.WITHDRAW_GAS_MIN || f.gas > ExitRelayChecks.WITHDRAW_GAS_MAX
                || f.stateGas > ExitRelayChecks.WITHDRAW_STATE_GAS_MAX
        ) revert ExitRelayChecks.BadWithdrawFrame();
        if (t.maxCost > c.fee) revert ExitRelayChecks.CostTooHigh();

        if (t.deploySelector != SettlerFactory.deploy.selector || t.deployLength != 4 + TERMS_LENGTH) revert BadTerms();
        terms = abi.decode(t.terms, (Terms));
        if (terms.book != c.book) revert BadTerms();
        settler = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), c.factory, keccak256(t.terms), c.settlerCodeHash))))
        );
        if (w.recipient != settler) revert BadSettler();

        bytes[5] memory want = [
            abi.encodeCall(Settler.unwrap, ()),
            abi.encodeCall(Settler.swap, ()),
            abi.encodeCall(InvoiceBook.settle, (terms.invoiceId, settler)),
            abi.encodeCall(Settler.sweep, ()),
            abi.encodeCall(Settler.assertSettled, ())
        ];
        (uint256[6] memory gas, uint256[6] memory state) = floors();
        for (uint256 i = 3; i < FRAME_COUNT; i++) {
            f = t.frames[i];
            address target = i == 3 ? c.factory : i == 6 ? c.book : settler;
            uint256 mode = i == 3 || i == 8 ? MODE_DEFAULT : ExitRelayChecks.MODE_SENDER;
            if (
                f.target != target || f.mode != mode || f.flags != (i == 8 ? 0 : ATOMIC) || f.value != 0
                    || f.gas < gas[i - 3] || f.stateGas < state[i - 3]
                    || (i > 3 && keccak256(t.calls[i - 4]) != keccak256(want[i - 4]))
            ) revert BadBatchFrame(i);
        }

        if (w.selector != ExitRelayChecks.WITHDRAW_SELECTOR) revert ExitRelayChecks.BadSelector();
        if (w.relayer != c.self) revert ExitRelayChecks.BadRelayer();
        if (w.fee != c.fee) revert ExitRelayChecks.BadFee();
        if (w.refund != 0) revert ExitRelayChecks.BadRefund();
        if (w.proofLength != ExitRelayChecks.PROOF_LENGTH) revert ExitRelayChecks.BadProofLength();
        if (t.nonceKeyCount != 1 || t.nonceKey0 != uint256(w.nullifierHash) || t.nonceSeq > MAX_NONCE_SEQ) {
            revert ExitRelayChecks.BadNonce();
        }
        if (t.sigCount > 1) revert ExitRelayChecks.TooManySignatures();
        if (w.root == 0 || rootIdx >= ExitRelayChecks.ROOT_HISTORY) revert ExitRelayChecks.BadRoot();
    }
}

/// Sends a WETH-pool withdrawal to a proof-bound Settler and runs the Settler's payment plan in the same frame
/// transaction, as sender and payer, repaid from the withdrawal's WETH fee (spec: research repo derisk/notes/r16).
contract PayRelayWETH is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable pool;
    address public immutable verifier;
    uint256 public immutable fee;
    address public immutable token;
    address public immutable factory;
    address public immutable book;
    bytes32 public immutable settlerCodeHash;

    error NothingToUnwrap();

    constructor(address pool_, address verifier_, uint256 fee_, address token_, address factory_, address book_)
        payable
    {
        (pool, verifier, fee, token, factory, book) = (pool_, verifier_, fee_, token_, factory_, book_);
        settlerCodeHash = SettlerFactory(factory_).settlerCodeHash();
    }

    /// Empty: WETH9.withdraw in unwrapFees pays with transfer() (2300 gas).
    receive() external payable {}

    /// The registry keys stakes on msg.sender, so the relay stakes itself. No unlock path.
    function stake(address registry, uint32 delay) external payable {
        (bool ok,) = registry.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", delay));
        require(ok, "addStake failed");
    }

    /// Permissionless: moves value only from this contract's WETH fees to its ETH gas float.
    function unwrapFees() external returns (uint256 amount) {
        amount = IWETH9(token).balanceOf(address(this));
        if (amount == 0) revert NothingToUnwrap();
        IWETH9(token).withdraw(amount);
    }

    fallback() external {
        PayChecks.PayView memory t;
        t.frameCount = txparam(TxParam.FRAME_COUNT);
        if (t.frameCount != PayChecks.FRAME_COUNT) revert ExitRelayChecks.BadFrameCount();
        for (uint256 i = 0; i < PayChecks.FRAME_COUNT; i++) {
            t.frames[i] = _frame(i, i >= 2);
        }
        t.deploySelector = bytes4(framedataload(0, 3));
        t.deployLength = frameparam(3, FrameParam.DATA_LENGTH);
        t.terms = framedatacopy(4, PayChecks.TERMS_LENGTH, 3);
        for (uint256 i = 4; i < PayChecks.FRAME_COUNT; i++) {
            uint256 len = frameparam(i, FrameParam.DATA_LENGTH);
            if (len > PayChecks.MAX_CALL_LENGTH) revert PayChecks.BadBatchFrame(i);
            t.calls[i - 4] = framedatacopy(0, len, i);
        }
        t.maxCost = txparam(TxParam.MAX_COST);
        t.nonceKeyCount = txparam(TxParam.NONCE_KEY_COUNT);
        t.nonceKey0 = txparam(TxParam.NONCE_KEY_0);
        t.nonceSeq = txparam(TxParam.NONCE);
        t.sigCount = txparam(TxParam.SIGNATURE_COUNT);

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
        PayChecks.check(
            t, w, rootIdx, PayChecks.Config(address(this), pool, fee, factory, book, settlerCodeHash)
        );
        bytes memory proof = framedatacopy(4 + proofOffset + 32, w.proofLength, 2);
        ExitRelayChecks.checkState(IPool(pool), IVerifier(verifier), w, rootIdx, proof);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// Frames 0 and 1 are VERIFY: only target, mode and gas matter there, so the other reads are skipped.
    function _frame(uint256 i, bool full) private view returns (PayChecks.Frame memory f) {
        f.target = address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET)));
        f.mode = frameparam(i, FrameParam.MODE);
        f.gas = frameparam(i, FrameParam.EXECUTION_GAS_LIMIT);
        if (full) {
            f.flags = frameparam(i, FrameParam.FLAGS);
            f.value = frameparam(i, FrameParam.VALUE);
            f.stateGas = frameparam(i, FrameParam.STATE_GAS_LIMIT);
        }
    }
}
