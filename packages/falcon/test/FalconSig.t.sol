// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ZKNOX_falcon} from "ethfalcon/ZKNOX_falcon.sol";
import {FalconSig} from "../src/FalconSig.sol";

contract Harness {
    function check(address v, bytes32 pkHash, bytes32 digest, bytes memory sig) external pure returns (bool) {
        return FalconSig.check(v, pkHash, digest, sig);
    }
}

/// test/vector.json is written by `bun scripts/gen-vector.ts`: noble keygen + sign, TS-side NTT key and s2 packing.
contract FalconSigTest is Test {
    ZKNOX_falcon verifier = new ZKNOX_falcon();
    Harness h = new Harness();
    bytes32 digest;
    bytes32 pkHash;
    bytes sig;

    function setUp() public {
        string memory j = vm.readFile("test/vector.json");
        digest = vm.parseJsonBytes32(j, ".digest");
        pkHash = vm.parseJsonBytes32(j, ".pkHash");
        sig = vm.parseJsonBytes(j, ".sig");
        assertEq(sig.length, FalconSig.SIG_LEN);
    }

    function test_tsEncodedKeyAndSignatureVerify() public view {
        uint256 g = gasleft();
        bool ok = h.check(address(verifier), pkHash, digest, sig);
        console.log("FalconSig.check gas", g - gasleft());
        assertTrue(ok);
    }

    function test_wrongDigestRejected() public view {
        assertFalse(h.check(address(verifier), pkHash, bytes32(uint256(digest) ^ 1), sig));
    }

    function test_flippedSignatureByteRejected() public view {
        // salt, s2 and key regions: any flipped byte must fail (verifier norm check, or pkHash mismatch)
        uint256[3] memory at = [uint256(5), 40 + 100, FalconSig.SIG_LEN - 1];
        for (uint256 i = 0; i < 3; i++) {
            bytes memory bad = sig;
            bad[at[i]] ^= 0x01;
            bool ok;
            try h.check(address(verifier), pkHash, digest, bad) returns (bool r) {
                ok = r;
            } catch {}
            assertFalse(ok, "tampered signature accepted");
        }
    }

    function test_wrongKeyHashRejected() public view {
        assertFalse(h.check(address(verifier), bytes32(uint256(pkHash) ^ 1), digest, sig));
    }

    function test_wrongLengthRejected() public view {
        assertFalse(h.check(address(verifier), pkHash, digest, new bytes(FalconSig.SIG_LEN - 1)));
    }
}
