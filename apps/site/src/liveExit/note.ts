// Browser port of packages/prover/src/note.ts (that file needs node:crypto and createRequire; the prover package is not ours to edit).
// Tornado note: 31-byte LE nullifier + secret, commitment = pedersen(nullifier ‖ secret), nullifierHash = pedersen(nullifier).
import "./shim";
import { Buffer } from "buffer";
import babyJub from "circomlib/src/babyjub.js";
import pedersenHash from "circomlib/src/pedersenHash.js";
import { toHex } from "viem";
import type { Hex, Note } from "@altpool/core";

const le31 = (x: bigint) => {
  const b = Buffer.alloc(31);
  for (let i = 0; i < 31; i++, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};
const fromLe = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).reverse().toString("hex") || "0"));
const pedersen = (b: Buffer): Hex => toHex(BigInt(String(babyJub.unpackPoint(pedersenHash.hash(b))[0])), { size: 32 });

const noteFrom = (nullifier: bigint, secret: bigint): Note => ({
  nullifier,
  secret,
  commitment: pedersen(Buffer.concat([le31(nullifier), le31(secret)])),
  nullifierHash: pedersen(le31(nullifier)),
});

export const createNote = (): Note => noteFrom(fromLe(crypto.getRandomValues(new Uint8Array(31))), fromLe(crypto.getRandomValues(new Uint8Array(31))));

/** The prover server's input format (parseNote in @altpool/prover). Only the server fallback uses it. */
export const noteToString = (n: Note): string => "0x" + Buffer.concat([le31(n.nullifier), le31(n.secret)]).toString("hex");

