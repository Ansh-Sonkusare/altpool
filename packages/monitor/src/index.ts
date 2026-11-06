// Owner: Dev C. watchEntity: one entity seen from every sidecar at once (by default the gateway and the miner's own
// sidecar, which on Nov 6 did not hear each other's exits). Per poll and node: skandha_explorer_listReputation,
// listTransactions and listAdmissions (rejected), plus the stake registry, the entity's balance and receipts (cached).
// Each node's explorer event stream (skandha_subscribe, WebSocket) triggers an early poll; polling is the fallback.
// Works in Node and the browser. Packages depend only on core, so rejections stay raw here: apps diagnose them.
import { decodeAbiParameters, encodeFunctionData } from "viem";
import {
  DEVNET, ethrex as ethrexClient, gateway as gatewayClient,
  type Address, type EntityRole, type EntityStatus, type Hex, type ReputationStatus, type RuleCheck, type Stake, type TxStatus,
} from "@altpool/core";

/** Sends left before throttle / ban: throttled when floor(seen/10) > included + 10, banned when > included + 50. */
export const headroom = (opsSeen: number, opsIncluded: number, r = DEVNET.reputation) => ({
  untilThrottled: Math.max(0, (opsIncluded + r.throttlingSlack + 1) * r.minInclusionDenominator - opsSeen),
  untilBanned: Math.max(0, (opsIncluded + r.banSlack + 1) * r.minInclusionDenominator - opsSeen),
});

// ---------------------------------------------------------------- types

export interface NodeRef { name: string; url: string }
export const DEFAULT_NODES: NodeRef[] = [
  { name: "gateway", url: DEVNET.gatewayUrl },
  { name: "miner", url: DEVNET.minerSidecarUrl },
];

type Reputation = EntityStatus["reputation"];

export interface NodeView {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  /** This node's own reputation table: each sidecar counts seen/included separately. */
  reputation?: Reputation;
}

export interface TrackedTx {
  hash: Hex;
  role: EntityRole;
  /** The most advanced status any node reports. */
  status: TxStatus;
  /** Status per node that lists the tx. A tx missing from a node never reached it. */
  nodes: Record<string, TxStatus>;
  submittedAt?: number;
  ageMs?: number;
  /** Still pending after `stuckAfterMs`. */
  stuck?: boolean;
}

export interface Inclusion { hash: Hex; block: number; verifyGas?: bigint; gasUsed?: bigint; cost?: bigint; nodes: string[] }

export interface Rejection {
  hash: Hex;
  at: number;
  nodes: string[];
  role: EntityRole;
  errorCode?: number;
  /** The first failing check as the node recorded it (apps run it through the simulator's diagnoseAdmission). */
  failed?: RuleCheck;
  checks: RuleCheck[];
}

export interface Funds {
  balance: bigint;
  /** Mean of gasUsed × effectiveGasPrice over the inclusions we have receipts for. */
  avgCost?: bigint;
  /** What the entity earns per tx (ExitRelay: EXIT_FEE), when the caller says. */
  feePerTx?: bigint;
  marginPerTx?: bigint;
  /** How many more txs the balance pays for at avgCost. */
  txsLeft?: number;
}

export interface ThrottleEta {
  /** Change in sends-left-before-throttling per minute over the sample window (negative = heading for throttling). */
  headroomPerMin: number;
  /** Minutes until throttled at that rate; undefined when not heading there. */
  minutes?: number;
}

/** EntityStatus plus the multi-node view. Every EntityStatus field keeps its meaning. */
export interface EntityReport extends EntityStatus {
  nodes: NodeView[];
  pending: TrackedTx[];
  inclusions: Inclusion[];
  rejections: Rejection[];
  funds: Funds;
  throttleEta?: ThrottleEta;
  updatedAt: number;
}

export interface ReportOptions {
  nodes?: NodeRef[];
  /** Chain reads (stake, balance, receipts) go straight to ethrex; sidecars are the fallback. */
  ethrexUrl?: string;
  /** Per-request limit, so one slow node can't stall a poll forever (default 25 s; the devnet's explorer calls take 2-10 s). */
  timeoutMs?: number;
  /** Recent explorer txs scanned per node (default and explorer maximum: 200). */
  txLimit?: number;
  /** Receipts fetched for at most this many latest inclusions (default 10). */
  maxInclusions?: number;
  /** A pending tx older than this is stuck (default 90 s, about 7 blocks). */
  stuckAfterMs?: number;
  feePerTx?: bigint;
  /** Receipt cache across polls. */
  cache?: Map<string, Omit<Inclusion, "nodes">>;
  previous?: EntityReport;
}

// ---------------------------------------------------------------- one snapshot

const PENDING: TxStatus[] = ["New", "Pending", "Submitted"];
const INCLUDED: TxStatus[] = ["OnChain", "Finalized"];
/** Higher = further along; used to pick one status out of several nodes' views. */
const RANK: Record<TxStatus, number> = { New: 0, Pending: 1, Submitted: 2, Cancelled: 3, Reverted: 4, OnChain: 5, Finalized: 6 };
const REP_RANK: Record<ReputationStatus, number> = { ok: 0, throttled: 1, banned: 2 };
const lc = (a: string) => a.toLowerCase();
const big = (v: unknown): bigint => (v === undefined || v === null || v === "" ? 0n : BigInt(v as string | number));
const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** hegota-support's rpc has no timeout: race each call against one. */
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

type Caller = { call: (m: string, p?: unknown[]) => Promise<any> };
/** First caller that answers. */
const firstOf = async (callers: Caller[], m: string, params: unknown[], ms: number): Promise<any> => {
  let last: unknown;
  for (const c of callers) {
    try { return await within(c.call(m, params), ms, m); } catch (e) { last = e; }
  }
  throw last;
};

const depositInfoAbi = [{
  type: "function", name: "getDepositInfo", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
}] as const;

interface ExplorerTx { txHash: Hex; sender: Address; payer?: Address; status: TxStatus; submittedTime?: number; lastUpdatedTime?: number }
interface AdmissionRecord { txHash: Hex; sender: Address; at: number; outcome: string; errorCode?: number; checks?: RuleCheck[]; frames?: { target?: string | null }[] }

interface NodeData {
  ref: NodeRef;
  gw: ReturnType<typeof gatewayClient>;
  view: NodeView;
  txs: ExplorerTx[];
  rejected: AdmissionRecord[];
}

/** The explorer serves at most 200 items per page (Nov 7), so page through the reputation table until the entity shows up. */
const findReputationItem = async (gw: ReturnType<typeof gatewayClient>, entity: string, ms: number, name: string, maxPages = 5) => {
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await within(gw.call("skandha_explorer_listReputation", [{ limit: 200, ...(cursor ? { cursor } : {}) }]), ms, `${name} listReputation`);
    const hit = (r?.items ?? []).find((i: any) => lc(String(i.address)) === entity);
    if (hit || !r?.nextCursor) return hit;
    cursor = String(r.nextCursor);
  }
  return undefined;
};

const readNode = async (ref: NodeRef, entity: string, txLimit: number, ms: number): Promise<NodeData> => {
  const gw = gatewayClient(ref.url);
  const t0 = Date.now();
  try {
    const [item, txs, adm] = await Promise.all([
      findReputationItem(gw, entity, ms, ref.name),
      within(gw.call("skandha_explorer_listTransactions", [{ limit: Math.min(txLimit, 200) }]), ms, `${ref.name} listTransactions`),
      within(gw.call("skandha_explorer_listAdmissions", [{ outcome: "rejected", limit: Math.min(txLimit, 200) }]), ms, `${ref.name} listAdmissions`).catch(() => ({ items: [] })),
    ]);
    const reputation: Reputation | undefined = item && {
      opsSeen: Number(item.opsSeen ?? 0), opsIncluded: Number(item.opsIncluded ?? 0),
      status: (item.status ?? "ok") as ReputationStatus, isWhitelisted: Boolean(item.isWhitelisted), isBlacklisted: Boolean(item.isBlacklisted),
    };
    return {
      ref, gw, txs: txs?.items ?? [], rejected: adm?.items ?? [],
      view: { name: ref.name, url: ref.url, ok: true, latencyMs: Date.now() - t0, reputation },
    };
  } catch (e) {
    return { ref, gw, txs: [], rejected: [], view: { name: ref.name, url: ref.url, ok: false, error: errText(e), latencyMs: Date.now() - t0 } };
  }
};

/** The leading VERIFY frames of an explorer admission record. */
const prefixCountOf = (frames: { mode?: number | string }[] = []) => {
  let n = 0;
  while (n < frames.length && Number(frames[n]!.mode) === 1) n++;
  return n;
};

/** One snapshot of an entity across nodes. Throws only when every node is unreachable. */
export const entityReport = async (entity: Address, o: ReportOptions = {}): Promise<EntityReport> => {
  const me = lc(entity);
  const refs = o.nodes ?? DEFAULT_NODES;
  const cache = o.cache ?? new Map<string, Omit<Inclusion, "nodes">>();
  const now = Date.now();

  const ms = o.timeoutMs ?? 25_000;
  const data = await Promise.all(refs.map((r) => readNode(r, me, o.txLimit ?? 200, ms)));
  const up = data.filter((d) => d.view.ok);
  if (!up.length) throw new Error(`no node reachable: ${data.map((d) => `${d.ref.name}: ${d.view.error}`).join("; ")}`);
  // Chain reads: ethrex first, then any sidecar (they forward eth_* to it).
  const chain: Caller[] = [ethrexClient(o.ethrexUrl ?? DEVNET.ethrexUrl), ...up.map((d) => d.gw)];
  const chainCall = (m: string, params: unknown[]) => firstOf(chain, m, params, ms);

  // Stake from the registry (chain truth, the same on every node) and the entity's balance.
  const [deposit, balanceHex] = await Promise.all([
    chainCall("eth_call", [{ to: DEVNET.stakingRegistry, data: encodeFunctionData({ abi: depositInfoAbi, functionName: "getDepositInfo", args: [entity] }) }, "latest"]),
    chainCall("eth_getBalance", [entity, "latest"]),
  ]);
  const [amount, delay, withdrawTime] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], deposit as Hex);
  const stake: Stake = {
    amount, unstakeDelaySec: Number(delay), withdrawTime,
    isStaked: amount > DEVNET.minStakeWei && Number(delay) >= DEVNET.unstakeDelaySec && withdrawTime === 0n,
  };

  // Reputation: each sidecar counts its own. Report the worst status and the least headroom.
  const reps = up.map((d) => d.view.reputation).filter((r): r is Reputation => Boolean(r));
  const reputation: Reputation = reps.length
    ? reps.reduce((w, r) => {
        const hw = headroom(w.opsSeen, w.opsIncluded).untilThrottled, hr = headroom(r.opsSeen, r.opsIncluded).untilThrottled;
        const worse = REP_RANK[r.status] > REP_RANK[w.status] || (REP_RANK[r.status] === REP_RANK[w.status] && hr < hw);
        return { ...(worse ? r : w), isWhitelisted: w.isWhitelisted && r.isWhitelisted, isBlacklisted: w.isBlacklisted || r.isBlacklisted };
      })
    : { opsSeen: 0, opsIncluded: 0, status: "ok", isWhitelisted: false, isBlacklisted: false };

  // Txs: merge every node's list by hash.
  const byHash = new Map<string, TrackedTx>();
  for (const d of up) {
    for (const t of d.txs) {
      const isSender = lc(t.sender) === me;
      if (!isSender && !(t.payer && lc(t.payer) === me)) continue;
      const k = lc(t.txHash);
      const cur = byHash.get(k) ?? { hash: t.txHash, role: isSender ? "sender" : "payer", status: t.status, nodes: {}, submittedAt: t.submittedTime };
      cur.nodes[d.ref.name] = t.status;
      if (RANK[t.status] > RANK[cur.status]) cur.status = t.status;
      if (t.submittedTime && (!cur.submittedAt || t.submittedTime < cur.submittedAt)) cur.submittedAt = t.submittedTime;
      byHash.set(k, cur);
    }
  }
  const all = [...byHash.values()];
  const stuckAfter = o.stuckAfterMs ?? 90_000;
  const pending = all.filter((t) => PENDING.includes(t.status)).map((t) => {
    const ageMs = t.submittedAt ? now - t.submittedAt : undefined;
    return { ...t, ageMs, stuck: ageMs !== undefined && ageMs > stuckAfter };
  });

  // Inclusions: newest first; receipts (block, VERIFY gas, cost) for the latest few, cached.
  const included = all.filter((t) => INCLUDED.includes(t.status))
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))
    .slice(0, o.maxInclusions ?? 10);
  const inclusions = (await Promise.all(included.map(async (t): Promise<Inclusion | undefined> => {
    const nodes = Object.keys(t.nodes);
    const hit = cache.get(lc(t.hash));
    if (hit) return { ...hit, nodes };
    const home = up.find((d) => t.nodes[d.ref.name]) ?? up[0]!;
    const [receipt, rec] = await Promise.all([
      chainCall("eth_getTransactionReceipt", [t.hash]).catch(() => undefined),
      within(home.gw.admission(t.hash), ms, "admission").catch(() => undefined),
    ]);
    if (!receipt?.blockNumber) return undefined; // not mined yet as far as the node knows
    const n = prefixCountOf(rec?.admission?.frames);
    const verifyGas = n && receipt.frameReceipts
      ? receipt.frameReceipts.slice(0, n).reduce((s: bigint, f: any) => s + big(typeof f.gasUsed === "object" ? f.gasUsed.execution : f.gasUsed), 0n)
      : undefined;
    const gasUsed = receipt.gasUsed !== undefined ? big(receipt.gasUsed) : undefined;
    const cost = gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? gasUsed * big(receipt.effectiveGasPrice) : undefined;
    const inc = { hash: t.hash, block: Number(receipt.blockNumber), verifyGas, gasUsed, cost };
    cache.set(lc(t.hash), inc);
    return { ...inc, nodes };
  }))).filter((x): x is Inclusion => x !== undefined).sort((a, b) => b.block - a.block);

  // Rejections: admission records where the entity is the sender or a frame targets it (a payer).
  const rej = new Map<string, Rejection>();
  for (const d of up) {
    for (const a of d.rejected) {
      const isSender = lc(a.sender) === me;
      if (!isSender && !(a.frames ?? []).some((f) => f.target && lc(f.target) === me)) continue;
      const k = lc(a.txHash);
      const cur = rej.get(k);
      if (cur) { if (!cur.nodes.includes(d.ref.name)) cur.nodes.push(d.ref.name); continue; }
      const checks = a.checks ?? [];
      rej.set(k, { hash: a.txHash, at: a.at, nodes: [d.ref.name], role: isSender ? "sender" : "payer", errorCode: a.errorCode, checks, failed: checks.find((c) => c.verdict === "fail") });
    }
  }
  const rejections = [...rej.values()].sort((a, b) => b.at - a.at);

  // Evictions: final non-inclusions, plus txs that were pending last time and are now gone from every node.
  const evictions: EntityStatus["evictions"] = all
    .filter((t) => t.status === "Cancelled" || t.status === "Reverted")
    .map((t) => (t.status === "Cancelled" ? { hash: t.hash, kind: "Cancelled" as const } : { hash: t.hash, kind: "dropped" as const, reason: "reverted on chain" }));
  for (const p of o.previous?.pending ?? []) if (!byHash.has(lc(p.hash))) evictions.push({ hash: p.hash, kind: "dropped", reason: "left the mempool" });
  for (const e of o.previous?.evictions ?? []) if (e.reason === "left the mempool" && !evictions.some((x) => x.hash === e.hash)) evictions.push(e);

  // Funds: what the entity can still pay for.
  const balance = big(balanceHex);
  const costs = inclusions.map((i) => i.cost).filter((c): c is bigint => c !== undefined);
  const avgCost = costs.length ? costs.reduce((s, c) => s + c, 0n) / BigInt(costs.length) : undefined;
  const funds: Funds = {
    balance, avgCost, feePerTx: o.feePerTx,
    marginPerTx: o.feePerTx !== undefined && avgCost !== undefined ? o.feePerTx - avgCost : undefined,
    txsLeft: avgCost ? Number(balance / avgCost) : undefined,
  };

  return {
    address: entity, stake, reputation, headroom: headroom(reputation.opsSeen, reputation.opsIncluded),
    pending, inclusions, evictions, rejections, funds, nodes: data.map((d) => d.view), updatedAt: now,
  };
};

/** One snapshot from a single node (the pre-multi-node API, kept for callers that pass one client). */
export const entityStatus = (entity: Address, gw = gatewayClient(), opts: Omit<ReportOptions, "nodes"> = {}): Promise<EntityReport> =>
  entityReport(entity, { ...opts, nodes: [{ name: gw.url === DEVNET.minerSidecarUrl ? "miner" : gw.url === DEVNET.gatewayUrl ? "gateway" : "node", url: gw.url }] });

// ---------------------------------------------------------------- watching

export interface WatchOptions extends Omit<ReportOptions, "cache" | "previous"> {
  /** The whole report, first snapshot and then on every change. */
  onStatus?: (s: EntityReport) => void;
  /** New since the watch started (the first snapshot sets the baseline). */
  onInclusion?: (i: Inclusion, s: EntityReport) => void;
  onRejection?: (r: Rejection, s: EntityReport) => void;
  onEviction?: (e: EntityStatus["evictions"][number], s: EntityReport) => void;
  /** A pending tx crossed stuckAfterMs. */
  onStuck?: (t: TrackedTx, s: EntityReport) => void;
  /** Sends left before throttling fell to `throttleWarnAt` or below, or the status left "ok". Fires on the transition. */
  onThrottleWarning?: (s: EntityReport) => void;
  /** txsLeft fell to `lowBalanceAt` or below. Fires on the transition. */
  onLowBalance?: (s: EntityReport) => void;
  /** Staked / unstaked flipped, or an unlock started (withdrawTime set): the entity is leaving the alt mempool's trust. */
  onStakeChange?: (prev: Stake, next: Stake, s: EntityReport) => void;
  onError?: (e: unknown) => void;
  /** Fallback poll period (default 10 s: the explorer calls are heavy on a shared devnet, and live events trigger polls anyway). */
  intervalMs?: number;
  throttleWarnAt?: number;
  lowBalanceAt?: number;
  /** Subscribe to each node's explorer events over WebSocket (default true where WebSocket exists). */
  live?: boolean;
  /** @deprecated single node; use `nodes`. */
  gateway?: ReturnType<typeof gatewayClient>;
}

const fingerprint = (s: EntityReport) =>
  JSON.stringify({ ...s, updatedAt: 0, nodes: s.nodes.map((n) => ({ ...n, latencyMs: 0 })), pending: s.pending.map((p) => ({ ...p, ageMs: 0 })) },
    (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Rate of headroom change over the last 10 minutes of samples. */
const etaFrom = (samples: { t: number; h: number }[]): ThrottleEta | undefined => {
  if (samples.length < 2) return undefined;
  const a = samples[0]!, b = samples[samples.length - 1]!;
  const mins = (b.t - a.t) / 60_000;
  if (mins < 0.5) return undefined;
  const headroomPerMin = (b.h - a.h) / mins;
  return { headroomPerMin, minutes: headroomPerMin < 0 ? b.h / -headroomPerMin : undefined };
};

const wsUrlOf = (url: string) => url.replace(/^http/, "ws");

/** Returns an unwatch function. Never throws: errors go to onError. */
export const watchEntity = (entity: Address, opts: WatchOptions): (() => void) => {
  const nodes = opts.nodes ?? (opts.gateway ? [{ name: "node", url: opts.gateway.url }] : DEFAULT_NODES);
  const cache = new Map<string, Omit<Inclusion, "nodes">>();
  const samples: { t: number; h: number }[] = [];
  let last: EntityReport | undefined;
  let lastPrint = "";
  let warnedThrottle = false, warnedBalance = false;
  const stuckSeen = new Set<string>();
  let stopped = false, running = false, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sockets: WebSocket[] = [];

  const emit = (s: EntityReport) => {
    const prev = last;
    if (prev) {
      const had = (xs: { hash: Hex }[]) => new Set(xs.map((x) => lc(x.hash)));
      const inc = had(prev.inclusions), rej = had(prev.rejections), ev = had(prev.evictions);
      for (const i of s.inclusions) if (!inc.has(lc(i.hash))) opts.onInclusion?.(i, s);
      for (const r of s.rejections) if (!rej.has(lc(r.hash))) opts.onRejection?.(r, s);
      for (const e of s.evictions) if (!ev.has(lc(e.hash))) opts.onEviction?.(e, s);
    }
    if (prev && (prev.stake.isStaked !== s.stake.isStaked || prev.stake.withdrawTime !== s.stake.withdrawTime)) opts.onStakeChange?.(prev.stake, s.stake, s);
    for (const p of s.pending) if (p.stuck && !stuckSeen.has(lc(p.hash))) { stuckSeen.add(lc(p.hash)); opts.onStuck?.(p, s); }
    const throttled = s.reputation.status !== "ok" || s.headroom.untilThrottled <= (opts.throttleWarnAt ?? 20);
    if (throttled && !warnedThrottle) opts.onThrottleWarning?.(s);
    warnedThrottle = throttled;
    const low = s.funds.txsLeft !== undefined && s.funds.txsLeft <= (opts.lowBalanceAt ?? 5);
    if (low && !warnedBalance) opts.onLowBalance?.(s);
    warnedBalance = low;
  };

  const poll = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    clearTimeout(timer);
    try {
      const s = await entityReport(entity, { ...opts, nodes, cache, previous: last });
      samples.push({ t: s.updatedAt, h: s.headroom.untilThrottled });
      while (samples.length > 1 && s.updatedAt - samples[0]!.t > 10 * 60_000) samples.shift();
      s.throttleEta = etaFrom(samples);
      emit(s);
      const f = fingerprint(s);
      if (f !== lastPrint) { lastPrint = f; opts.onStatus?.(s); }
      last = s;
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
      if (!stopped) {
        if (again) { again = false; void poll(); }
        else timer = setTimeout(poll, opts.intervalMs ?? 10_000);
      }
    }
  };

  // Live: any explorer event on any node means something may have changed; poll soon (debounced).
  let soon: ReturnType<typeof setTimeout> | undefined;
  const nudge = () => { clearTimeout(soon); soon = setTimeout(() => void poll(), 300); };
  const connect = (ref: NodeRef, attempt = 0) => {
    if (stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrlOf(ref.url)); } catch (e) { opts.onError?.(e); return; }
    sockets.push(ws);
    ws.onopen = async () => {
      attempt = 0;
      // Live only: start after the node's latest seq rather than replaying its history.
      const info = await gatewayClient(ref.url).explorerInfo().catch(() => undefined);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_subscribe", params: ["explorerEvents", Number(info?.latestSeq ?? 0)] }));
    };
    ws.onmessage = (m) => {
      try { if (JSON.parse(String(m.data))?.method === "skandha_subscription") nudge(); } catch { /* not ours */ }
    };
    ws.onclose = () => {
      sockets.splice(sockets.indexOf(ws), 1);
      if (!stopped) setTimeout(() => connect(ref, attempt + 1), Math.min(30_000, 2_000 * 2 ** attempt));
    };
    ws.onerror = () => { /* onclose follows and reconnects */ };
  };
  if (opts.live !== false && typeof WebSocket !== "undefined") for (const n of nodes) connect(n);

  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(soon);
    for (const ws of [...sockets]) ws.close();
  };
};

// ---------------------------------------------------------------- one transaction

export interface TxEvent { kind: string; status?: TxStatus; at: number }
export interface FrameInfo { index: number; mode: number; flags: number; target: Address | null; executionLimit: bigint; stateLimit: bigint }
export interface FrameOutcome { status: "ok" | "failed"; gasUsed: bigint; stateGasUsed: bigint }

export interface TxNodeView {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
  /** The node has a record of this tx. */
  known: boolean;
  /** How it arrived: "rpc" (sent to this node) or "gossip:<peer id>". */
  source?: string;
  receivedAt?: number;
  outcome?: string;
  status?: TxStatus;
  errorCode?: number;
  checks: RuleCheck[];
  events: TxEvent[];
}

export interface TxReport {
  hash: Hex;
  sender?: Address;
  payer?: Address;
  nonce?: bigint;
  nonceKeys?: bigint[];
  frames: FrameInfo[];
  /** Leading VERIFY frames. */
  prefixCount: number;
  receipt?: { block: number; success: boolean; gasUsed: bigint; cost?: bigint; frames: FrameOutcome[] };
  verifyGas?: bigint;
  /** The most advanced status any node reports, or the receipt's. */
  status?: TxStatus;
  nodes: TxNodeView[];
  /** First node to record it, and how long each other node took to hear of it. */
  firstSeen?: { node: string; at: number };
  lag: { node: string; ms: number }[];
  updatedAt: number;
}

/** One tx across nodes: each sidecar's admission record and lifecycle events, plus the receipt from ethrex. */
export const txReport = async (hash: Hex, o: Pick<ReportOptions, "nodes" | "ethrexUrl" | "timeoutMs"> = {}): Promise<TxReport> => {
  const refs = o.nodes ?? DEFAULT_NODES;
  const ms = o.timeoutMs ?? 25_000;
  const records = await Promise.all(refs.map(async (ref) => {
    const gw = gatewayClient(ref.url);
    try { return { ref, gw, rec: await within(gw.admission(hash), ms, `${ref.name} getTransaction`) as any, error: undefined as string | undefined }; }
    catch (e) { return { ref, gw, rec: undefined, error: errText(e) }; }
  }));
  const up = records.filter((r) => !r.error);
  const chain: Caller[] = [ethrexClient(o.ethrexUrl ?? DEVNET.ethrexUrl), ...up.map((r) => r.gw)];
  const receiptRaw = await firstOf(chain, "eth_getTransactionReceipt", [hash], ms).catch(() => undefined);

  const nodes: TxNodeView[] = records.map(({ ref, rec, error }) => {
    const a = rec?.admission, e = rec?.entry;
    const events: TxEvent[] = (rec?.events ?? []).map((x: any) => ({ kind: x.kind, status: x.status, at: Number(x.at) })).sort((x: TxEvent, y: TxEvent) => x.at - y.at);
    return {
      name: ref.name, url: ref.url, ok: !error, error,
      known: Boolean(a || e || events.length),
      source: a?.source ?? e?.source, receivedAt: a?.at ?? events[0]?.at ?? e?.submittedTime,
      outcome: a?.outcome, status: e?.status ?? events[events.length - 1]?.status, errorCode: a?.errorCode,
      checks: a?.checks ?? [], events,
    };
  });

  const first = records.map((r) => r.rec).find((r) => r?.admission?.frames || r?.entry);
  const a = first?.admission, e = first?.entry;
  const frames: FrameInfo[] = (a?.frames ?? []).map((f: any, index: number) => ({
    index, mode: Number(f.mode), flags: Number(f.flags), target: f.target ?? null,
    executionLimit: big(f.limits?.execution), stateLimit: big(f.limits?.state),
  }));
  const prefixCount = prefixCountOf(frames);

  let receipt: TxReport["receipt"];
  let verifyGas: bigint | undefined;
  if (receiptRaw?.blockNumber) {
    const gasOf = (v: any) => big(typeof v === "object" && v ? v.execution : v);
    const fr: FrameOutcome[] = (receiptRaw.frameReceipts ?? []).map((f: any) => ({
      status: f.status === "0x1" || f.status === "success" || f.status === 1 ? "ok" : "failed",
      gasUsed: gasOf(f.gasUsed), stateGasUsed: big(typeof f.gasUsed === "object" ? f.gasUsed?.state : f.stateGasUsed),
    }));
    const gasUsed = big(receiptRaw.gasUsed);
    receipt = {
      block: Number(receiptRaw.blockNumber), success: receiptRaw.status === "0x1" || receiptRaw.status === "success",
      gasUsed, cost: receiptRaw.effectiveGasPrice !== undefined ? gasUsed * big(receiptRaw.effectiveGasPrice) : undefined, frames: fr,
    };
    if (prefixCount && fr.length) verifyGas = fr.slice(0, prefixCount).reduce((s, f) => s + f.gasUsed, 0n);
  }

  const statuses = nodes.map((n) => n.status).filter((s): s is TxStatus => Boolean(s));
  let status = statuses.sort((x, y) => RANK[y] - RANK[x])[0];
  if (receipt && (!status || RANK[status] < RANK.OnChain)) status = receipt.success ? "OnChain" : "Reverted";

  const seen = nodes.filter((n) => n.receivedAt !== undefined).sort((x, y) => x.receivedAt! - y.receivedAt!);
  const firstSeen = seen[0] ? { node: seen[0].name, at: seen[0].receivedAt! } : undefined;

  return {
    hash, sender: a?.sender ?? e?.sender, payer: e?.payer,
    nonce: a?.nonce !== undefined ? big(a.nonce) : e?.nonce !== undefined ? big(e.nonce) : undefined,
    nonceKeys: (a?.nonceKeys ?? e?.nonceKeys)?.map((k: string) => big(k)),
    frames, prefixCount, receipt, verifyGas, status, nodes, firstSeen,
    lag: firstSeen ? seen.slice(1).map((n) => ({ node: n.name, ms: n.receivedAt! - firstSeen.at })) : [],
    updatedAt: Date.now(),
  };
};
export * from "./alerts";
