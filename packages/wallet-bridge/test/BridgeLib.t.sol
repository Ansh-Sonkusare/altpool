// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeLib} from "../contracts/BridgeLib.sol";

/// Exposes the library so reverts can be expected.
contract BridgeLibHarness {
    function recover(bytes32 h, bytes memory sig) external pure returns (address) {
        return BridgeLib.recover(h, sig);
    }
}

/// Pure-logic parity with viem's hashTypedData (vectors computed with viem 2.57, see test/bridge.test.ts in this
/// package and packages/sdk/test/bridge.test.ts). Frame opcodes are not testable here: forge's EVM lacks 0xb0-0xb5;
/// those run live (scripts/smoke.ts, which also checks these digests against the deployed contract via eth_call).
contract BridgeLibTest is Test {
    address constant ACCOUNT = 0x9f1331A6E016620Bab4674ECf3e233E72A92862a;
    address constant TO = 0x23864f6a599992d1964F3988ddE398F989D134A0;
    BridgeLibHarness h = new BridgeLibHarness();

    function test_domainSeparatorMatchesViem() public pure {
        assertEq(BridgeLib.domainSeparator(1337, ACCOUNT), 0x2a73d7b0a8af3feec15f6467e937579731df5875da8a2993a27a205db98375ee);
    }

    function test_frameTxDigestMatchesViem() public pure {
        BridgeLib.FrameTx memory t = BridgeLib.FrameTx({
            sigHash: keccak256("sighash"), to: TO, value: 1, nonce: 8, frameCount: 2, maxFeePerGas: 20
        });
        bytes32 d = BridgeLib.digest(BridgeLib.domainSeparator(1337, ACCOUNT), BridgeLib.hashFrameTx(t));
        assertEq(d, 0x0c72af2e71b16557ac3971beae261ff24978671eb2004e6441db4db457f00a7c);
    }

    function test_sessionDigestMatchesViem() public pure {
        BridgeLib.Session memory s = BridgeLib.Session({
            key: 0x5B4e79C0E4b5eeF465D7aF4D2Fb33E1c9680f7C5, validUntil: 1794002422, maxValuePerTx: 1000,
            maxCostPerTx: 1e16, target: TO
        });
        bytes32 d = BridgeLib.digest(BridgeLib.domainSeparator(1337, ACCOUNT), BridgeLib.hashSession(s));
        assertEq(d, 0x80f12ff8ad059c57795ed6001748ab0da947255decca3f4d1f962fb0ad2073d7);
    }

    function test_recoverRsv(uint256 pk, bytes32 digest) public view {
        pk = bound(pk, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(h.recover(digest, abi.encodePacked(r, s, v)), vm.addr(pk)); // r||s||v, v = 27/28
        assertEq(h.recover(digest, abi.encodePacked(r, s, v - 27)), vm.addr(pk)); // 0/1 tolerated
    }

    function test_rejectsHighS() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, keccak256("x"));
        bytes32 highS = bytes32(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(s));
        vm.expectRevert(BridgeLib.HighS.selector);
        h.recover(keccak256("x"), abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));
    }

    function test_rejectsBadLengthAndV() public {
        vm.expectRevert(abi.encodeWithSelector(BridgeLib.BadSignatureLength.selector, 64));
        h.recover(bytes32(0), new bytes(64));
        bytes memory sig = new bytes(65);
        sig[64] = 0x1d;
        vm.expectRevert(abi.encodeWithSelector(BridgeLib.BadV.selector, 29));
        h.recover(bytes32(0), sig);
    }

    function test_rejectsUnrecoverable() public {
        bytes memory sig = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));
        vm.expectRevert(abi.encodeWithSelector(BridgeLib.BadSigner.selector, address(0)));
        h.recover(keccak256("x"), sig);
    }
}
