// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./Settler.sol";

interface IPayer {
    function invoiceId() external view returns (uint256);
}

/// Invoices a payer settles by id, so a payee can reconcile a payment without learning who paid.
contract InvoiceBook {
    struct Invoice {
        address payee;
        address token;
        uint256 amount;
        bool paid;
    }

    Invoice[] public invoices;

    event Created(uint256 indexed id, address indexed payee, address token, uint256 amount);
    event Paid(uint256 indexed id, address indexed from);

    error AlreadyPaid(uint256 id);
    error WrongPayer();
    error TransferFailed();

    function create(address payee, address token, uint256 amount) external returns (uint256 id) {
        id = invoices.length;
        invoices.push(Invoice(payee, token, amount, false));
        emit Created(id, payee, token, amount);
    }

    function paid(uint256 id) external view returns (bool) {
        return invoices[id].paid;
    }

    /// Pulls the amount from `from`'s allowance. `from` must name this invoice, so a payer's allowance pays only its own
    /// invoice even if someone else calls settle.
    function settle(uint256 id, address from) external {
        Invoice storage inv = invoices[id];
        if (inv.paid) revert AlreadyPaid(id);
        if (IPayer(from).invoiceId() != id) revert WrongPayer();
        inv.paid = true;
        if (!IERC20(inv.token).transferFrom(from, inv.payee, inv.amount)) revert TransferFailed();
        emit Paid(id, from);
    }
}
