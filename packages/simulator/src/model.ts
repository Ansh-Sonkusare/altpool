// Owner: Dev C. Local model of the sidecar's alt-mempool rules, run over ethrex's ERC-7562 trace.
// Unverified by design (source "model"): it approximates the sidecar (derisk/rules.md), it is not the sidecar.
// Covered: storage (stake needed for any non-sender storage), banned opcodes (BALANCE/SELFBALANCE ok when staked),
// out-of-gas, calls to code-less addresses, reputation, and our VERIFY gas pin.
// Not covered: associated-slot exemptions (ASSOC-*), CREATE rules, mempool-wide limits.
import { DEVNET, type Address, type EntityRole, type FrameTx, type RuleCheck, type RuleId } from "@altpool/core";

export interface Entity { role: EntityRole; address: Address; frames: number[] }
export interface StakeInfo { staked: boolean; stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }
export interface Reputation { status: "ok" | "throttled" | "banned"; opsSeen: number; opsIncluded: number }

/** One call node of ethrex's erc7562Trace (only the fields we read). */
export interface TraceCall {
  type?: string;
  to?: Address;
  outOfGas?: boolean;
  accessedSlots?: { reads?: Record<string, unknown>; writes?: Record<string, unknown>; transientReads?: Record<string, unknown>; transientWrites?: Record<string, unknown> };
  contractSize?: Record<string, { contractSize: number; opcode: number }>;
  usedOpcodes?: Record<string, number>;
  calls?: TraceCall[];
}
export interface TraceFrame { frameIndex: number; root: TraceCall }

const VERIFY = 1;
const PAYMENT_SCOPE = 0x1;
const lc = (a: string) => a.toLowerCase();

/** Validation prefix: the leading VERIFY frames. */
export const prefixFrames = (tx: FrameTx): number[] => {
  const out: number[] = [];
  for (const [i, f] of tx.frames.entries()) {
    if (f.mode !== VERIFY) break;
    out.push(i);
  }
  return out;
};

/** The entity each VERIFY frame validates for: its target (null = sender). Non-sender targets are payers. */
export const entitiesOf = (tx: FrameTx): Entity[] => {
  const byAddr = new Map<string, Entity>();
  for (const i of prefixFrames(tx)) {
    const f = tx.frames[i]!;
    const address = (f.target ?? tx.sender) as Address;
    const role: EntityRole = lc(address) === lc(tx.sender) ? "sender" : (f.flags & PAYMENT_SCOPE) ? "payer" : "sender";
    const e = byAddr.get(lc(address)) ?? { role, address, frames: [] };
    e.frames.push(i);
    byAddr.set(lc(address), e);
  }
  return [...byAddr.values()];
};

/** VERIFY gas the tx asks for: the prefix's execution limits. */
export const verifyGasOf = (tx: FrameTx): bigint =>
  prefixFrames(tx).reduce((s, i) => s + tx.frames[i]!.limits.execution, 0n);

// Sidecar banned set (frameTx.ts:68-87). GAS is listed too, but ethrex's tracer only counts a GAS not followed by *CALL.
const BANNED: Record<number, string> = {
  0x31: "BALANCE", 0x32: "ORIGIN", 0x3a: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP",
  0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x49: "BLOBHASH",
  0x4a: "BLOBBASEFEE", 0x5a: "GAS", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};
const STAKED_OK = new Set([0x31, 0x47]);
const isPrecompile = (a: string) => { const n = BigInt(a); return (n >= 1n && n <= 0x11n) || n === 0x100n; };

interface Walked { storage: Map<string, { reads: Set<string>; writes: Set<string> }>; opcodes: Set<number>; outOfGas: boolean; codeless: Set<string> }

/** Flatten a frame's call tree. DELEGATECALL/CALLCODE touch the caller's storage, not the callee's. */
const walk = (root: TraceCall): Walked => {
  const w: Walked = { storage: new Map(), opcodes: new Set(), outOfGas: false, codeless: new Set() };
  const visit = (c: TraceCall, storageOf: string) => {
    const at = c.type === "DELEGATECALL" || c.type === "CALLCODE" ? storageOf : lc(c.to ?? storageOf);
    const s = c.accessedSlots;
    const slots = (o?: Record<string, unknown>) => Object.keys(o ?? {});
    const reads = [...slots(s?.reads), ...slots(s?.transientReads)];
    const writes = [...slots(s?.writes), ...slots(s?.transientWrites)];
    if (reads.length || writes.length) {
      const e = w.storage.get(at) ?? { reads: new Set(), writes: new Set() };
      reads.forEach((x) => e.reads.add(x));
      writes.forEach((x) => e.writes.add(x));
      w.storage.set(at, e);
    }
    for (const op of Object.keys(c.usedOpcodes ?? {})) w.opcodes.add(Number(op));
    for (const [addr, info] of Object.entries(c.contractSize ?? {})) if (info.contractSize <= 2 && !isPrecompile(addr)) w.codeless.add(lc(addr));
    if (c.outOfGas) w.outOfGas = true;
    for (const child of c.calls ?? []) visit(child, at);
  };
  visit(root, lc(root.to ?? "0x0"));
  return w;
};

export interface ModelInput {
  tx: FrameTx;
  trace: TraceFrame[];
  stakes: Map<string, StakeInfo>;
  reputation: Map<string, Reputation>;
  verifyGasMax?: bigint;
}

export interface ModelFailure { rule: RuleId; entity: Entity; frameIndex?: number; detail: string }

/** Every check the model ran, and the first failure (if any). */
export const runModel = ({ tx, trace, stakes, reputation, verifyGasMax = DEVNET.verifyGasMax }: ModelInput) => {
  const checks: RuleCheck[] = [];
  let failed: ModelFailure | undefined;
  const fail = (f: ModelFailure) => {
    checks.push({ rule: f.rule, frameIndex: f.frameIndex, entity: f.entity.role, verdict: "fail", detail: f.detail });
    failed ??= f;
  };
  const sender = lc(tx.sender);
  const entities = entitiesOf(tx);

  for (const e of entities) {
    const staked = stakes.get(lc(e.address))?.staked ?? false;
    const rep = reputation.get(lc(e.address));
    if (rep?.status === "banned") fail({ rule: "mempool", entity: e, detail: `${e.role} ${e.address} is banned (seen ${rep.opsSeen}, included ${rep.opsIncluded})` });
    else checks.push({ rule: "mempool", entity: e.role, verdict: "pass", detail: rep?.status === "throttled" ? `${e.role} is throttled: at most 4 pending txs` : undefined });

    for (const i of e.frames) {
      const t = trace.find((f) => f.frameIndex === i);
      if (!t) { checks.push({ rule: "storage", frameIndex: i, entity: e.role, verdict: "skipped", detail: "no trace for this frame" }); continue; }
      const w = walk(t.root);
      const before = checks.length;

      for (const [addr, acc] of w.storage) {
        if (addr === sender) continue; // the sender's own storage is always allowed
        const own = addr === lc(e.address);
        const slot = [...acc.writes, ...acc.reads][0];
        if (!staked) fail({ rule: "storage", entity: e, frameIndex: i, detail: `unstaked ${e.role} accessed ${own ? e.role : addr} slot ${slot}` });
        else if (!own && acc.writes.size) fail({ rule: "storage", entity: e, frameIndex: i, detail: `${e.role} has forbidden write to ${addr} slot ${[...acc.writes][0]}` });
      }
      for (const op of w.opcodes) {
        const name = BANNED[op];
        if (name && !(staked && STAKED_OK.has(op))) fail({ rule: "OP-011", entity: e, frameIndex: i, detail: `${e.role} uses banned opcode: ${name}` });
      }
      if (w.outOfGas) fail({ rule: "out-of-gas", entity: e, frameIndex: i, detail: `${e.role} internally reverts on oog` });
      for (const a of w.codeless) fail({ rule: "COD-010", entity: e, frameIndex: i, detail: `${e.role} accesses un-deployed contract address ${a}` });

      if (checks.length === before) checks.push({ rule: "storage", frameIndex: i, entity: e.role, verdict: "pass" });
    }
  }

  const verifyGas = verifyGasOf(tx);
  if (verifyGas > verifyGasMax && entities[0]) fail({ rule: "gas-limit", entity: entities[0], detail: `VERIFY gas ${verifyGas} is over our ${verifyGasMax} pin` });
  else checks.push({ rule: "gas-limit", verdict: "pass", detail: `VERIFY gas ${verifyGas}` });

  return { checks, failed, entities, verifyGas };
};
