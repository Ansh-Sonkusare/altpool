// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// ZKNOX_falcon.verify (NIST/SHAKE256 Falcon-512): the message is hashed to a point with the 40-byte salt, s2 is the
/// signature polynomial and ntth the public key in the NTT domain; both polynomials are 32 words of 16 packed
/// 16-bit coefficients. Upstream marks it experimental and unaudited.
interface IFalconVerifier {
    function verify(bytes memory h, bytes memory salt, uint256[] memory s2, uint256[] memory ntth)
        external
        pure
        returns (bool);
}

/// The signature bytes a FalconWallet reads from its ARBITRARY signature entry:
///   salt (40) || s2 (32 words) || ntth (32 words)  = 2088 bytes.
/// The wallet stores only keccak256(ntth bytes). Shipping the key with each signature keeps VERIFY from reading any
/// state and costs nothing at deploy (no SSTORE/SSTORE2 state gas for a 1 KB key).
library FalconSig {
    uint256 internal constant SALT_LEN = 40;
    uint256 internal constant POLY_BYTES = 1024;
    uint256 internal constant SIG_LEN = SALT_LEN + 2 * POLY_BYTES;

    /// false for a wrong length, a key that does not match `pkHash`, or a signature the verifier rejects.
    /// The verifier itself reverts on a malformed polynomial length; lengths are fixed here so that cannot happen.
    function check(address verifier, bytes32 pkHash, bytes32 digest, bytes memory sig) internal pure returns (bool) {
        if (sig.length != SIG_LEN) return false;
        bytes memory salt = new bytes(SALT_LEN);
        uint256[] memory s2 = new uint256[](32);
        uint256[] memory ntth = new uint256[](32);
        bytes32 keyHash;
        assembly ("memory-safe") {
            let src := add(sig, 32)
            mstore(add(salt, 32), mload(src))
            mstore(add(salt, 64), mload(add(src, 32)))
            let s2p := add(src, SALT_LEN)
            let ntp := add(s2p, POLY_BYTES)
            for { let i := 0 } lt(i, 32) { i := add(i, 1) } {
                mstore(add(add(s2, 32), shl(5, i)), mload(add(s2p, shl(5, i))))
                mstore(add(add(ntth, 32), shl(5, i)), mload(add(ntp, shl(5, i))))
            }
            keyHash := keccak256(ntp, POLY_BYTES)
        }
        if (keyHash != pkHash) return false;
        return IFalconVerifier(verifier).verify(abi.encodePacked(digest), salt, s2, ntth);
    }
}
