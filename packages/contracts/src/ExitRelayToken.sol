// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExitRelay} from "./ExitRelay.sol";

interface IWETH {
    function balanceOf(address) external view returns (uint256);
    function withdraw(uint256) external;
}

/// ExitRelay in front of an ERC20 Tornado pool whose fee is paid in WETH. The VERIFY and SENDER frames are identical:
/// the pool transfers `fee` WETH to this contract, but gas is paid from this contract's ETH float. unwrapFees()
/// converts the WETH back into that float.
contract ExitRelayToken is ExitRelay {
    address public immutable token;

    error NothingToUnwrap();

    constructor(address pool_, address verifier_, uint256 fee_, address token_) payable ExitRelay(pool_, verifier_, fee_) {
        token = token_;
    }

    /// Permissionless: it only moves value from this contract's WETH to this contract's ETH. WETH9 sends the ETH with
    /// transfer() (2300 gas), which the empty receive() fits.
    function unwrapFees() external returns (uint256 amount) {
        amount = IWETH(token).balanceOf(address(this));
        if (amount == 0) revert NothingToUnwrap();
        IWETH(token).withdraw(amount);
    }
}
