// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FalconWalletFactory} from "../src/FalconWalletFactory.sol";
import {FalconWallet} from "../src/FalconWallet.sol";

contract FalconWalletFactoryTest is Test {
    address verifier = address(0xFA1C0);
    FalconWalletFactory factory = new FalconWalletFactory(verifier);

    function test_deployMatchesPrediction_andKeepsPrefundedEth() public {
        bytes32 pkHash = keccak256("key-a");
        address predicted = factory.predictAddress(pkHash);
        assertEq(predicted.code.length, 0);
        vm.deal(predicted, 0.09 ether); // a QuietSend exit lands here before the wallet exists
        address deployed = factory.deploy(pkHash);
        assertEq(deployed, predicted);
        assertEq(predicted.balance, 0.09 ether);
        assertEq(FalconWallet(payable(deployed)).pkHash(), pkHash);
        assertEq(FalconWallet(payable(deployed)).verifier(), verifier);
    }

    function test_differentKeysDifferentAddresses() public view {
        assertTrue(factory.predictAddress(keccak256("a")) != factory.predictAddress(keccak256("b")));
    }

    function test_secondDeployReverts() public {
        factory.deploy(keccak256("key-b"));
        vm.expectRevert();
        factory.deploy{gas: 3_000_000}(keccak256("key-b")); // a CREATE2 collision burns the forwarded gas
    }

    function test_executeOnlyBySelf() public {
        FalconWallet w = FalconWallet(payable(factory.deploy(keccak256("key-c"))));
        vm.deal(address(w), 1 ether);
        vm.expectRevert(FalconWallet.OnlySelf.selector);
        w.execute(address(this), 1 ether, "");
        vm.prank(address(w));
        w.execute(address(0xBEEF), 0.25 ether, "");
        assertEq(address(0xBEEF).balance, 0.25 ether);
    }

    function test_receivesPlainEth() public {
        FalconWallet w = FalconWallet(payable(factory.deploy(keccak256("key-d"))));
        (bool ok,) = address(w).call{value: 1 wei}("");
        assertTrue(ok);
    }
}
