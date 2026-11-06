// Owner: Dev C. Plays the ERC-8421 conformance vectors (conformance/NOTICE.md) against our local rule model.
// Each vector tx is translated into what the model sees in production: the FrameTx, and an ethrex-style ERC-7562 trace
// (storage reads and writes with keccak preimages for associated slots, opcodes, call targets with code size, OOG).
// Verdicts per tx: agree, differ (a finding about our model or the devnet's rules), or not modelled (pool-level rules:
// replacement, lifecycle, reputation, solvency; and the shape/signature/expiry checks ethrex does before tracing).
import { readdirSync, readFileSync } from "node:fs";
import { concat, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { DEVNET, type FrameTx, type RuleId } from "@altpool/core";
import { EXPIRY_VERIFIER, runModel, type StakeInfo, type TraceCall, type TraceFrame } from "./model";

export const VECTORS_DIR = new URL("../conformance/erc-8421/", import.meta.url);
const DESCRIPTOR = new URL("../conformance/erc-8421-descriptor.json", import.meta.url);

/** Files whose cases test pool behaviour over time (replacement, lifecycle, reputation, solvency, blame): not our model. */
const POOL_LEVEL = /^am-(02|10|11|12|13|14|16)-/;
const VECTOR_EXPIRY = "0x81413f0cf12e9b6a49b1d0439e081c577d57ffff";

/** Where our model follows the devnet sidecar, which differs from ERC-8421 (research repo derisk/rules.md). */
const KNOWN_DEVNET_GAPS = [
  { match: /canonical paymaster/, note: "the devnet sidecar has no canonical-paymaster exemption (isCanonicalPaymaster has no caller); we follow the sidecar" },
  { match: /unassigned opcode/, note: "the devnet sidecar does not block unassigned opcodes (OPCODES-030); we follow the sidecar" },
];

/** Our model's rule -> the vectors' error name. */
const CODE: Partial<Record<RuleId | "simulation", string>> = {
  storage: "ErrFrameStorageAccess", "OP-011": "ErrFrameBannedOpcode", "out-of-gas": "ErrFrameOutOfGasRevert",
  "COD-010": "ErrFrameCallTarget", "gas-limit": "ErrEntityVerifyGas", mempool: "ErrEntityBanned", simulation: "ErrFramePrefixReverted",
};
/** Expected errors inside what our model decides. Anything else is "not modelled". */
const MODELLED = new Set(["ok", ...Object.values(CODE), "ErrFrameUnassignedOpcode"]);

const OPCODES: Record<string, number> = {
  BALANCE: 0x31, ORIGIN: 0x32, GASPRICE: 0x3a, BLOCKHASH: 0x40, COINBASE: 0x41, TIMESTAMP: 0x42, NUMBER: 0x43, PREVRANDAO: 0x44,
  DIFFICULTY: 0x44, GASLIMIT: 0x45, SELFBALANCE: 0x47, BASEFEE: 0x48, BLOBHASH: 0x49, BLOBBASEFEE: 0x4a, SLOAD: 0x54, SSTORE: 0x55,
  GAS: 0x5a, TLOAD: 0x5c, TSTORE: 0x5d, CREATE: 0xf0, CALL: 0xf1, CALLCODE: 0xf2, DELEGATECALL: 0xf4, CREATE2: 0xf5,
  STATICCALL: 0xfa, INVALID: 0xfe, SELFDESTRUCT: 0xff, UNASSIGNED: 0x0c,
};

interface VFrame {
  mode: number; flags?: number; target?: string; exec_gas?: number; state_gas?: number; approves?: number | null;
  reads?: [string, number, unknown, string?][]; writes?: [string, number, unknown, string?][];
  opcodes?: string[]; calls?: string[]; reverts?: boolean; installs_code?: string; data_size?: number; deadline?: number;
}
interface VTx { label?: string; sender: string; nonce_seq?: number; frames: VFrame[]; signatures?: { scheme: string }[] }
const SCHEME: Record<string, number> = { arbitrary: 0, secp256k1: 1, p256: 2 };
interface VAccount { balance?: number | string; code?: string; stake?: number | string; unstake_delay?: number; withdrawing?: boolean }
interface VCase { name: string; state?: Record<string, VAccount>; steps: Record<string, any>[] }

export type CaseStatus = "agree" | "differ" | "not modelled";
export interface CaseResult { file: string; name: string; tx: number; expected: string; ours: string; status: CaseStatus; note?: string }
export interface FileSummary { file: string; agree: number; differ: number; notModelled: number }
export interface ConformanceReport { results: CaseResult[]; files: FileSummary[]; totals: FileSummary; descriptor: { minStake: bigint; minUnstakeDelay: number } }

const addrOf = (label: string): Address =>
  (/^0x[0-9a-fA-F]{40}$/.test(label) ? label.toLowerCase() : `0x${keccak256(toHex(label)).slice(-40)}`) as Address;

/** A slot index, or the slot of `index` in a mapping keyed by `assoc`: keccak(pad32(assoc) ‖ pad32(index)), with its preimage. */
const slotOf = (index: number, assoc?: string): { slot: string; preimage?: Hex } => {
  if (!assoc) return { slot: pad(toHex(index), { size: 32 }) };
  const preimage = concat([pad(addrOf(assoc), { size: 32 }), pad(toHex(index), { size: 32 })]);
  return { slot: keccak256(preimage), preimage };
};

/** One vector tx -> the FrameTx and trace our model reads, plus whether any prefix frame reverts. */
const translate = (vtx: VTx, state: Record<string, VAccount>) => {
  const hasCode = (label: string) => Boolean(state[label]?.code) || vtx.frames.some((f) => f.installs_code && label === vtx.sender);
  const tx = {
    chainId: BigInt(DEVNET.chainId), nonceKeys: [0n], nonceSeq: BigInt(vtx.nonce_seq ?? 0), sender: addrOf(vtx.sender),
    frames: vtx.frames.map((f) => ({
      mode: f.mode, flags: (f.flags ?? 0) | (f.approves ?? 0),
      target: f.target ? (addrOf(f.target) === VECTOR_EXPIRY ? (EXPIRY_VERIFIER as Address) : addrOf(f.target)) : null,
      limits: { execution: BigInt(f.exec_gas ?? 0), state: BigInt(f.state_gas ?? 0) }, value: 0n, data: "0x" as Hex,
    })),
    signatures: (vtx.signatures ?? []).map((x) => ({ scheme: SCHEME[x.scheme.toLowerCase()] ?? 1, signer: "0x" as Hex, msg: "0x" as Hex, signature: "0x" as Hex })), fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 0n }, blobVersionedHashes: [], recentRootReferences: [],
  } as FrameTx;

  let reverts = false;
  // Storage written so far in this tx, so a read that expects a value nobody wrote fails (the frame would revert).
  const written = new Map<string, unknown>();
  const trace: TraceFrame[] = vtx.frames.map((f, frameIndex) => {
    for (const [label, index, value, assoc] of f.reads ?? []) {
      if (value === null || value === undefined) continue;
      if (written.get(`${addrOf(label)}:${slotOf(index, assoc).slot}`) !== value) reverts = true;
    }
    for (const [label, index, value, assoc] of f.writes ?? []) written.set(`${addrOf(label)}:${slotOf(index, assoc).slot}`, value);
    const execLabel = f.target ?? vtx.sender;
    const exec = addrOf(execLabel);
    // VERIFY frames run static: a write reverts the frame. A frame that says it reverts, reverts.
    if (f.reverts || (f.mode === 1 && f.writes?.length)) reverts = true;
    // Default code (an account with no code) is not traced: its observations are not the entity's.
    if (!hasCode(execLabel) || addrOf(execLabel) === VECTOR_EXPIRY) return { frameIndex, root: { type: "CALL", to: exec } };
    const root: TraceCall = { type: "CALL", to: exec, accessedSlots: { reads: {}, writes: {} }, usedOpcodes: {}, contractSize: {}, keccak: [], calls: [] };
    const nodeFor = (label: string): TraceCall => {
      const a = addrOf(label);
      if (a === exec) return root;
      let c = root.calls!.find((x) => x.to === a);
      if (!c) { c = { type: "STATICCALL", to: a, accessedSlots: { reads: {}, writes: {} } }; root.calls!.push(c); }
      return c;
    };
    for (const [label, index, , assoc] of f.reads ?? []) {
      const { slot, preimage } = slotOf(index, assoc);
      nodeFor(label).accessedSlots!.reads![slot] = ["0x0"];
      if (preimage) root.keccak!.push(preimage);
    }
    for (const [label, index, , assoc] of f.writes ?? []) {
      const { slot, preimage } = slotOf(index, assoc);
      nodeFor(label).accessedSlots!.writes![slot] = 1;
      if (preimage) root.keccak!.push(preimage);
    }
    for (const name of f.opcodes ?? []) {
      if (name === "OOG_REVERT") root.outOfGas = true;
      else if (OPCODES[name] !== undefined) root.usedOpcodes![String(OPCODES[name])] = 1;
    }
    for (const label of f.calls ?? []) root.contractSize![addrOf(label)] = { contractSize: hasCode(label) ? 100 : 0, opcode: 0xf1 };
    return { frameIndex, root };
  });
  return { tx, trace, reverts };
};

const loadDescriptor = () => {
  const d = JSON.parse(readFileSync(DESCRIPTOR, "utf8"));
  const find = (k: string): any => JSON.stringify(d).match(new RegExp(`"${k}":"?(\\d+)`))?.[1];
  return { minStake: BigInt(find("min_stake_value") ?? "1000000000000000000"), minUnstakeDelay: Number(find("min_unstake_delay") ?? 86400) };
};

/** Run every vector file in `dir` against the model. */
export const runConformance = (dir: URL | string = VECTORS_DIR, o: { verifyGasMax?: bigint; budget?: "pin" | "erc-8421" } = {}): ConformanceReport => {
  const descriptor = loadDescriptor();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const results: CaseResult[] = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(new URL(file, typeof dir === "string" ? `file://${dir.replace(/\/?$/, "/")}` : dir), "utf8"));
    for (const c of doc.cases as VCase[]) {
      const state = c.state ?? {};
      const stakes = new Map<string, StakeInfo>(Object.entries(state).map(([label, a]) => {
        const stake = BigInt(a.stake ?? 0), delay = Number(a.unstake_delay ?? 0);
        return [addrOf(label), { stake, unstakeDelaySec: delay, withdrawTime: a.withdrawing ? 1n : 0n, hasCode: Boolean(a.code), staked: stake >= descriptor.minStake && delay >= descriptor.minUnstakeDelay && !a.withdrawing }];
      }));
      const timeBased = c.steps.some((s) => s.reputation || s.tick || s.reset);
      for (const step of c.steps) {
        if (!step.add) continue;
        (step.add as VTx[]).forEach((vtx, i) => {
          const expected = String(step.expect?.[i] ?? "ok");
          const base = { file, name: c.name, tx: i, expected };
          if (POOL_LEVEL.test(file) || timeBased) return results.push({ ...base, ours: "—", status: "not modelled", note: "pool rule (replacement, lifecycle, reputation, solvency)" });
          if (!MODELLED.has(expected)) return results.push({ ...base, ours: "—", status: "not modelled", note: "checked by ethrex before tracing (shape, signature, expiry, creation)" });
          const { tx, trace, reverts } = translate(vtx, state);
          let ours = "ok";
          if (reverts) ours = CODE.simulation!;
          else {
            const m = runModel({ tx, trace, stakes, reputation: new Map(), verifyGasMax: o.verifyGasMax, budget: o.budget ?? "erc-8421" });
            if (m.failed) ours = CODE[m.failed.rule] ?? m.failed.rule;
          }
          results.push({ ...base, ours, status: ours === expected ? "agree" : "differ", note: KNOWN_DEVNET_GAPS.find((g) => g.match.test(c.name))?.note });
        });
      }
    }
  }
  const summarize = (rs: CaseResult[], file: string): FileSummary => ({
    file, agree: rs.filter((r) => r.status === "agree").length, differ: rs.filter((r) => r.status === "differ").length,
    notModelled: rs.filter((r) => r.status === "not modelled").length,
  });
  return { results, files: files.map((f) => summarize(results.filter((r) => r.file === f), f)), totals: summarize(results, "total"), descriptor };
};
