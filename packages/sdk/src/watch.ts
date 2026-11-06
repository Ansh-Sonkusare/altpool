// Monitoring. WebSocket subscriptions with resume (seq + bootId), de-duplication and reconnect; polling where the
// node offers a request/response equivalent. Every watcher returns an unwatch function and never throws into the UI:
// errors go to onError.
import type { Address, Hex, TxStatus } from "@altpool/core";
import type { Client } from "viem";
import { AltpoolSdkError, SubscriptionError, UnsupportedCapabilityError } from "./errors";
import { fromWire, parseEvent, FINAL_STATUSES, type FrameReceipt, type FrameTxStatus, type LifecycleEvent, type NodeIdentity, type ReputationEntry } from "./normalize";
import type { AltMempoolClient } from "./sidecar";
import { getEntityStake, type EntityStake, type StakingParameters } from "./staking";
import type { FrameTx } from "@forshtat/hegota-support/tx";

export type Unwatch = () => void;
type OnError = (e: AltpoolSdkError) => void;
const wrap = (e: unknown): AltpoolSdkError => (e instanceof AltpoolSdkError ? e : new SubscriptionError(String((e as Error)?.message ?? e), { cause: e }));

// ---------------------------------------------------------------- explorer lifecycle stream

export interface ExplorerWatchArgs {
  /** Resume after this seq (events with seq > sinceSeq are delivered). Default: the node's latestSeq (live only). */
  sinceSeq?: number;
  onEvent: (e: LifecycleEvent) => void;
  /** The node restarted (new bootId) or evicted events we had not seen. Seq numbering may restart. */
  onReset?: (info: { reason: "restart" | "gap"; bootId: string; oldestSeq: number; lastSeq: number }) => void;
  onError?: OnError;
  /** Only events for these tx hashes. */
  hashes?: Hex[];
}

/** `skandha_subscribe ["explorerEvents", sinceSeq]`. Resumes from the last delivered seq after a reconnect; drops duplicates. */
export function watchExplorerEvents(sidecar: AltMempoolClient, args: ExplorerWatchArgs): Unwatch {
  let stopped = false;
  let lastSeq = args.sinceSeq ?? -1;
  let bootId: string | undefined;
  let unsub: (() => Promise<void>) | undefined;
  const filter = args.hashes ? new Set(args.hashes.map((h) => h.toLowerCase())) : undefined;

  const start = async () => {
    try {
      const info = await sidecar.getExplorerInfo();
      bootId = info.bootId;
      if (lastSeq < 0) lastSeq = info.latestSeq;
      else if (lastSeq + 1 < info.oldestSeq) args.onReset?.({ reason: "gap", bootId: info.bootId, oldestSeq: info.oldestSeq, lastSeq });
      const sub = await sidecar.subscribe("explorer", () => [lastSeq], (r) => {
        if (stopped) return;
        let ev: LifecycleEvent;
        try { ev = parseEvent(r); } catch (e) { return args.onError?.(wrap(e)); }
        if (ev.seq <= lastSeq) return; // duplicate (replayed after a resubscribe)
        lastSeq = ev.seq;
        if (filter && !filter.has(ev.hash?.toLowerCase())) return;
        args.onEvent(ev);
      }, (e) => args.onError?.(e));
      unsub = () => sub.unsubscribe();
      if (stopped) void unsub();
    } catch (e) {
      args.onError?.(wrap(e));
    }
  };

  // Restart detection: a changed bootId means seq restarted at 1.
  const check = setInterval(async () => {
    if (stopped || !bootId) return;
    try {
      const info = await sidecar.getExplorerInfo();
      if (info.bootId !== bootId) {
        args.onReset?.({ reason: "restart", bootId: info.bootId, oldestSeq: info.oldestSeq, lastSeq });
        bootId = info.bootId;
        lastSeq = 0;
        await unsub?.();
        void start();
      }
    } catch { /* transient; the socket layer reports */ }
  }, 30_000);

  void start();
  return () => { stopped = true; clearInterval(check); void unsub?.(); };
}

// ---------------------------------------------------------------- raw mempool streams (normalized names)

export interface MempoolEvent {
  kind: "pending" | "submitted" | "onChain";
  hash: Hex;
  tx?: FrameTx;
  sender?: Address;
  payer?: Address;
  factory?: Address;
  /** On-chain tx hash that carried it (submitted / onChain). */
  transaction?: Hex;
  status?: TxStatus | string;
  revertReason?: string;
  node: NodeIdentity;
  raw: unknown;
}

function watchMempoolKind(sidecar: AltMempoolClient, kind: MempoolEvent["kind"], onEvent: (e: MempoolEvent) => void, onError?: OnError): Unwatch {
  let stopped = false;
  let unsub: (() => Promise<void>) | undefined;
  const seen = new Set<string>();
  sidecar.subscribe(kind, () => [], (r: any) => {
    if (stopped) return;
    const hash = r?.txHash ?? r?.hash;
    const key = `${hash}:${r?.status ?? ""}:${r?.transaction ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 5000) seen.clear();
    let tx: FrameTx | undefined;
    try { tx = r?.tx ? fromWire(r.tx) : undefined; } catch { tx = undefined; }
    onEvent({ kind, hash, tx, sender: r?.sender ?? tx?.sender, payer: r?.payer, factory: r?.factory, transaction: r?.transaction ?? undefined, status: r?.status, revertReason: r?.revertReason ?? undefined, node: sidecar.node, raw: r });
  }, onError).then((s) => { unsub = () => s.unsubscribe(); if (stopped) void unsub(); }, (e) => onError?.(wrap(e)));
  return () => { stopped = true; void unsub?.(); };
}

/** Frame txs validated into this node's mempool (`pendingUserOps`). */
export const watchPendingTransactions = (s: AltMempoolClient, onEvent: (e: MempoolEvent) => void, onError?: OnError) => watchMempoolKind(s, "pending", onEvent, onError);
/** Frame txs submitted on chain, reverted or removed (`submittedUserOps`). */
export const watchSubmittedTransactions = (s: AltMempoolClient, onEvent: (e: MempoolEvent) => void, onError?: OnError) => watchMempoolKind(s, "submitted", onEvent, onError);
/** Frame txs confirmed on chain (`onChainUserOps`). */
export const watchOnChainTransactions = (s: AltMempoolClient, onEvent: (e: MempoolEvent) => void, onError?: OnError) => watchMempoolKind(s, "onChain", onEvent, onError);

// ---------------------------------------------------------------- one transaction

export interface TransactionUpdate {
  hash: Hex;
  status?: TxStatus;
  previous?: TxStatus;
  event?: LifecycleEvent;
  statusResult?: FrameTxStatus;
  receipt?: FrameReceipt;
  final: boolean;
  via: "ws" | "poll";
}

export interface WatchTransactionArgs {
  onUpdate: (u: TransactionUpdate) => void;
  onError?: OnError;
  pollingIntervalMs?: number;
  /** "auto": WebSocket events when configured, polling always (it backs up the socket and fetches the receipt). */
  transport?: "auto" | "poll";
}

/** Follow one tx to a final status (OnChain / Finalized / Cancelled / Reverted), then fetch its frame receipt. */
export function watchTransaction(sidecar: AltMempoolClient, hash: Hex, args: WatchTransactionArgs): Unwatch {
  let stopped = false;
  let last: TxStatus | undefined;
  let done = false;
  const interval = args.pollingIntervalMs ?? 2_000;

  const finish = async (via: "ws" | "poll", statusResult?: FrameTxStatus) => {
    if (done) return;
    done = true;
    let receipt: FrameReceipt | undefined;
    if (last === "OnChain" || last === "Finalized" || last === "Reverted") {
      for (let i = 0; i < 10 && !receipt && !stopped; i++) {
        receipt = (await sidecar.getFrameTransactionReceipt(hash).catch(() => null)) ?? undefined;
        if (!receipt) await sleep(interval);
      }
    }
    if (!stopped) args.onUpdate({ hash, status: last, statusResult, receipt, final: true, via });
    stop();
  };

  const onStatus = (status: TxStatus | undefined, via: "ws" | "poll", extra: Partial<TransactionUpdate> = {}) => {
    if (!status || status === last) {
      if (extra.event) args.onUpdate({ hash, status: last, final: false, via, ...extra });
      return;
    }
    const previous = last;
    last = status;
    if (FINAL_STATUSES.includes(status)) return void finish(via, extra.statusResult);
    args.onUpdate({ hash, status, previous, final: false, via, ...extra });
  };

  let unwatchWs: Unwatch | undefined;
  if (args.transport !== "poll" && sidecar.hasWebSocket()) {
    unwatchWs = watchExplorerEvents(sidecar, {
      hashes: [hash],
      onEvent: (event) => onStatus(event.status, "ws", { event }),
      onError: args.onError,
    });
  }
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      const s = await sidecar.getTransactionStatus(hash);
      if (s) onStatus(s.status, "poll", { statusResult: s });
    } catch (e) {
      args.onError?.(wrap(e));
    }
  }, interval);
  const stop = () => { stopped = true; clearInterval(timer); unwatchWs?.(); };
  return stop;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- entities (polling)

export interface ReputationUpdate {
  address: Address;
  entry: ReputationEntry | null;
  /** Sends left before this node throttles / bans the entity, from the node's own parameters. */
  headroom?: { untilThrottled: number; untilBanned: number };
  node: NodeIdentity;
}

/** Sends left before throttle / ban: throttled when floor(seen/d) > included + throttlingSlack, banned when > included + banSlack. */
export const reputationHeadroom = (seen: number, included: number, p: { minInclusionDenominator: number; throttlingSlack: number; banSlack: number }) => ({
  untilThrottled: Math.max(0, (included + p.throttlingSlack + 1) * p.minInclusionDenominator - seen),
  untilBanned: Math.max(0, (included + p.banSlack + 1) * p.minInclusionDenominator - seen),
});

/** Poll `skandha_explorer_listReputation` for one entity. Reputation is node-local: the node is on every update. */
export function watchEntityReputation(sidecar: AltMempoolClient, address: Address, args: { onChange: (u: ReputationUpdate) => void; onError?: OnError; intervalMs?: number; maxPages?: number }): Unwatch {
  let stopped = false;
  let prev = "";
  const tick = async () => {
    try {
      const [config, entry] = await Promise.all([sidecar.getConfig(), findReputation(sidecar, address, args.maxPages ?? 5)]);
      const u: ReputationUpdate = { address, entry, headroom: entry ? reputationHeadroom(entry.opsSeen, entry.opsIncluded, config.reputation) : undefined, node: sidecar.node };
      const key = entry ? `${entry.status}:${entry.opsSeen}:${entry.opsIncluded}:${entry.stake}:${entry.isStaked}` : "none";
      if (key !== prev && !stopped) { prev = key; args.onChange(u); }
    } catch (e) {
      args.onError?.(wrap(e));
    }
  };
  void tick();
  const t = setInterval(tick, args.intervalMs ?? 5_000);
  return () => { stopped = true; clearInterval(t); };
}

export async function findReputation(sidecar: AltMempoolClient, address: Address, maxPages = 5): Promise<ReputationEntry | null> {
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await sidecar.listReputation({ cursor, limit: 200 });
    const hit = r.items.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (hit) return hit;
    if (!r.nextCursor) return null;
    cursor = r.nextCursor;
  }
  return null;
}

/** Poll the registry's getDepositInfo for one entity; emits when stake, delay or withdraw time change. */
export function watchEntityStake(client: Client, params: StakingParameters, entity: Address, args: { onChange: (s: EntityStake) => void; onError?: OnError; intervalMs?: number }): Unwatch {
  let stopped = false;
  let prev = "";
  const tick = async () => {
    try {
      const s = await getEntityStake(client, params, entity);
      const key = `${s.amount}:${s.unstakeDelaySec}:${s.withdrawTime}:${s.state}`;
      if (key !== prev && !stopped) { prev = key; args.onChange(s); }
    } catch (e) {
      args.onError?.(wrap(e));
    }
  };
  void tick();
  const t = setInterval(tick, args.intervalMs ?? 6_000);
  return () => { stopped = true; clearInterval(t); };
}

export const requireWebSocket = (sidecar: AltMempoolClient) => {
  if (!sidecar.hasWebSocket()) throw new UnsupportedCapabilityError("websocket", `Sidecar "${sidecar.node.name}" has no webSocketUrl.`);
};
