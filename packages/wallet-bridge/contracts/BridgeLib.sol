// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The pure half of BridgeAccount: EIP-712 hashing and signature parsing, kept free of frame opcodes so forge can
/// test it (forge's EVM does not know 0xb0-0xb5). src/typedData.ts builds the same structs for the wallet.
library BridgeLib {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("AltpoolBridge");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    /// Mode A. Every field is re-derived on-chain from the frame tx itself, so what the wallet shows is what is checked.
    /// sigHash commits to the whole tx (all frames, nonce, chain id, fees); the other fields are there for the user.
    /// Not maxCost: TXPARAM(MAX_COST) includes calldata gas over the signature bytes, so it changes once signed.
    bytes32 internal constant FRAME_TX_TYPEHASH = keccak256(
        "FrameTx(bytes32 sigHash,address to,uint256 value,uint256 nonce,uint256 frameCount,uint256 maxFeePerGas)"
    );

    /// Mode B. The owner authorises `key` to sign frame txs natively (SECP256K1) within these limits.
    bytes32 internal constant SESSION_TYPEHASH = keccak256(
        "Session(address key,uint64 validUntil,uint256 maxValuePerTx,uint256 maxCostPerTx,address target)"
    );

    /// EIP-1271: the owner signs `Message(bytes32 hash)` under this account's domain, so a signature for one
    /// account cannot be replayed on another account with the same owner.
    bytes32 internal constant MESSAGE_TYPEHASH = keccak256("Message(bytes32 hash)");

    /// secp256k1n / 2: signatures with a larger s are malleable twins and are rejected.
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct FrameTx {
        bytes32 sigHash;
        address to;
        uint256 value;
        uint256 nonce;
        uint256 frameCount;
        uint256 maxFeePerGas;
    }

    struct Session {
        address key;
        uint64 validUntil;
        uint256 maxValuePerTx;
        uint256 maxCostPerTx;
        address target;
    }

    error BadSignatureLength(uint256 length);
    error BadV(uint8 v);
    error HighS();
    error BadSigner(address recovered);

    function domainSeparator(uint256 chainId, address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, chainId, account));
    }

    function hashFrameTx(FrameTx memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(FRAME_TX_TYPEHASH, t.sigHash, t.to, t.value, t.nonce, t.frameCount, t.maxFeePerGas));
    }

    function hashSession(Session memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(SESSION_TYPEHASH, s.key, s.validUntil, s.maxValuePerTx, s.maxCostPerTx, s.target));
    }

    function hashMessage(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encode(MESSAGE_TYPEHASH, hash));
    }

    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// The signer of a 65-byte `r || s || v` signature (v = 27/28, what eth_signTypedData_v4 returns). Reverts on a
    /// malformed or malleable signature or an unrecoverable one, so a caller never compares against address(0).
    function recover(bytes32 hash, bytes memory sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignatureLength(sig.length);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27; // tolerate a 0/1 recovery id
        if (v != 27 && v != 28) revert BadV(v);
        if (uint256(s) > HALF_N) revert HighS();
        signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert BadSigner(address(0));
    }
}
