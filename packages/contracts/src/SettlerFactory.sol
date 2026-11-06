// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Settler, Terms} from "./Settler.sol";

/// Deploys Settlers at keccak256(abi.encode(terms))-salted CREATE2 addresses. Terms pass through transient storage
/// (the Uniswap v3 parameter pattern), so the init code is constant and anyone can predict an address from
/// (this, salt, settlerCodeHash) without the creation code.
contract SettlerFactory {
    address public immutable weth;
    address public immutable manager;
    address public immutable token;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    bytes32 public immutable settlerCodeHash = keccak256(type(Settler).creationCode);

    uint256 transient tInvoiceId;
    address transient tBook;
    uint256 transient tAmount;
    uint256 transient tMaxIn;
    address transient tChange;

    constructor(address weth_, address manager_, address token_, uint24 fee_, int24 tickSpacing_) {
        (weth, manager, token, fee, tickSpacing) = (weth_, manager_, token_, fee_, tickSpacing_);
    }

    /// Reverts if a Settler already sits at the address, so each plan deploys once.
    function deploy(Terms calldata t) external returns (address) {
        (tInvoiceId, tBook, tAmount, tMaxIn, tChange) = (t.invoiceId, t.book, t.amount, t.maxIn, t.change);
        return address(new Settler{salt: keccak256(abi.encode(t))}());
    }

    function addressOf(Terms calldata t) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(t)), settlerCodeHash))))
        );
    }

    function params() external view returns (Terms memory, address, address, address, uint24, int24) {
        return (Terms(tInvoiceId, tBook, tAmount, tMaxIn, tChange), weth, manager, token, fee, tickSpacing);
    }
}
