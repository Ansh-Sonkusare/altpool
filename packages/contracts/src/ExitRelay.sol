// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Sends QuietSend withdrawals as EIP-8141 frame transactions and is repaid from the fee.
/// Spec: research repo docs/03. Owner: Dev A.
/// VERIFY: known root, unspent nullifier, verifyProof, recipient/relayer/fee pinned to frame 2 calldata,
/// gas <= VERIFY_GAS_MAX. SENDER: pool.withdraw.
contract ExitRelay {
    address public immutable pool;
    address public immutable verifier;
    uint256 public immutable fee;

    constructor(address pool_, address verifier_, uint256 fee_) {
        pool = pool_;
        verifier = verifier_;
        fee = fee_;
    }
}
