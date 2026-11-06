// Owner: Dev C. Local model of the sidecar's alt-mempool rules, run over ethrex's ERC-7562 trace.
// Unverified by design (source "model"): it approximates the sidecar (derisk/rules.md), it is not the sidecar.
// Covered: storage (stake needed for any non-sender storage), banned opcodes (BALANCE/SELFBALANCE ok when staked),
// out-of-gas, calls to code-less addresses, reputation, and our VERIFY gas pin.
// Not covered: associated-slot exemptions (ASSOC-*), CREATE rules, mempool-wide limits.
import { keccak256 } from "viem";
import { DEVNET, type Address, type EntityRole, type FrameTx, type Hex, type RuleCheck, type RuleId } from "@altpool/core";

export interface Entity { role: EntityRole; address: Address; frames: number[] }
/** hasCode: false marks a default-code account (no code), which ERC-8421 never counts as staked, whatever it deposited. */
export interface StakeInfo { staked: boolean; stake: bigint; unstakeDelaySec: number; withdrawTime: bigint; hasCode?: boolean }
/** Staked for the rules: a registry stake on an account that has code. */
export const isStaked = (s?: StakeInfo) => Boolean(s?.staked && s.hasCode !== false);
export interface Reputation { status: "ok" | "throttled" | "banned"; opsSeen: number; opsIncluded: number }

/** One call node of ethrex's erc7562Trace (only the fields we read). */
export interface TraceCall {
  type?: string;
  to?: Address;
  outOfGas?: boolean;
  accessedSlots?: { reads?: Record<string, unknown>; writes?: Record<string, unknown>; transientReads?: Record<string, unknown>; transientWrites?: Record<string, unknown> };
  contractSize?: Record<string, { contractSize: number; opcode: number }>;
  usedOpcodes?: Record<string, number>;
  /** keccak256 preimages hashed in this call: how a slot is recognised as associated with an address. */
  keccak?: string[];
  calls?: TraceCall[];
}
export interface TraceFrame { frameIndex: number; root: TraceCall }

const VERIFY = 1;
const SENDER = 2;
const PAYMENT_SCOPE = 0x1;
/** The protocol's deadline check (expiry_verify). It may read TIMESTAMP and is no entity: skip it. */
export const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141";
const lc = (a: string) => a.toLowerCase();

/** Validation prefix: the leading VERIFY frames. */
/** Validation prefix: every frame up to the last VERIFY frame before the first SENDER frame. DEFAULT frames in it are
 *  pre_verify frames or, first, a deploy frame (the sidecar's prefix shapes, validationPrefix.ts; ERC-8421 PREFIX-010). */
export const prefixFrames = (tx: FrameTx): number[] => {
  let last = -1;
  for (const [i, f] of tx.frames.entries()) {
    if (f.mode === SENDER) break;
    if (f.mode === VERIFY) last = i;
  }
  return Array.from({ length: last + 1 }, (_, i) => i);
};

/** The entities of the validation prefix. A VERIFY frame validates for its target (null = sender); a non-sender target
 *  that approves payment is the payer. A pre_verify DEFAULT frame belongs to the entity it targets; a DEFAULT frame whose
 *  target is no other entity is the deploy frame, and its target is the factory. */
export const entitiesOf = (tx: FrameTx): Entity[] => {
  const byAddr = new Map<string, Entity>();
  const sender = lc(tx.sender);
  const prefix = prefixFrames(tx);
  const add = (address: string, role: EntityRole, i: number) => {
    const e = byAddr.get(lc(address)) ?? { role, address: address as Address, frames: [] };
    e.frames.push(i);
    byAddr.set(lc(address), e);
  };
  for (const i of prefix) {
    const f = tx.frames[i]!;
    if (f.mode !== VERIFY || (f.target && lc(f.target) === EXPIRY_VERIFIER)) continue;
    const address = f.target ?? tx.sender;
    add(address, lc(address) === sender ? "sender" : (f.flags & PAYMENT_SCOPE) ? "payer" : "sender", i);
  }
  for (const i of prefix) {
    const f = tx.frames[i]!;
    if (f.mode === VERIFY) continue;
    const address = f.target ?? tx.sender;
    if (lc(address) === sender) add(address, "sender", i);
    else if (byAddr.has(lc(address))) add(address, byAddr.get(lc(address))!.role, i);
    else add(address, "factory", i);
  }
  for (const e of byAddr.values()) e.frames.sort((a, b) => a - b);
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

interface Walked {
  storage: Map<string, { reads: Set<string>; writes: Set<string> }>;
  opcodes: Set<number>;
  outOfGas: boolean;
  codeless: Set<string>;
  /** keccak bases by the address their preimage starts with (sidecar utils.ts:82-105, ERC-8421 ASSOC-020). */
  bases: Map<string, bigint[]>;
}

/** Flatten a frame's call tree. DELEGATECALL/CALLCODE touch the caller's storage, not the callee's. */
const walk = (root: TraceCall): Walked => {
  const w: Walked = { storage: new Map(), opcodes: new Set(), outOfGas: false, codeless: new Set(), bases: new Map() };
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
    for (const pre of c.keccak ?? []) {
      // A preimage starting with a left-padded address: keccak(pad32(A) ‖ x) and the 128 slots after it belong to A.
      if (pre.length < 2 + 64 || !/^0x0{24}/i.test(pre)) continue;
      const a = `0x${pre.slice(26, 66)}`.toLowerCase();
      const list = w.bases.get(a) ?? [];
      list.push(BigInt(keccak256(pre as Hex)));
      w.bases.set(a, list);
    }
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
  /** "pin" (default): our per-entity verifyGasMax. "erc-8421": BUDGET-010, 100k per unstaked entity and 1M per staked
   *  one, with signature verification counted against the sender. */
  budget?: "pin" | "erc-8421";
}

/** Signature verification cost by scheme (sidecar validationPrefix.ts:24-28): ARBITRARY, SECP256K1, P256. */
const SIG_COST: Record<number, bigint> = { 0: 100n, 1: 2800n, 2: 6700n };

export interface ModelFailure { rule: RuleId; entity: Entity; frameIndex?: number; detail: string }

/** Every check the model ran, and the first failure (if any). */
export const runModel = ({ tx, trace, stakes, reputation, verifyGasMax = DEVNET.verifyGasMax, budget = "pin" }: ModelInput) => {
  const checks: RuleCheck[] = [];
  let failed: ModelFailure | undefined;
  const fail = (f: ModelFailure) => {
    checks.push({ rule: f.rule, frameIndex: f.frameIndex, entity: f.entity.role, verdict: "fail", detail: f.detail });
    failed ??= f;
  };
  const sender = lc(tx.sender);
  const entities = entitiesOf(tx);

  for (const e of entities) {
    const staked = isStaked(stakes.get(lc(e.address)));
    const rep = reputation.get(lc(e.address));
    if (rep?.status === "banned") fail({ rule: "mempool", entity: e, detail: `${e.role} ${e.address} is banned (seen ${rep.opsSeen}, included ${rep.opsIncluded})` });
    else checks.push({ rule: "mempool", entity: e.role, verdict: "pass", detail: rep?.status === "throttled" ? `${e.role} is throttled: at most 4 pending txs` : undefined });

    for (const i of e.frames) {
      const t = trace.find((f) => f.frameIndex === i);
      if (!t) { checks.push({ rule: "storage", frameIndex: i, entity: e.role, verdict: "skipped", detail: "no trace for this frame" }); continue; }
      const w = walk(t.root);
      const before = checks.length;

      // Storage, slot by slot (sidecar frameTx.ts:740-808; ERC-8421 STORAGE-010..033):
      //   the sender's own storage: always; a slot associated with the sender, outside an entity's contract: always;
      //   staked: any read, writes to its own storage or to slots associated with itself; otherwise rejected.
      const assoc = (slot: string, a: string) => {
        const v = BigInt(slot), key = lc(a);
        if (v === BigInt(key)) return true;
        return (w.bases.get(key) ?? []).some((b) => v >= b && v - b < 128n);
      };
      const entityContracts = new Set(entities.map((x) => lc(x.address)).filter((x) => x !== sender));
      // With a deploy frame, slots associated with the (new) sender are only usable when the factory is staked.
      const factory = entities.find((x) => x.role === "factory");
      const senderAssocOk = !factory || isStaked(stakes.get(lc(factory.address)));
      for (const [addr, acc] of w.storage) {
        if (addr === sender) continue;
        const own = addr === lc(e.address);
        for (const [slot, write] of [...[...acc.writes].map((x) => [x, true] as const), ...[...acc.reads].filter((x) => !acc.writes.has(x)).map((x) => [x, false] as const)]) {
          if (senderAssocOk && assoc(slot, sender) && !entityContracts.has(addr)) continue;
          if (!staked) { fail({ rule: "storage", entity: e, frameIndex: i, detail: `unstaked ${e.role} accessed ${own ? e.role : addr} slot ${slot}` }); break; }
          if (write && !own && !assoc(slot, e.address)) { fail({ rule: "storage", entity: e, frameIndex: i, detail: `${e.role} has forbidden write to ${addr} slot ${slot}` }); break; }
        }
      }
      for (const op of w.opcodes) {
        const name = BANNED[op];
        if (name && !(staked && STAKED_OK.has(op))) fail({ rule: "OP-011", entity: e, frameIndex: i, detail: `${e.role} uses banned opcode: ${name}` });
      }
      if (w.outOfGas) fail({ rule: "out-of-gas", entity: e, frameIndex: i, detail: `${e.role} internally reverts on oog` });
      // The sender may be called with no code (an EOA sender): the sidecar exempts it (frameTx.ts:810-827), so does ERC-8421.
      for (const a of w.codeless) if (a !== sender) fail({ rule: "COD-010", entity: e, frameIndex: i, detail: `${e.role} accesses un-deployed contract address ${a}` });

      if (checks.length === before) checks.push({ rule: "storage", frameIndex: i, entity: e.role, verdict: "pass" });
    }
  }

  // Budgets are per entity (ERC-8421 BUDGET-010). Ours is a pin; in erc-8421 mode, 100k unstaked / 1M staked, and the
  // sender carries the signature checks.
  const sigCost = tx.signatures.reduce((s, x) => s + (SIG_COST[x.scheme] ?? 0n), 0n);
  for (const e of entities) {
    const staked = isStaked(stakes.get(lc(e.address)));
    const gas = e.frames.reduce((s, i) => s + tx.frames[i]!.limits.execution, 0n) + (budget === "erc-8421" && e.role === "sender" ? sigCost : 0n);
    const cap = budget === "erc-8421" ? (staked ? 1_000_000n : 100_000n) : verifyGasMax;
    const what = budget === "erc-8421" ? `the ${staked ? "staked" : "unstaked"} budget ${cap}` : `our ${cap} pin`;
    if (gas > cap) fail({ rule: "gas-limit", entity: e, detail: `${e.role} VERIFY gas ${gas} is over ${what}` });
    else checks.push({ rule: "gas-limit", entity: e.role, verdict: "pass", detail: `${e.role} VERIFY gas ${gas}` });
  }

  return { checks, failed, entities, verifyGas: verifyGasOf(tx) };
};

// ---------------------------------------------------------------- where it failed

/** The opcodes ethrex's public-mempool validation bans (vm.rs:4246-4270); TIMESTAMP is allowed only in the expiry verifier. */
const PUBLIC_BANNED: Record<number, string> = {
  0x32: "ORIGIN", 0x3a: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT",
  0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE", 0x4b: "SLOTNUM", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
  0x31: "BALANCE", 0x47: "SELFBALANCE", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x42: "TIMESTAMP",
};

export interface Location { frameIndex: number; contract: string; what: string }
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const describeLocation = (l: Location) => `frame ${l.frameIndex}: ${short(l.contract)} ${l.what}`;

/** Each call node of each validation frame, with the address whose storage it touches. */
const eachCall = function* (tx: FrameTx, trace: TraceFrame[]) {
  for (const i of prefixFrames(tx)) {
    const t = trace.find((f) => f.frameIndex === i);
    if (!t) continue;
    const stack: { c: TraceCall; storageOf: string }[] = [{ c: t.root, storageOf: lc(t.root.to ?? "0x0") }];
    while (stack.length) {
      const { c, storageOf } = stack.pop()!;
      const at = c.type === "DELEGATECALL" || c.type === "CALLCODE" ? storageOf : lc(c.to ?? storageOf);
      yield { frameIndex: i, frame: tx.frames[i]!, call: c, at };
      for (const child of [...(c.calls ?? [])].reverse()) stack.push({ c: child, storageOf: at });
    }
  }
};

/** The first storage access outside the sender's own storage (what the public mempool's StorageReadNonSender means). */
export const locateForeignStorage = (tx: FrameTx, trace: TraceFrame[]): Location | undefined => {
  const sender = lc(tx.sender);
  for (const { frameIndex, frame, call, at } of eachCall(tx, trace)) {
    if (at === sender || (frame.target && lc(frame.target) === EXPIRY_VERIFIER)) continue;
    const s = call.accessedSlots;
    const writes = Object.keys(s?.writes ?? {}), reads = Object.keys(s?.reads ?? {});
    const tw = Object.keys(s?.transientWrites ?? {}), tr = Object.keys(s?.transientReads ?? {});
    const hit = writes[0] ? ["writes", writes[0]] : reads[0] ? ["reads", reads[0]] : tw[0] ? ["writes transient", tw[0]] : tr[0] ? ["reads transient", tr[0]] : undefined;
    if (hit) return { frameIndex, contract: call.to ?? at, what: `${hit[0]} ${at === lc(call.to ?? "") ? "its own storage" : short(at)} slot ${hit[1]}` };
  }
  return undefined;
};

/** The first opcode the public mempool bans, and the contract that ran it. */
export const locateBannedOpcode = (tx: FrameTx, trace: TraceFrame[]): Location | undefined => {
  for (const { frameIndex, frame, call, at } of eachCall(tx, trace)) {
    const expiry = frame.target && lc(frame.target) === EXPIRY_VERIFIER;
    for (const op of Object.keys(call.usedOpcodes ?? {}).map(Number)) {
      const name = PUBLIC_BANNED[op];
      if (name && !(op === 0x42 && expiry)) return { frameIndex, contract: call.to ?? at, what: `uses ${name}` };
    }
  }
  return undefined;
};

/** The validation frames' declared gas against a cap, e.g. "frames 0+1 declare 460,000 gas (cap 100,000)". */
export const describeVerifyGas = (tx: FrameTx, cap: bigint) => {
  const idx = prefixFrames(tx);
  const sum = idx.reduce((s, i) => s + tx.frames[i]!.limits.execution, 0n);
  return `frame${idx.length > 1 ? "s" : ""} ${idx.join("+")} declare${idx.length > 1 ? "" : "s"} ${sum.toLocaleString("en-US")} VERIFY gas (cap ${cap.toLocaleString("en-US")})`;
};
