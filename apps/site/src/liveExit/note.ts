// Browser port of packages/prover/src/note.ts (that file needs node:crypto and createRequire; the prover package is not ours to edit).
// Tornado note: 31-byte LE nullifier + secret, commitment = pedersen(nullifier ‖ secret), nullifierHash = pedersen(nullifier).
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

/** The Tornado preimage format (noteToString in @altpool/prover): `0x` + 124 hex, nullifier bytes (LE) first. */
export const noteToString = (n: Note): string => "0x" + Buffer.concat([le31(n.nullifier), le31(n.secret)]).toString("hex");

/** Finds the one `0x` + 124 hex preimage in pasted text, so a whole saved file parses too. */
export const parseNote = (text: string): Note => {
  const hits = text.match(/0x[0-9a-fA-F]{124}(?![0-9a-fA-F])/g) ?? [];
  if (hits.length !== 1) throw new Error(hits.length ? "more than one note in the text: paste one" : "no note found: expected 0x and 124 hex characters");
  const b = Buffer.from(hits[0]!.slice(2), "hex");
  return noteFrom(fromLe(b.subarray(0, 31)), fromLe(b.subarray(31)));
};
