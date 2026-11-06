// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ExitRelayToken} from "../src/ExitRelayToken.sol";

/// WETH9's shape: balanceOf, and withdraw pays with transfer() (2300 gas stipend).
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external payable {
        balanceOf[to] += amount;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }

    receive() external payable {}
}

contract ExitRelayTokenTest is Test {
    uint256 constant FEE = 1e16;
    MockWETH weth;
    ExitRelayToken relay;

    function setUp() public {
        weth = new MockWETH();
        relay = new ExitRelayToken(address(0xB001), address(0xB002), FEE, address(weth));
    }

    function test_constructorKeepsRelayConfigAndToken() public view {
        assertEq(relay.token(), address(weth));
        assertEq(relay.pool(), address(0xB001));
        assertEq(relay.verifier(), address(0xB002));
        assertEq(relay.fee(), FEE);
    }

    function test_unwrapFeesTurnsWethIntoEthFloor() public {
        vm.deal(address(weth), FEE);
        weth.mint(address(relay), FEE);
        uint256 floatBefore = address(relay).balance;

        vm.prank(address(0xCAFE)); // anyone
        uint256 amount = relay.unwrapFees();

        assertEq(amount, FEE);
        assertEq(weth.balanceOf(address(relay)), 0);
        assertEq(address(relay).balance, floatBefore + FEE);
    }

    function test_unwrapFeesUnwrapsEveryAccruedFee() public {
        vm.deal(address(weth), 3 * FEE);
        weth.mint(address(relay), FEE);
        weth.mint(address(relay), 2 * FEE);
        assertEq(relay.unwrapFees(), 3 * FEE);
        assertEq(address(relay).balance, 3 * FEE);
    }

    function test_unwrapFeesRevertsWithNoWeth() public {
        vm.expectRevert(ExitRelayToken.NothingToUnwrap.selector);
        relay.unwrapFees();
    }
}
