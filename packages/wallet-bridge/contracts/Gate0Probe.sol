// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {TxParam, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// Gate 0: run in a VERIFY frame under ethrex_simulateFrameTransaction. It never approves; it reverts with ONE opcode
/// answer so the script reads it from revertData, and a halting opcode (empty revertData) is pinned to that read.
/// Calldata: byte 0 = which read, byte 1 = signature index, bytes 2..3 = SIGDATACOPY length.
contract Gate0Probe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    error Word(uint8 what, uint256 value);
    error Copied(bytes data);

    constructor() payable {}

    receive() external payable {}

    fallback() external payable {
        uint8 what = uint8(msg.data[0]);
        uint256 sig = uint8(msg.data[1]);
        if (what == 0) revert Word(what, txparam(TxParam.SIG_HASH));
        if (what == 1) revert Word(what, txparam(TxParam.SIGNATURE_COUNT));
        if (what == 2) revert Word(what, sigparam(sig, SigParam.RESOLVED_SIGNER));
        if (what == 3) revert Word(what, sigparam(sig, SigParam.SCHEME));
        if (what == 4) revert Word(what, sigparam(sig, SigParam.MSG));
        if (what == 5) revert Word(what, sigparam(sig, SigParam.SIGNATURE_LENGTH));
        if (what == 6) revert Copied(sigdatacopy(0, (uint256(uint8(msg.data[2])) << 8) | uint8(msg.data[3]), sig));
        if (what == 7) revert Word(what, txparam(TxParam.NONCE));
        if (what == 8) revert Word(what, txparam(TxParam.MAX_COST));
        if (what == 9) revert Word(what, txparam(TxParam.CURRENT_FRAME_INDEX));
        revert Word(255, 0);
    }
}
