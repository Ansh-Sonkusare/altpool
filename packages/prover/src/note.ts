// Tornado notes: 31-byte LE nullifier + secret, commitment = pedersen(nullifier ‖ secret), nullifierHash = pedersen(nullifier).
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { toHex } from "viem";
import type { Hex, Note } from "@altpool/core";

const { babyJub, pedersenHash } = createRequire(import.meta.url)("circomlib");

const le31 = (x: bigint) => {
  const b = Buffer.alloc(31);
  for (let i = 0; i < 31; i++, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};
const fromLe = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).reverse().toString("hex") || "0"));
const pedersen = (b: Buffer): Hex => toHex(BigInt(babyJub.unpackPoint(pedersenHash.hash(b))[0]), { size: 32 });

const noteFrom = (nullifier: bigint, secret: bigint): Note => ({
  nullifier,
  secret,
  commitment: pedersen(Buffer.concat([le31(nullifier), le31(secret)])),
  nullifierHash: pedersen(le31(nullifier)),
});

export const createNote = (): Note => noteFrom(fromLe(randomBytes(31)), fromLe(randomBytes(31)));

/** Tornado preimage format: `0x` + 124 hex chars, nullifier bytes (LE) first. */
export const noteToString = (n: Note): string => "0x" + Buffer.concat([le31(n.nullifier), le31(n.secret)]).toString("hex");

export const parseNote = (s: string): Note => {
  if (!/^0x[0-9a-fA-F]{124}$/.test(s)) throw new Error("bad note: expected 0x + 124 hex chars");
  const b = Buffer.from(s.slice(2), "hex");
  return noteFrom(fromLe(b.subarray(0, 31)), fromLe(b.subarray(31)));
};
