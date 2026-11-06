// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRelay} from "./ExitRelay.sol";

interface IWETH {
    function balanceOf(address) external view returns (uint256);
    function withdraw(uint256) external;
}

/// ExitRelay in front of an ERC20 Tornado pool whose fee is paid in WETH. The VERIFY and SENDER frames are identical
/// except the SENDER frame carries `refund` wei from this contract's float; the pool forwards it to the recipient
/// (Tornado's `refund`, bound in the proof), so the recipient can unwrap the WETH itself. Gas is paid from this
/// contract's ETH float. unwrapFees() converts the WETH fees back into that float.
contract ExitRelayToken is ExitRelay {
    address public immutable token;
    uint256 public immutable refund;

    error NothingToUnwrap();

    constructor(address pool_, address verifier_, uint256 fee_, address token_, uint256 refund_)
        payable
        ExitRelay(pool_, verifier_, fee_)
    {
        token = token_;
        refund = refund_;
    }

    function _refund() internal view override returns (uint256) {
        return refund;
    }

    /// Permissionless: it only moves value from this contract's WETH to this contract's ETH. WETH9 sends the ETH with
    /// transfer() (2300 gas), which the empty receive() fits.
    function unwrapFees() external returns (uint256 amount) {
        amount = IWETH(token).balanceOf(address(this));
        if (amount == 0) revert NothingToUnwrap();
        IWETH(token).withdraw(amount);
    }
}
