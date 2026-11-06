// Live reads for the monitor views. Each hook owns one @altpool/monitor watcher and stops it on unmount.
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "@altpool/core";
import {
  txReport, watchEntity, watchNetwork, webhookAlerts,
  type Alert, type AlertKind, type EntityReport, type NetworkReport, type TxReport,
} from "@altpool/monitor";
import { ago, clockAt, ethDp, num, nodesFor, type NodeChoice } from "./fmt";
import { client } from "../altpool";
import type { Tone } from "./parts";

const POLL_MS = 10_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SessionEvent { id: number; at: number; kind: string; tone: Tone; text: string; hash?: string }
export interface AlertCfg { urls: string[]; mute: AlertKind[] }
export interface AlertSent { id: number; at: number; kind: string; ok: boolean; error?: string }

export interface EntityLive {
  report?: EntityReport;
  error?: string;
  /** Inclusion hashes in the first snapshot; any other hash landed while the page was open. */
  firstSeen: ReadonlySet<Hex>;
  events: SessionEvent[];
  sent: AlertSent[];
  /** The latest finished poll (changed or not) and when the next is due. */
  poll?: { at: number; ok: boolean; nextAt: number };
}

let seq = 0;

/** watchEntity across the chosen sidecars. Alert webhooks (browser POST) fire from the same events while this page is open. */
export const useEntityLive = (addr: Address, choice: NodeChoice, fee: bigint | undefined, alerts?: AlertCfg): EntityLive => {
  const [s, setS] = useState<EntityLive>({ firstSeen: new Set(), events: [], sent: [] });
  const cfg = useRef(alerts);
  cfg.current = alerts;
  const feeKey = fee?.toString();

  useEffect(() => {
    setS({ firstSeen: new Set(), events: [], sent: [] });
    let alive = true;
    let stop = () => {};
    let seeded = false;
    const push = (kind: string, tone: Tone, text: string, hash?: string) =>
      alive && setS((p) => ({ ...p, events: [{ id: ++seq, at: Date.now(), kind, tone, text, hash }, ...p.events].slice(0, 40) }));
    const fire = (k: keyof ReturnType<typeof webhookAlerts>, ...a: unknown[]) => {
      const c = cfg.current;
      if (!c?.urls.length) return;
      const hooks = webhookAlerts(addr, c.urls, {
        mute: c.mute,
        onSent: (al: Alert, ok, error) => alive && setS((p) => ({ ...p, sent: [{ id: ++seq, at: Date.now(), kind: al.kind, ok, error }, ...p.sent].slice(0, 20) })),
      });
      (hooks[k] as ((...x: unknown[]) => void) | undefined)?.(...a);
    };
    const start = () => {
      stop = watchEntity(addr, {
        nodes: nodesFor(choice), feePerTx: fee, intervalMs: POLL_MS,
        onPoll: (poll) => setS((p) => ({ ...p, poll })),
        onStatus: (r) => {
          const first = !seeded;
          seeded = true;
          setS((p) => ({ ...p, report: r, error: undefined, firstSeen: first ? new Set(r.inclusions.map((i) => i.hash)) : p.firstSeen }));
        },
        onInclusion: (i) => { push("included", "ok", `block ${num(i.block)}${i.verifyGas !== undefined ? `, VERIFY ${num(i.verifyGas)}` : ""}`, i.hash); },
        onRejection: (r, ...a) => { push("rejected", "bad", `on ${r.nodes.join("+")}: ${r.failed?.rule ?? r.errorCode}`, r.hash); fire("onRejection", r, ...a); },
        onEviction: (e, ...a) => { push("evicted", "bad", `${e.kind}${e.reason ? `: ${e.reason}` : ""}`, e.hash); fire("onEviction", e, ...a); },
        onStuck: (t, ...a) => { push("stuck", "warn", `${t.status} for ${ago(t.ageMs ?? 0)}`, t.hash); fire("onStuck", t, ...a); },
        onThrottleWarning: (r, ...a) => { push("throttle warning", "warn", `${r.reputation.status}, ${r.headroom.untilThrottled} sends left`); fire("onThrottleWarning", r, ...a); },
        onLowBalance: (r, ...a) => { push("low balance", "warn", `${ethDp(r.funds.balance)}, ${r.funds.txsLeft} txs left`); fire("onLowBalance", r, ...a); },
        onStakeChange: (p, n, ...a) => { push("stake changed", "warn", `${n.isStaked ? "staked" : "unstaked"} ${ethDp(n.amount)}${n.withdrawTime ? ", unlocking" : ""}`); fire("onStakeChange", p, n, ...a); },
        onError: (e) => setS((p) => ({ ...p, error: message(e) })),
      });
    };
    // Deferred a tick so StrictMode's throwaway mount never starts a watcher.
    const boot = setTimeout(() => alive && start(), 0);
    return () => { alive = false; clearTimeout(boot); stop(); };
  }, [addr, choice, feeKey]);
  return s;
};

export interface Poll<T> { value?: T; error?: string; at?: number }

/** Reads one transaction every 3 s until it is final (mined, cancelled, reverted, or rejected). */
export const useTxLive = (hash: Hex, choice: NodeChoice): Poll<TxReport> & { final: boolean } => {
  const [s, setS] = useState<Poll<TxReport> & { final: boolean }>({ final: false });
  useEffect(() => {
    setS({ final: false });
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await txReport(hash, { nodes: nodesFor(choice) });
        if (!alive) return;
        const final = r.status === "OnChain" || r.status === "Finalized" || r.status === "Cancelled" || r.status === "Reverted" || r.nodes.some((n) => n.outcome === "rejected");
        setS({ value: r, final, at: r.updatedAt });
        if (!final) t = setTimeout(tick, 3000);
      } catch (e) {
        if (!alive) return;
        setS((p) => ({ ...p, error: message(e) }));
        t = setTimeout(tick, 5000);
      }
    };
    const boot = setTimeout(() => void tick(), 0);
    return () => { alive = false; clearTimeout(boot); clearTimeout(t); };
  }, [hash, choice]);
  return s;
};

/** The network report refreshes every 30 s: these are the heaviest explorer reads. */
export const useNetworkLive = (choice: NodeChoice): Poll<NetworkReport> => {
  const [s, setS] = useState<Poll<NetworkReport>>({});
  useEffect(() => {
    setS({});
    let alive = true;
    let stop = () => {};
    const boot = setTimeout(() => {
      if (!alive) return;
      stop = watchNetwork({
        nodes: nodesFor(choice),
        onReport: (r) => alive && setS({ value: r, at: r.updatedAt }),
        onError: (e) => alive && setS((p) => ({ ...p, error: message(e) })),
      });
    }, 0);
    return () => { alive = false; clearTimeout(boot); stop(); };
  }, [choice]);
  return s;
};

export const liveLabel = (at?: number, error?: string) => (error ? "poll failed, retrying" : at ? `updated ${clockAt(at)}` : "connecting…");

/** A clock that ticks every `ms`, for "updated 4 s ago" lines. */
export const useNow = (ms = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
};

const blockTimes = new Map<number, number>();
/** Block timestamps (ms) for the given blocks, read from ethrex. Inclusions carry a block number but no time. */
export const useBlockTimes = (blocks: number[]) => {
  const [, bump] = useState(0);
  const key = blocks.join(",");
  useEffect(() => {
    let alive = true;
    const missing = blocks.filter((b) => !blockTimes.has(b)).slice(0, 30);
    if (!missing.length) return;
    void Promise.all(missing.map((b) => client.getBlock({ blockNumber: BigInt(b) }).then((x) => { blockTimes.set(b, Number(x.timestamp) * 1000); }).catch(() => {})))
      .then(() => alive && bump((n) => n + 1));
    return () => { alive = false; };
  }, [key]);
  return (b: number) => blockTimes.get(b);
};

export const useCopy = () => {
  const [done, setDone] = useState<string>();
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(undefined), 1500); return () => clearTimeout(t); }, [done]);
  return [done, (text: string) => { void navigator.clipboard?.writeText(text).then(() => setDone(text), () => {}); }] as const;
};
