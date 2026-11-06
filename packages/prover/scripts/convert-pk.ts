// Convert tornado v2.0 websnark proving key (.bin) into the snarkjs 0.1.20 groth JSON shape.
// Points are LE Montgomery mod q, poly coefficients LE Montgomery mod r; stored x == 0 is the point at infinity.
// polsC is not in the bin: derive it from withdraw.json constraints, and self-check polsA/polsB the same way.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../artifacts", import.meta.url));
const BIN = join(DIR, "withdraw_proving_key.bin");
const OUT = join(DIR, "withdraw_proving_key.json");
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

if (!existsSync(BIN)) throw new Error("missing artifacts: run bun run --filter @altpool/prover fetch first");
if (existsSync(OUT) && statSync(OUT).mtimeMs > statSync(BIN).mtimeMs) {
  console.log(`ok   ${OUT} is newer than the bin`);
  process.exit(0);
}

const modpow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n;
  for (b %= m; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
const RINV_Q = modpow((1n << 256n) % Q, Q - 2n, Q);
const RINV_R = modpow((1n << 256n) % R, R - 2n, R);

const buf = readFileSync(BIN);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const u32 = (o: number) => view.getUint32(o, true);
const raw = (o: number) => BigInt("0x" + (Buffer.from(buf.subarray(o, o + 32)).reverse().toString("hex") || "0"));
const fq = (o: number) => ((raw(o) * RINV_Q) % Q).toString();

type G1 = string[];
type G2 = string[][];
const g1 = (o: number): G1 => (raw(o) === 0n ? ["0", "0", "0"] : [fq(o), fq(o + 32), "1"]);
const g2 = (o: number): G2 =>
  raw(o) === 0n && raw(o + 32) === 0n
    ? [["0", "0"], ["0", "0"], ["0", "0"]]
    : [[fq(o), fq(o + 32)], [fq(o + 64), fq(o + 96)], ["1", "0"]];

const [nVars, nPublic, domainSize, pPolsA, pPolsB, pPointsA, pPointsB1, pPointsB2, pPointsC, pPointsHExps] =
  Array.from({ length: 10 }, (_, i) => u32(i * 4));

const pols = (start: number) => {
  const out: Record<string, string>[] = [];
  let o = start;
  for (let s = 0; s < nVars; s++) {
    const p: Record<string, string> = {};
    const n = u32(o);
    o += 4;
    for (let k = 0; k < n; k++, o += 36) p[u32(o)] = ((raw(o + 4) * RINV_R) % R).toString();
    out.push(p);
  }
  return out;
};

const pk = {
  protocol: "groth",
  nVars,
  nPublic,
  domainBits: Math.log2(domainSize),
  domainSize,
  vk_alfa_1: g1(40),
  vk_beta_1: g1(104),
  vk_delta_1: g1(168),
  vk_beta_2: g2(232),
  vk_delta_2: g2(360),
  polsA: pols(pPolsA),
  polsB: pols(pPolsB),
  polsC: [] as Record<string, string>[],
  A: Array.from({ length: nVars }, (_, i) => g1(pPointsA + i * 64)),
  B1: Array.from({ length: nVars }, (_, i) => g1(pPointsB1 + i * 64)),
  B2: Array.from({ length: nVars }, (_, i) => g2(pPointsB2 + i * 128)),
  C: Array.from({ length: nVars }, (_, i) => (i <= nPublic ? ["0", "0", "0"] : g1(pPointsC + (i - nPublic - 1) * 64))),
  hExps: Array.from({ length: domainSize }, (_, i) => g1(pPointsHExps + i * 64)),
};

// Derive pols from the circuit exactly like snarkjs setup_groth (incl. the input_i * 0 = 0 rows in A).
type Lc = Record<string, string>;
const circuit = JSON.parse(readFileSync(join(DIR, "withdraw.json"), "utf8")) as { constraints: [Lc, Lc, Lc][]; nPubInputs: number; nOutputs: number };
const derived = [0, 1, 2].map(() => Array.from({ length: nVars }, () => ({}) as Record<string, string>));
circuit.constraints.forEach((ct, c) => ct.forEach((lc, k) => { for (const s in lc) derived[k][+s][c] = (BigInt(lc[s]) % R).toString(); }));
for (let i = 0; i < circuit.nPubInputs + circuit.nOutputs + 1; i++) derived[0][i][circuit.constraints.length + i] = "1";
pk.polsC = derived[2];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const canon = (ps: Record<string, string>[]) => ps.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "0").sort(([a], [b]) => +a - +b)));
if (!same(canon(pk.polsA), canon(derived[0]))) throw new Error("self-check: bin polsA != derived from withdraw.json");
if (!same(canon(pk.polsB), canon(derived[1]))) throw new Error("self-check: bin polsB != derived from withdraw.json");
const vk = JSON.parse(readFileSync(join(DIR, "withdraw_verification_key.json"), "utf8"));
for (const k of ["vk_alfa_1", "vk_beta_2", "vk_delta_2"] as const)
  if (!same(pk[k], vk[k])) throw new Error(`self-check: ${k} != withdraw_verification_key.json`);
if (nPublic !== vk.nPublic) throw new Error(`self-check: nPublic ${nPublic} != vk ${vk.nPublic}`);

writeFileSync(OUT, JSON.stringify(pk));
console.log(`wrote ${OUT} (nVars ${nVars}, nPublic ${nPublic}, domain ${domainSize}); self-checks passed`);
