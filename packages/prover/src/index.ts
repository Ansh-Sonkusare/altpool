// Owner: Dev A. Gate G1 (research repo docs/08): prove, then eth_call the Verifier with
// [root, nullifierHash, recipient, relayer, fee, refund] -> true, and false at fee + 1.
// Trap: websnark's prover is wrong on this devnet; snarkjs needs x = 0 treated as infinity.
import { todo, type Address, type Hex, type Note, type WithdrawProof } from "@altpool/core";

export const createNote = (): Note => todo("createNote");

/** Rebuild the pool's 20-level MiMC tree from Deposit events and return the root containing the note. */
export const rootFor = (_note: Note): Promise<{ root: Hex; pathElements: bigint[]; pathIndices: number[] }> => todo("rootFor");

export const prove = (_note: Note, _to: { recipient: Address; relayer: Address; fee: bigint; refund?: bigint }): Promise<WithdrawProof> =>
  todo("prove");
