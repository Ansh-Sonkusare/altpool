// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitRelayChecks} from "../src/ExitRelayChecks.sol";
import {PayChecks} from "../src/PayRelayWETH.sol";
import {Settler, Terms, PoolKey, SwapParams} from "../src/Settler.sol";
import {SettlerFactory} from "../src/SettlerFactory.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";

contract Harness {
    function check(
        PayChecks.PayView memory t,
        ExitRelayChecks.Withdraw memory w,
        uint256 rootIdx,
        PayChecks.Config memory c
    ) external pure returns (address settler, Terms memory terms) {
        return PayChecks.check(t, w, rootIdx, c);
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// WETH9's shape: withdraw pays with transfer() (2300 gas stipend).
contract MockWETH is MockERC20 {
    function withdraw(uint256 wad) external {
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata) external returns (bytes memory);
}

/// v4's flow at a fixed price: unlock calls back, swap returns the caller's deltas (negative = owed), settle takes ETH,
/// take pays the token, and unlock reverts unless the ETH owed was settled.
contract MockPoolManager {
    MockERC20 public immutable token;
    uint256 public immutable weiPerUnit;
    uint256 owed;

    constructor(MockERC20 token_, uint256 weiPerUnit_) {
        token = token_;
        weiPerUnit = weiPerUnit_;
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        r = IUnlockCallback(msg.sender).unlockCallback(data);
        require(owed == 0, "CurrencyNotSettled");
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        require(key.currency0 == address(0) && key.currency1 == address(token) && p.zeroForOne && p.amountSpecified > 0);
        uint256 out = uint256(p.amountSpecified);
        owed = out * weiPerUnit;
        return (int256(-int128(uint128(owed))) << 128) | int256(uint256(uint128(out)));
    }

    function settle() external payable returns (uint256) {
        owed -= msg.value;
        return msg.value;
    }

    function take(address, address to, uint256 amount) external {
        token.mint(to, amount);
    }
}

contract PayChecksTest is Test {
    Harness h = new Harness();
    address constant SELF = address(0xE11);
    address constant POOL = address(0x9001);
    address constant FACTORY = address(0xFAC);
    address constant BOOK = address(0xB00C);
    bytes32 constant CODE_HASH = keccak256("settler");
    uint256 constant FEE = 1e16;
    bytes32 constant NH = bytes32(uint256(0xdef));

    Terms terms = Terms(7, BOOK, 50e6, 0.025 ether, address(0xC4A9));

    function settlerOf(Terms memory t) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, keccak256(abi.encode(t)), CODE_HASH))))
        );
    }

    function config() internal pure returns (PayChecks.Config memory) {
        return PayChecks.Config(SELF, POOL, FEE, FACTORY, BOOK, CODE_HASH);
    }

    function good() internal view returns (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) {
        address settler = settlerOf(terms);
        (uint256[6] memory gas, uint256[6] memory state) = PayChecks.floors();
        t.frameCount = 9;
        t.frames[0] = PayChecks.Frame(address(0x8141), 1, 0, 0, 10_000, 0);
        t.frames[1] = PayChecks.Frame(SELF, 1, 0, 0, PayChecks.PAY_VERIFY_GAS_MAX, 0);
        t.frames[2] = PayChecks.Frame(POOL, 2, 0, 0, 1_000_000, 300_000);
        for (uint256 i = 3; i < 9; i++) {
            address target = i == 3 ? FACTORY : i == 6 ? BOOK : settler;
            uint256 mode = i == 3 || i == 8 ? 0 : 2;
            t.frames[i] = PayChecks.Frame(target, mode, i == 8 ? 0 : 4, 0, gas[i - 3], state[i - 3]);
        }
        t.deploySelector = SettlerFactory.deploy.selector;
        t.deployLength = 164;
        t.terms = abi.encode(terms);
        t.calls = [
            abi.encodeCall(Settler.unwrap, ()),
            abi.encodeCall(Settler.swap, ()),
            abi.encodeCall(InvoiceBook.settle, (terms.invoiceId, settler)),
            abi.encodeCall(Settler.sweep, ()),
            abi.encodeCall(Settler.assertSettled, ())
        ];
        t.maxCost = FEE;
        t.nonceKeyCount = 1;
        t.nonceKey0 = uint256(NH);
        w = ExitRelayChecks.Withdraw(
            ExitRelayChecks.WITHDRAW_SELECTOR, bytes32(uint256(0xabc)), NH, settler, SELF, FEE, 0, 256
        );
    }

    function expectFail(PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w, bytes memory err) internal {
        vm.expectRevert(err);
        h.check(t, w, 3, config());
    }

    function test_acceptsTheNineFrameLayout() public view {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        (address settler, Terms memory got) = h.check(t, w, 3, config());
        assertEq(settler, settlerOf(terms));
        assertEq(abi.encode(got), abi.encode(terms));
    }

    function test_retriesUpToMaxNonceSeq() public view {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.nonceSeq = PayChecks.MAX_NONCE_SEQ;
        h.check(t, w, 3, config());
    }

    function test_rejectsWrongFrameCount() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.frameCount = 8;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadFrameCount.selector));
    }

    function test_rejectsWithdrawInsideTheBatch() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.frames[2].flags = 4;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadWithdrawFrame.selector));
    }

    function test_rejectsWithdrawValue() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.frames[2].value = 1;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadWithdrawFrame.selector));
    }

    function test_rejectsRecipientOtherThanTheTermsSettler() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.terms = abi.encode(Terms(7, BOOK, 50e6, 0.025 ether, address(0xBAD)));
        expectFail(t, w, abi.encodeWithSelector(PayChecks.BadSettler.selector));
    }

    function test_rejectsTermsForAnotherBook() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.terms = abi.encode(Terms(7, address(0xB0B), 50e6, 0.025 ether, address(0xC4A9)));
        expectFail(t, w, abi.encodeWithSelector(PayChecks.BadTerms.selector));
    }

    function test_rejectsDeployDataWithTrailingBytes() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.deployLength = 165;
        expectFail(t, w, abi.encodeWithSelector(PayChecks.BadTerms.selector));
    }

    /// A SENDER frame runs as the relay: any free calldata could move the relay's WETH fees.
    function test_rejectsEveryUnpinnedBatchCall() public {
        for (uint256 i = 0; i < 5; i++) {
            (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
            t.calls[i] = abi.encodeWithSignature("transfer(address,uint256)", address(0xBAD), 1e16);
            expectFail(t, w, abi.encodeWithSelector(PayChecks.BadBatchFrame.selector, i + 4));
        }
    }

    function test_rejectsSettleOfAnotherInvoice() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.calls[2] = abi.encodeCall(InvoiceBook.settle, (8, settlerOf(terms)));
        expectFail(t, w, abi.encodeWithSelector(PayChecks.BadBatchFrame.selector, 6));
    }

    function test_rejectsBatchTargetModeFlagValueAndGasChanges() public {
        for (uint256 i = 3; i < 9; i++) {
            for (uint256 k = 0; k < 6; k++) {
                (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
                PayChecks.Frame memory f = t.frames[i];
                if (k == 0) f.target = address(0xBAD);
                if (k == 1) f.mode = f.mode == 0 ? 2 : 0;
                if (k == 2) f.flags = f.flags == 0 ? 4 : 0;
                if (k == 3) f.value = 1;
                if (k == 4) f.gas -= 1;
                if (k == 5) {
                    if (f.stateGas == 0) continue;
                    f.stateGas -= 1;
                }
                expectFail(t, w, abi.encodeWithSelector(PayChecks.BadBatchFrame.selector, i));
            }
        }
    }

    function test_rejectsCostAboveFee() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.maxCost = FEE + 1;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.CostTooHigh.selector));
    }

    function test_rejectsRefund() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        w.refund = 1;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadRefund.selector));
    }

    function test_rejectsOtherRelayer() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        w.relayer = address(0xBAD);
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadRelayer.selector));
    }

    function test_rejectsNonceKeyOtherThanNullifierOrSeqAboveMax() public {
        (PayChecks.PayView memory t, ExitRelayChecks.Withdraw memory w) = good();
        t.nonceSeq = PayChecks.MAX_NONCE_SEQ + 1;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadNonce.selector));
        (t, w) = good();
        t.nonceKey0 = 1;
        expectFail(t, w, abi.encodeWithSelector(ExitRelayChecks.BadNonce.selector));
    }
}

contract SettlerFlowTest is Test {
    MockWETH weth = new MockWETH();
    MockERC20 usd = new MockERC20();
    MockPoolManager manager = new MockPoolManager(usd, 4e8); // 50e6 units cost 0.02 ETH
    SettlerFactory factory = new SettlerFactory(address(weth), address(manager), address(usd), 3000, 60);
    InvoiceBook book = new InvoiceBook();
    address fund = address(0xF0);
    address change = address(0xC4A9);
    uint256 id;
    Terms t;
    address at;

    function setUp() public {
        id = book.create(fund, address(usd), 50e6);
        t = Terms(id, address(book), 50e6, 0.025 ether, change);
        at = factory.addressOf(t);
        vm.deal(address(weth), 1 ether);
        weth.mint(at, 0.09 ether); // the withdraw lands before the Settler has code
    }

    function run() internal returns (Settler s) {
        s = Settler(payable(factory.deploy(t)));
        assertEq(address(s), at);
        s.unwrap();
        s.swap();
        book.settle(id, address(s));
        s.sweep();
        s.assertSettled();
    }

    function test_paysTheInvoiceAndReturnsTheChange() public {
        Settler s = run();
        assertEq(usd.balanceOf(fund), 50e6);
        assertTrue(book.paid(id));
        assertEq(change.balance, 0.07 ether);
        assertEq(address(s).balance, 0);
    }

    function test_codeHashMatchesTheDeployedInitCode() public view {
        assertEq(factory.settlerCodeHash(), keccak256(type(Settler).creationCode));
    }

    function test_deploysOnce() public {
        factory.deploy(t);
        vm.expectRevert();
        factory.deploy(t);
    }

    function test_swapRejectsInputAboveMaxIn() public {
        t.maxIn = 0.02 ether - 1;
        at = factory.addressOf(t);
        weth.mint(at, 0.09 ether);
        Settler s = Settler(payable(factory.deploy(t)));
        s.unwrap();
        vm.expectRevert(abi.encodeWithSelector(Settler.InputTooHigh.selector, 0.02 ether));
        s.swap();
    }

    function test_assertSettledRevertsBeforeTheInvoiceIsPaid() public {
        Settler s = Settler(payable(factory.deploy(t)));
        vm.expectRevert(Settler.NotSettled.selector);
        s.assertSettled();
    }

    function test_settleRejectsAPayerForAnotherInvoice() public {
        uint256 other = book.create(fund, address(usd), 50e6);
        Settler s = Settler(payable(factory.deploy(t)));
        s.unwrap();
        s.swap();
        vm.expectRevert(InvoiceBook.WrongPayer.selector);
        book.settle(other, address(s));
    }

    /// A third party pays the invoice first: the plan cannot settle, and refund returns every balance to `change`.
    function test_refundAfterSomeoneElsePaidReturnsEverything() public {
        address other = address(0x07);
        usd.mint(other, 50e6);
        vm.prank(other);
        usd.approve(address(book), 50e6);
        vm.mockCall(other, abi.encodeWithSignature("invoiceId()"), abi.encode(id));
        book.settle(id, other);

        Settler s = Settler(payable(factory.deploy(t)));
        s.unwrap();
        s.swap();
        vm.expectRevert(abi.encodeWithSelector(InvoiceBook.AlreadyPaid.selector, id));
        book.settle(id, address(s));
        s.refund();
        assertEq(change.balance, 0.07 ether);
        assertEq(usd.balanceOf(change), 50e6);
        assertEq(address(s).balance + usd.balanceOf(address(s)) + weth.balanceOf(address(s)), 0);
    }

    function test_refundBeforeUnwrapReturnsTheWeth() public {
        usd.mint(address(this), 50e6);
        usd.approve(address(book), 50e6);
        vm.mockCall(address(this), abi.encodeWithSignature("invoiceId()"), abi.encode(id));
        book.settle(id, address(this));
        Settler s = Settler(payable(factory.deploy(t)));
        s.refund();
        assertEq(weth.balanceOf(change), 0.09 ether);
    }

    function test_refundRevertsWhileTheInvoiceIsOpen() public {
        Settler s = Settler(payable(factory.deploy(t)));
        vm.expectRevert(Settler.NotPaid.selector);
        s.refund();
    }
}
