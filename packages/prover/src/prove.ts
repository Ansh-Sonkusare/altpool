// Groth16 proof for the tornado v2.0 withdraw circuit via snarkjs 0.1.20 and the converted v2.0 proving key.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, toHex } from "viem";
import type { Address, Note, WithdrawProof } from "@altpool/core";
import { rootFor, type MerklePath } from "./tree";

type Witness = unknown;
type Snarkjs = {
  Circuit: new (def: unknown) => { calculateWitness(input: Record<string, bigint | bigint[]>): Witness };
  groth: { genProof(pk: unknown, w: Witness): { proof: { pi_a: bigint[]; pi_b: bigint[][]; pi_c: bigint[] } } };
  unstringifyBigInts(o: unknown): unknown;
};
const { Circuit, groth, unstringifyBigInts }: Snarkjs = createRequire(import.meta.url)("snarkjs");

const DIR = fileURLToPath(new URL("../artifacts", import.meta.url));
const CIRCUIT = join(DIR, "withdraw.json");
const PK = join(DIR, "withdraw_proving_key.json");

// ~70 MB of JSON: parse once, lazily.
let cached: { circuit: InstanceType<Snarkjs["Circuit"]>; pk: unknown } | undefined;
const load = () => {
  if (cached) return cached;
  if (!existsSync(CIRCUIT) || !existsSync(PK))
    throw new Error("missing prover artifacts: run bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert first");
  cached = {
    circuit: new Circuit(unstringifyBigInts(JSON.parse(readFileSync(CIRCUIT, "utf8")))),
    pk: unstringifyBigInts(JSON.parse(readFileSync(PK, "utf8"))),
  };
  return cached;
};

export type WithdrawTo = { recipient: Address; relayer: Address; fee: bigint; refund?: bigint };

export const proveWithPath = (note: Note, path: Pick<MerklePath, "root" | "pathElements" | "pathIndices">, to: WithdrawTo): WithdrawProof => {
  const { circuit, pk } = load();
  const refund = to.refund ?? 0n;
  const witness = circuit.calculateWitness({
    root: BigInt(path.root),
    nullifierHash: BigInt(note.nullifierHash),
    recipient: BigInt(to.recipient),
    relayer: BigInt(to.relayer),
    fee: to.fee,
    refund,
    nullifier: note.nullifier,
    secret: note.secret,
    pathElements: path.pathElements,
    pathIndices: path.pathIndices.map(BigInt),
  });
  const { proof: p } = groth.genProof(pk, witness);
  // Solidity verifier order: a, b with each G2 coordinate's (c1, c0) swapped, c.
  const words = [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]];
  return {
    proof: concat(words.map((w) => toHex(BigInt(w), { size: 32 }))),
    root: path.root,
    nullifierHash: note.nullifierHash,
    recipient: to.recipient,
    relayer: to.relayer,
    fee: to.fee,
    refund,
  };
};

export const prove = async (note: Note, to: WithdrawTo): Promise<WithdrawProof & { rootIdx: number }> => {
  const path = await rootFor(note);
  return { ...proveWithPath(note, path, to), rootIdx: path.rootIdx };
};
