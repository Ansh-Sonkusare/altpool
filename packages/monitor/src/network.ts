// Owner: Dev C. The whole alt mempool at once, for the devnet team: every entity by headroom, the throttled and banned
// ones, mempool size, gossip between sidecars, and live numbers behind our rule findings (research repo docs/10).
// Explorer pages hold at most 200 items, so everything here is "recent", and says how much it looked at.
import { gateway as gatewayClient, type Address, type ReputationStatus, type TxStatus } from "@altpool/core";
import { DEFAULT_NODES, headroom, type NodeRef } from "./index";

export interface NetworkNode {
  name: string;
  url: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  version?: string;
  bundlingMode?: string;
  p2pEnabled?: boolean;
  latestSeq?: number;
  bootId?: string;
  peers?: number;
  /** Txs in New / Pending / Submitted among the latest explorer txs. */
  pending: number;
  /** How many explorer txs (max 200) and rejected admissions (max 50) we looked at. */
  txsScanned: number;
  admissionsScanned: number;
  rejectedRecent: number;
  reputationEntries: number;
  /** More reputation pages existed than we read. */
  reputationTruncated: boolean;
}

export interface NetworkEntity {
  address: Address;
  /** The worst status and the least headroom across nodes. */
  status: ReputationStatus;
  untilThrottled: number;
  untilBanned: number;
  isStaked: boolean;
  stake: bigint;
  perNode: Record<string, { opsSeen: number; opsIncluded: number; status: ReputationStatus }>;
}

export interface Propagation {
  /** Where the tx was sent (source "rpc"). */
  from: string;
  to: string;
  /** Txs both nodes recorded, sent to `from` and gossiped to `to`. */
  samples: number;
  medianMs?: number;
  p90Ms?: number;
  maxMs?: number;
}

export interface NetworkReport {
  nodes: NetworkNode[];
  entities: NetworkEntity[];
  propagation: Propagation[];
  /** Recent txs listed by exactly one node, within the window all nodes cover: they never reached the other. */
  onlyOn: Record<string, number>;
  findings: {
    /** Entities seen but never included on some node (docs/10 #3: the gateway's included count stayed 0). */
    seenNeverIncluded: number;
    /** Rejections whose recorded reason is the public mempool's gas cap, echoed by an alt sidecar (not the cause). */
    echoedGasCap: number;
    /** Share of recent txs that every node lists. */
    sharedShare?: number;
  };
  updatedAt: number;
}

const REP_RANK: Record<ReputationStatus, number> = { ok: 0, throttled: 1, banned: 2 };
const PENDING: TxStatus[] = ["New", "Pending", "Submitted"];
const lc = (a: string) => a.toLowerCase();
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

// Admission records carry full frames (~20 KB each; 50 of them took over a minute on Nov 7), so gossip is measured
// from the explorer's tx list (source + submittedTime), and only rejected admissions are read, 50 at most.
interface Raw { ref: NodeRef; node: NetworkNode; reputation: any[]; txs: any[]; rejected: any[] }

const readNode = async (ref: NodeRef, ms: number, maxRepPages: number): Promise<Raw> => {
  const gw = gatewayClient(ref.url);
  const t0 = Date.now();
  const node: NetworkNode = { name: ref.name, url: ref.url, ok: false, pending: 0, txsScanned: 0, admissionsScanned: 0, rejectedRecent: 0, reputationEntries: 0, reputationTruncated: false };
  try {
    const repPages = (async () => {
      const items: any[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < maxRepPages; i++) {
        const r = await within(gw.call("skandha_explorer_listReputation", [{ limit: 200, ...(cursor ? { cursor } : {}) }]), ms, `${ref.name} listReputation`);
        items.push(...(r?.items ?? []));
        if (!r?.nextCursor) return { items, truncated: false };
        cursor = String(r.nextCursor);
      }
      return { items, truncated: true };
    })();
    const [info, peers, txs, adm, rep] = await Promise.all([
      within(gw.explorerInfo(), ms, `${ref.name} info`).catch(() => undefined),
      within(gw.call("skandha_explorer_peers"), ms, `${ref.name} peers`).catch(() => undefined),
      within(gw.call("skandha_explorer_listTransactions", [{ limit: 200 }]), ms, `${ref.name} listTransactions`),
      within(gw.call("skandha_explorer_listAdmissions", [{ outcome: "rejected", limit: 50 }]), ms, `${ref.name} listAdmissions`).catch(() => undefined),
      repPages,
    ]);
    const txItems: any[] = txs?.items ?? [], admItems: any[] = adm?.items ?? [];
    Object.assign(node, {
      ok: true, latencyMs: Date.now() - t0,
      version: info?.version, bundlingMode: info?.bundlingMode, p2pEnabled: info?.p2pEnabled, latestSeq: info?.latestSeq, bootId: info?.bootId,
      peers: Array.isArray(peers) ? peers.length : undefined,
      pending: txItems.filter((t) => PENDING.includes(t.status)).length, txsScanned: txItems.length,
      admissionsScanned: admItems.length, rejectedRecent: admItems.length,
      reputationEntries: rep.items.length, reputationTruncated: rep.truncated,
    });
    return { ref, node, reputation: rep.items, txs: txItems, rejected: admItems };
  } catch (e) {
    return { ref, node: { ...node, error: (e as Error)?.message ?? String(e), latencyMs: Date.now() - t0 }, reputation: [], txs: [], rejected: [] };
  }
};

export const networkReport = async (o: { nodes?: NodeRef[]; timeoutMs?: number; maxReputationPages?: number } = {}): Promise<NetworkReport> => {
  const refs = o.nodes ?? DEFAULT_NODES;
  const raw = await Promise.all(refs.map((r) => readNode(r, o.timeoutMs ?? 25_000, o.maxReputationPages ?? 3)));
  const up = raw.filter((r) => r.node.ok);
  if (!up.length) throw new Error(`no node reachable: ${raw.map((r) => `${r.ref.name}: ${r.node.error}`).join("; ")}`);

  // Entities: merge reputation tables; report the worst status and least headroom across nodes.
  const ents = new Map<string, NetworkEntity>();
  for (const r of up) {
    for (const i of r.reputation) {
      const k = lc(String(i.address));
      const seen = Number(i.opsSeen ?? 0), inc = Number(i.opsIncluded ?? 0), status = (i.status ?? "ok") as ReputationStatus;
      const h = headroom(seen, inc);
      const e = ents.get(k) ?? { address: i.address as Address, status, untilThrottled: h.untilThrottled, untilBanned: h.untilBanned, isStaked: Boolean(i.isStaked), stake: BigInt(i.stake ?? 0), perNode: {} };
      e.perNode[r.ref.name] = { opsSeen: seen, opsIncluded: inc, status };
      if (REP_RANK[status] > REP_RANK[e.status]) e.status = status;
      e.untilThrottled = Math.min(e.untilThrottled, h.untilThrottled);
      e.untilBanned = Math.min(e.untilBanned, h.untilBanned);
      e.isStaked ||= Boolean(i.isStaked);
      ents.set(k, e);
    }
  }
  const entities = [...ents.values()].sort((a, b) => REP_RANK[b.status] - REP_RANK[a.status] || a.untilThrottled - b.untilThrottled);

  // Gossip: for txs two nodes both list, the lag from the node it was sent to (source "rpc") to the other.
  const byNode = new Map(up.map((r) => [r.ref.name, new Map(r.txs.map((t) => [lc(t.txHash), t]))]));
  const propagation: Propagation[] = [];
  const onlyOn: Record<string, number> = Object.fromEntries(up.map((r) => [r.ref.name, 0]));
  let shared = 0, total = 0;
  // Only txs inside every node's window: the newest list on each node, back to the oldest time all of them cover.
  const floor = Math.max(...up.map((r) => Math.min(...r.txs.map((t) => Number(t.submittedTime ?? Infinity)))));
  const allHashes = new Set(up.flatMap((r) => r.txs.filter((t) => Number(t.submittedTime ?? 0) >= floor).map((t) => lc(t.txHash))));
  for (const h of allHashes) {
    const holders = up.filter((r) => byNode.get(r.ref.name)!.has(h));
    total++;
    if (holders.length === 1) onlyOn[holders[0]!.ref.name]!++;
    else shared++;
  }
  for (const a of up) for (const b of up) {
    if (a === b) continue;
    const lags: number[] = [];
    for (const [h, x] of byNode.get(a.ref.name)!) {
      const y = byNode.get(b.ref.name)!.get(h);
      if (x.source === "rpc" && y && String(y.source ?? "").startsWith("gossip")) lags.push(Number(y.submittedTime) - Number(x.submittedTime));
    }
    propagation.push({ from: a.ref.name, to: b.ref.name, samples: lags.length, medianMs: quantile(lags, 0.5), p90Ms: quantile(lags, 0.9), maxMs: lags.length ? Math.max(...lags) : undefined });
  }

  const echoedGasCap = up.reduce((n, r) => n + r.rejected.filter((a) => (a.checks ?? []).some((c: any) => c.verdict === "fail" && /prefix gas budget exceeded/.test(c.detail ?? ""))).length, 0);
  const seenNeverIncluded = entities.filter((e) => Object.values(e.perNode).some((p) => p.opsSeen > 0 && p.opsIncluded === 0)).length;

  return {
    nodes: raw.map((r) => r.node), entities, propagation, onlyOn,
    findings: { seenNeverIncluded, echoedGasCap, sharedShare: total && up.length > 1 ? shared / total : undefined },
    updatedAt: Date.now(),
  };
};

/** Refresh every `intervalMs` (default 30 s: these are the heaviest explorer reads). Returns a stop function. */
export const watchNetwork = (o: { nodes?: NodeRef[]; intervalMs?: number; onReport: (r: NetworkReport) => void; onError?: (e: unknown) => void }) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { const r = await networkReport({ nodes: o.nodes }); if (!stopped) o.onReport(r); }
    catch (e) { if (!stopped) o.onError?.(e); }
    finally { if (!stopped) timer = setTimeout(tick, o.intervalMs ?? 30_000); }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
};

