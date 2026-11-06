// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The payment plan a Pledge Paid exit commits to: keccak256(abi.encode(terms)) is the Settler's CREATE2 salt, and the
/// Settler's address is the withdraw proof's recipient.
struct Terms {
    uint256 invoiceId;
    address book;
    uint256 amount;
    uint256 maxIn;
    address change;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IWETH9 {
    function balanceOf(address) external view returns (uint256);
    function withdraw(uint256) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IInvoiceBook {
    function paid(uint256 id) external view returns (bool);
}

interface ISettlerParams {
    function params()
        external
        view
        returns (Terms memory t, address weth, address manager, address token, uint24 fee, int24 tickSpacing);
}

/// One-shot payment plan at a CREATE2 address fixed by its terms. Funds can land here before it has code; deploying it
/// (SettlerFactory.deploy) and calling unwrap, swap, InvoiceBook.settle, sweep in order pays the invoice and returns the
/// change. Every destination is immutable, so any caller can only drive the plan forward.
contract Settler {
    /// v4 TickMath.MIN_SQRT_PRICE + 1: no price limit for a zeroForOne swap; maxIn bounds the cost instead.
    uint160 internal constant PRICE_LIMIT = 4295128740;

    uint256 public immutable invoiceId;
    address public immutable book;
    uint256 public immutable amount;
    uint256 public immutable maxIn;
    address public immutable change;
    IWETH9 internal immutable weth;
    IPoolManager internal immutable manager;
    address internal immutable token;
    uint24 internal immutable fee;
    int24 internal immutable tickSpacing;

    error NotManager();
    error InputTooHigh(uint256 owed);
    error ShortOutput(uint256 out);
    error SweepFailed();
    error NotSettled();
    error NotPaid();

    /// Takes its terms from the deploying factory so the init code, and so the CREATE2 code hash, is constant.
    constructor() {
        Terms memory t;
        address weth_;
        address manager_;
        (t, weth_, manager_, token, fee, tickSpacing) = ISettlerParams(msg.sender).params();
        (invoiceId, book, amount, maxIn, change) = (t.invoiceId, t.book, t.amount, t.maxIn, t.change);
        (weth, manager) = (IWETH9(weth_), IPoolManager(manager_));
    }

    /// Empty: WETH9.withdraw pays with transfer() (2300 gas).
    receive() external payable {}

    function unwrap() external {
        weth.withdraw(weth.balanceOf(address(this)));
    }

    /// Exact-output v4 swap of ETH for `amount` of the token, then lets the book pull exactly that.
    function swap() external {
        manager.unlock("");
        IERC20(token).approve(book, amount);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        int256 delta = manager.swap(
            PoolKey(address(0), token, fee, tickSpacing, address(0)), SwapParams(true, int256(amount), PRICE_LIMIT), ""
        );
        uint256 owed = uint128(-int128(delta >> 128));
        uint256 out = uint128(int128(delta));
        if (owed > maxIn) revert InputTooHigh(owed);
        if (out != amount) revert ShortOutput(out);
        manager.settle{value: owed}();
        manager.take(token, address(this), amount);
        return "";
    }

    function sweep() external {
        (bool ok,) = change.call{value: address(this).balance}("");
        if (!ok) revert SweepFailed();
    }

    /// Rescue when someone else paid the invoice first: the plan can no longer settle, so every ETH, WETH and token
    /// balance goes to `change`. Not part of the 9-frame tx.
    function refund() external {
        if (!IInvoiceBook(book).paid(invoiceId)) revert NotPaid();
        for (uint256 i = 0; i < 2; i++) {
            IERC20 t = IERC20(i == 0 ? address(weth) : token);
            uint256 bal = t.balanceOf(address(this));
            if (bal != 0 && !t.transfer(change, bal)) revert SweepFailed();
        }
        (bool ok,) = change.call{value: address(this).balance}("");
        if (!ok) revert SweepFailed();
    }

    /// The batch's closing frame: reverting here rolls back every atomic frame before it.
    function assertSettled() external view {
        if (
            !IInvoiceBook(book).paid(invoiceId) || address(this).balance != 0 || weth.balanceOf(address(this)) != 0
                || IERC20(token).balanceOf(address(this)) != 0
        ) revert NotSettled();
    }
}
