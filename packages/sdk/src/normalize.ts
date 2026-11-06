// Parsers for every sidecar / ethrex reply the SDK uses. Shapes are taken from live replies (chain 1337,
// sidecar v4.1.1), not the docs. Each normalized object keeps `raw` so nothing is lost.
import type { Address, EntityRole, Hex, RuleId, TxStatus } from "@altpool/core";
import type { FrameTx } from "@forshtat/hegota-support/tx";

export const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v !== "") return BigInt(v);
  throw new TypeError(`not a quantity: ${JSON.stringify(v)}`);
};
const bigOr = (v: unknown, d?: bigint): bigint | undefined => (v === null || v === undefined || v === "" ? d : big(v));
const num = (v: unknown): number => Number(big(v));
const numOr = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : num(v));

export const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
export const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
export const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export function assertAddress(v: unknown, what = "address"): asserts v is Address {
  if (!isAddress(v)) throw new TypeError(`${what} must be a 20-byte 0x address, got ${JSON.stringify(v)}`);
}
export function assertHash(v: unknown, what = "hash"): asserts v is Hex {
  if (!isHash(v)) throw new TypeError(`${what} must be a 32-byte 0x hash, got ${JSON.stringify(v)}`);
}

/** Identity of the node a node-local answer (reputation, admissions, status) came from. */
export interface NodeIdentity { name: string; url: string; version?: string; bootId?: string; chainId?: number }

// ---------------------------------------------------------------- config / info

export interface SidecarConfig {
  chainId: number;
  entryPoints: Address[];
  canonicalEntryPoint?: Address;
  relayers: Address[];
  minStake: bigint;
  minUnstakeDelaySec: number;
  stakingRegistry?: Address;
  reputation: { minInclusionDenominator: number; throttlingSlack: number; banSlack: number };
  validationGasLimit?: bigint;
  /** Per-tx total frame gas cap (`userOpGasLimit`). */
  txGasLimit?: bigint;
  precompiles: Address[];
  standardMempoolId?: string;
  supportedMempools: { mempoolId: string; entryPoint: Address }[];
  flags: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export function parseConfig(r: any): SidecarConfig {
  return {
    chainId: num(r.chainId),
    entryPoints: r.entryPoints ?? [],
    canonicalEntryPoint: r.canonicalEntryPoint,
    relayers: r.relayers ?? [],
    minStake: big(r.minStake ?? 0),
    minUnstakeDelaySec: num(r.minUnstakeDelay ?? 0),
    stakingRegistry: isAddress(r.stakingRegistryAddress) ? r.stakingRegistryAddress : undefined,
    reputation: { minInclusionDenominator: num(r.minInclusionDenominator), throttlingSlack: num(r.throttlingSlack), banSlack: num(r.banSlack) },
    validationGasLimit: bigOr(r.validationGasLimit),
    txGasLimit: bigOr(r.userOpGasLimit),
    precompiles: r.precompiles ?? [],
    standardMempoolId: r.standardMempoolId,
    supportedMempools: r.supportedMempools ?? [],
    flags: r.flags ?? {},
    raw: r,
  };
}

export interface ExplorerInfo {
  protocolVersion: number;
  chainId: number;
  version: string;
  commit: string;
  bundlingMode: string;
  p2pEnabled: boolean;
  latestSeq: number;
  oldestSeq: number;
  historyCapacity: number;
  bootId: string;
  faucetEnabled: boolean;
  reputation?: { minInclusionDenominator: number; throttlingSlack: number; banSlack: number };
  raw: Record<string, unknown>;
}

export const parseExplorerInfo = (r: any): ExplorerInfo => ({
  protocolVersion: num(r.protocolVersion ?? 0),
  chainId: num(r.chainId),
  version: String(r.version ?? ""),
  commit: String(r.commit ?? ""),
  bundlingMode: String(r.bundlingMode ?? ""),
  p2pEnabled: !!r.p2pEnabled,
  latestSeq: num(r.latestSeq ?? 0),
  oldestSeq: num(r.oldestSeq ?? 0),
  historyCapacity: num(r.historyCapacity ?? 0),
  bootId: String(r.bootId ?? ""),
  faucetEnabled: !!r.faucetEnabled,
  reputation: r.minInclusionDenominator === undefined ? undefined : { minInclusionDenominator: num(r.minInclusionDenominator), throttlingSlack: num(r.throttlingSlack), banSlack: num(r.banSlack) },
  raw: r,
});

export interface GasPrice { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
export const parseGasPrice = (r: any): GasPrice => ({ maxFeePerGas: big(r.maxFeePerGas), maxPriorityFeePerGas: big(r.maxPriorityFeePerGas) });

// ---------------------------------------------------------------- transactions

/** Inverse of hegota-support `toWire`, tolerant of the sidecar's echo (it hex-encodes `mode`, `flags`, `scheme`). */
export function fromWire(w: any): FrameTx {
  return {
    chainId: big(w.chainId),
    nonceKeys: (w.nonceKeys ?? []).map(big),
    nonceSeq: big(w.nonceSeq ?? w.nonce ?? 0),
    sender: w.sender,
    frames: (w.frames ?? []).map((f: any) => ({
      mode: num(f.mode),
      flags: num(f.flags ?? 0),
      target: f.target ?? null,
      limits: { execution: big(f.limits?.execution ?? 0), state: big(f.limits?.state ?? 0) },
      value: big(f.value ?? 0),
      data: f.data ?? "0x",
    })),
    signatures: (w.signatures ?? []).map((s: any) => ({ scheme: num(s.scheme), signer: s.signer ?? "0x", msg: s.msg ?? "0x", signature: s.signature ?? "0x" })),
    fees: { maxPriorityFeePerGas: big(w.fees?.maxPriorityFeePerGas ?? 0), maxFeePerGas: big(w.fees?.maxFeePerGas ?? 0), maxFeePerBlobGas: big(w.fees?.maxFeePerBlobGas ?? 0) },
    blobVersionedHashes: w.blobVersionedHashes ?? [],
    recentRootReferences: (w.recentRootReferences ?? []).map((r: any) => ({ sourceId: r.sourceId, slot: big(r.slot), root: r.root })),
  };
}

export interface FrameGasEstimate {
  frames: { execution: bigint; state: bigint }[];
  cumulativeGasUsed: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  raw: unknown;
}
export const parseEstimate = (r: any): FrameGasEstimate => ({
  frames: (r.frames ?? []).map((f: any) => ({ execution: big(f.execution ?? 0), state: big(f.state ?? 0) })),
  cumulativeGasUsed: big(r.cumulativeGasUsed ?? 0),
  maxFeePerGas: big(r.maxFeePerGas ?? 0),
  maxPriorityFeePerGas: big(r.maxPriorityFeePerGas ?? 0),
  raw: r,
});

export const TX_STATUSES: readonly TxStatus[] = ["New", "Pending", "Submitted", "OnChain", "Finalized", "Cancelled", "Reverted"];
export const FINAL_STATUSES: readonly TxStatus[] = ["OnChain", "Finalized", "Cancelled", "Reverted"];

export interface FrameTxStatus {
  hash: Hex;
  status: TxStatus;
  sender: Address;
  payer?: Address;
  factory?: Address;
  /** Hash of the on-chain transaction that included it (set once submitted). */
  transaction?: Hex;
  reason?: string;
  tx?: FrameTx;
  node: NodeIdentity;
  raw: unknown;
}
export const parseStatus = (hash: Hex, r: any, node: NodeIdentity): FrameTxStatus => ({
  hash,
  status: r.status,
  sender: r.sender,
  payer: r.payer ?? undefined,
  factory: r.factory ?? undefined,
  transaction: r.transaction ?? undefined,
  reason: r.reason ?? undefined,
  tx: r.tx ? safe(() => fromWire(r.tx)) : undefined,
  node,
  raw: r,
});
const safe = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };

export type FrameOutcome = "success" | "failure" | "skipped";
export interface FrameReceipt {
  hash: Hex;
  status: "success" | "failure";
  payer?: Address;
  blockNumber?: bigint;
  blockHash?: Hex;
  cumulativeGasUsed: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  frames: { index: number; status: FrameOutcome; gasUsed: { execution: bigint; state: bigint }; logs: unknown[] }[];
  /** Which RPC produced it: the sidecar's `eth_getFrameTransactionReceipt` or ethrex's `eth_getTransactionReceipt`. */
  source: "sidecar" | "execution";
  raw: unknown;
}

const outcome = (s: unknown): FrameOutcome => {
  if (s === "success" || s === "0x1" || s === 1 || s === true) return "success";
  if (s === "skipped" || s === "0x2" || s === 2) return "skipped";
  return "failure";
};

/** Accepts both receipt shapes: sidecar (`status: "success"`, `gasUsed: {execution, state}`) and ethrex (`status: "0x1"`, `gasUsed`, `stateGasUsed`). */
export function parseReceipt(hash: Hex, r: any, source: FrameReceipt["source"]): FrameReceipt {
  return {
    hash,
    status: outcome(r.status) === "success" ? "success" : "failure",
    payer: r.payer ?? undefined,
    blockNumber: bigOr(r.blockNumber),
    blockHash: r.blockHash ?? undefined,
    cumulativeGasUsed: big(r.cumulativeGasUsed ?? 0),
    gasUsed: bigOr(r.gasUsed && typeof r.gasUsed !== "object" ? r.gasUsed : undefined),
    effectiveGasPrice: bigOr(r.effectiveGasPrice),
    frames: (r.frameReceipts ?? []).map((f: any, index: number) => ({
      index,
      status: outcome(f.status),
      gasUsed: typeof f.gasUsed === "object" && f.gasUsed
        ? { execution: big(f.gasUsed.execution ?? 0), state: big(f.gasUsed.state ?? 0) }
        : { execution: big(f.gasUsed ?? 0), state: big(f.stateGasUsed ?? 0) },
      logs: f.logs ?? [],
    })),
    source,
    raw: r,
  };
}

// ---------------------------------------------------------------- simulate (ethrex)

export interface PublicSimulation {
  /** Passed ethrex's frame-specific public-mempool gates. Necessary, not sufficient, for public admission. */
  valid: boolean;
  violation?: string;
  prefixShape?: string;
  payer?: Address;
  maxCost?: bigint;
  gasUsed?: bigint;
  frames?: { gasUsed: bigint; succeeded: boolean }[];
  executionStatus?: string;
  executionError?: string;
  trace?: unknown[];
  traceError?: string;
  raw: unknown;
}
/** Live ethrex names its fields `canonicalMempoolValid` / `canonicalMempoolViolation`; the docs say `valid` / `violation`. Accept both. */
export const parseSimulation = (r: any): PublicSimulation => ({
  valid: !!(r.canonicalMempoolValid ?? r.valid),
  violation: (r.canonicalMempoolViolation ?? r.violation) ?? undefined,
  prefixShape: r.prefixShape ?? undefined,
  payer: r.payer ?? undefined,
  maxCost: bigOr(r.maxCost),
  gasUsed: bigOr(r.gasUsed),
  frames: Array.isArray(r.frames) ? r.frames.map((f: any) => ({ gasUsed: big(f.gasUsed ?? 0), succeeded: !!f.succeeded })) : undefined,
  executionStatus: r.executionStatus ?? undefined,
  executionError: r.executionError ?? undefined,
  trace: r.erc7562Trace ?? undefined,
  traceError: r.erc7562TraceError ?? undefined,
  raw: r,
});

// ---------------------------------------------------------------- explorer

export type CheckStatus = "pass" | "fail" | "unknown";
export interface ExplorerRuleCheck {
  rule: RuleId;
  /** The node's own verdict, unchanged. */
  verdict: "pass" | "fail" | "skipped";
  /** `skipped` maps to `unknown`: the node did not evaluate it. */
  status: CheckStatus;
  frameIndex?: number;
  entity?: EntityRole;
  detail?: string;
}
export type AdmissionOutcome = "accepted" | "rejected" | "included" | "replaced" | "dropped";
export interface AdmissionRecord {
  id: number;
  hash: Hex;
  sender: Address;
  nonceSeq: bigint;
  nonceKeys: bigint[];
  at: Date;
  /** `rpc`, `gossip:<peerId>` or `sync:<peerId>`. */
  source: string;
  outcome: AdmissionOutcome;
  errorCode?: number;
  includer?: string;
  checks: ExplorerRuleCheck[];
  frames?: unknown[];
  frameStatuses?: FrameOutcome[];
  raw: unknown;
}
export const parseCheck = (c: any): ExplorerRuleCheck => ({
  rule: c.rule,
  verdict: c.verdict,
  status: c.verdict === "pass" ? "pass" : c.verdict === "fail" ? "fail" : "unknown",
  frameIndex: numOr(c.frameIndex),
  entity: c.entity ?? undefined,
  detail: c.detail ?? undefined,
});
export const parseAdmission = (a: any): AdmissionRecord => ({
  id: num(a.id),
  hash: a.txHash,
  sender: a.sender,
  nonceSeq: big(a.nonce ?? 0),
  nonceKeys: (a.nonceKeys ?? []).map(big),
  at: new Date(num(a.at)),
  source: a.source,
  outcome: a.outcome,
  errorCode: numOr(a.errorCode),
  includer: a.includer ?? undefined,
  checks: (a.checks ?? []).map(parseCheck),
  frames: a.frames,
  frameStatuses: a.frameStatuses?.map(outcome),
  raw: a,
});

export type LifecycleKind = "admitted" | "rejected" | "replaced" | "statusChanged" | "dropped" | "included";
export interface LifecycleEvent { seq: number; hash: Hex; at: Date; kind: LifecycleKind; status?: TxStatus; reason?: string; raw: unknown }
export const parseEvent = (e: any): LifecycleEvent => ({ seq: num(e.seq), hash: e.txHash, at: new Date(num(e.at)), kind: e.kind, status: e.status ?? undefined, reason: e.reason ?? undefined, raw: e });

export interface MempoolEntry {
  hash: Hex;
  sender: Address;
  payer?: Address;
  nonceSeq: bigint;
  nonceKeys: bigint[];
  status: TxStatus;
  frameCount: number;
  maxFeePerGas: bigint;
  submittedAt?: Date;
  updatedAt?: Date;
  source?: string;
  tx?: FrameTx;
  raw: unknown;
}
export const parseEntry = (e: any): MempoolEntry => ({
  hash: e.txHash,
  sender: e.sender,
  payer: e.payer ?? undefined,
  nonceSeq: big(e.nonce ?? e.nonceSeq ?? 0),
  nonceKeys: (e.nonceKeys ?? []).map(big),
  status: e.status,
  frameCount: typeof e.frames === "number" ? e.frames : Array.isArray(e.frames) ? e.frames.length : 0,
  maxFeePerGas: big(e.maxFeePerGas ?? 0),
  submittedAt: e.submittedTime ? new Date(num(e.submittedTime)) : undefined,
  updatedAt: e.lastUpdatedTime ? new Date(num(e.lastUpdatedTime)) : undefined,
  source: e.source,
  tx: e.tx ? safe(() => fromWire(e.tx)) : undefined,
  raw: e,
});

export interface ExplorerTransaction { hash: Hex; entry: MempoolEntry | null; admission: AdmissionRecord | null; events: LifecycleEvent[]; node: NodeIdentity; raw: unknown }
export const parseExplorerTx = (r: any, node: NodeIdentity): ExplorerTransaction => ({
  hash: r.hash,
  entry: r.entry ? parseEntry(r.entry) : null,
  admission: r.admission ? parseAdmission(r.admission) : null,
  events: (r.events ?? []).map(parseEvent),
  node,
  raw: r,
});

export type ReputationStatus = "ok" | "throttled" | "banned";
export interface ReputationEntry {
  address: Address;
  opsSeen: number;
  opsIncluded: number;
  status: ReputationStatus;
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  stake: bigint;
  unstakeDelaySec: number;
  withdrawTime: bigint;
  isStaked: boolean;
  /** Reputation is node-local: this is one node's opinion. */
  node: NodeIdentity;
  raw: unknown;
}
export const parseReputation = (r: any, node: NodeIdentity): ReputationEntry => ({
  address: r.address,
  opsSeen: num(r.opsSeen ?? 0),
  opsIncluded: num(r.opsIncluded ?? 0),
  status: r.status,
  isWhitelisted: !!r.isWhitelisted,
  isBlacklisted: !!r.isBlacklisted,
  stake: big(r.stake ?? 0),
  unstakeDelaySec: num(r.unstakeDelaySec ?? 0),
  withdrawTime: big(r.withdrawTime ?? 0),
  isStaked: !!r.isStaked,
  node,
  raw: r,
});

export interface Page<T> { items: T[]; nextCursor?: string }
