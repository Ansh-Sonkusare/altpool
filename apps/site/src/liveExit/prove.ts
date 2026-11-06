// The Groth16 withdraw proof. In the browser: websnark (wasm, one blob worker per core), fed the circuit and proving key
// from public/zk. If that throws, POST the note to the prover server (apps/site/server/prove.ts) and say so.
import bigInt from "snarkjs/src/bigint.js";
import buildGroth16 from "websnark/src/groth16.js";
import utils from "websnark/src/utils.js";
import type { Address, Hex, Note, WithdrawProof } from "@altpool/core";
import type { MerklePath } from "@altpool/prover";
import { noteToString } from "./note";

export const PROVE_URL: string = import.meta.env.VITE_PROVE_URL ?? "http://localhost:8787/prove";

export type Proved = { proof: WithdrawProof & { rootIdx: number }; via: "browser" | "server"; loadMs: number; proveMs: number };
type To = { recipient: Address; relayer: Address; fee: bigint };

// snarkjs eval()s the circuit's templates, which name bigInt, __P__ and __MASK__ from snarkjs's own module scope. A
// minified production build renames those, so also publish them as globals, where the eval'd code finds them by name.
// Same values as snarkjs/src/circuit.js.
Object.assign(globalThis, {
  bigInt,
  __P__: bigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617"),
  __MASK__: bigInt("28948022309329048855892746252171976963317496166410141009864396001978282409983"),
});

const fetchGz = async (name: string): Promise<ArrayBuffer> => {
  const res = await fetch(`${import.meta.env.BASE_URL}zk/${name}.gz`);
  if (!res.ok) throw new Error(`zk/${name}.gz: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const gz = new Uint8Array(buf, 0, 2);
  // Some hosts decode a .gz for us; only inflate what is still gzip.
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
};

const inBrowser = async (note: Note, path: MerklePath, to: To): Promise<Proved> => {
  let t = performance.now();
  const [circuit, pk] = await Promise.all([
    fetchGz("withdraw.json").then((b) => JSON.parse(new TextDecoder().decode(b)) as unknown),
    fetchGz("withdraw_proving_key.bin"),
  ]);
  const input = {
    root: BigInt(path.root).toString(),
    nullifierHash: BigInt(note.nullifierHash).toString(),
    recipient: BigInt(to.recipient).toString(),
    relayer: BigInt(to.relayer).toString(),
    fee: to.fee.toString(),
    refund: "0",
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
    pathElements: path.pathElements.map(String),
    pathIndices: path.pathIndices.map(String),
  };
  const loadMs = performance.now() - t;
  t = performance.now();
  const groth16 = await buildGroth16();
  try {
    const p = await utils.genWitnessAndProve(groth16, input, circuit, pk);
    // The circuit's public inputs must be the ones we meant: a mismatch would fail the on-chain verifier.
    const want = [input.root, input.nullifierHash, input.recipient, input.relayer, input.fee, input.refund];
    if (want.some((w, i) => p.publicSignals[i] !== w)) throw new Error("witness public signals differ from the inputs");
    return {
      proof: { proof: utils.toSolidityInput(p).proof, root: path.root, nullifierHash: note.nullifierHash, recipient: to.recipient, relayer: to.relayer, fee: to.fee, refund: 0n, rootIdx: path.rootIdx },
      via: "browser", loadMs, proveMs: performance.now() - t,
    };
  } finally {
    groth16.terminate();
  }
};

const viaServer = async (note: Note, to: To): Promise<Proved> => {
  const t = performance.now();
  const res = await fetch(PROVE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: noteToString(note), recipient: to.recipient }) });
  const body = (await res.json()) as { error?: string; proof: Hex; root: Hex; nullifierHash: Hex; recipient: Address; relayer: Address; fee: string; refund: string; rootIdx: number };
  if (!res.ok) throw new Error(body.error ?? `prover server: HTTP ${res.status}`);
  return { proof: { ...body, fee: BigInt(body.fee), refund: BigInt(body.refund) }, via: "server", loadMs: 0, proveMs: performance.now() - t };
};

/** onFallback is told why the browser prover failed before the server is tried. The server proves for ExitRelay only,
 *  so a caller proving for another relay passes serverFallback = false and gets the browser error. */
export const prove = async (note: Note, path: MerklePath, to: To, onFallback: (why: string) => void, serverFallback = true): Promise<Proved> => {
  try {
    return await inBrowser(note, path, to);
  } catch (e) {
    if (!serverFallback) throw e;
    onFallback(e instanceof Error ? e.message : String(e));
    return viaServer(note, to);
  }
};
