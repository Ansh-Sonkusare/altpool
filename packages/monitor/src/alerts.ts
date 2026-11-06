// Owner: Dev C. Alerts for entity operators, and pass/fail conditions for CI.
// webhookAlerts() returns watchEntity callbacks that POST one JSON message per event. The body carries both `content`
// (Discord) and `text` (Slack, Telegram's sendMessage with chat_id in the URL), plus the structured fields.
import { formatEther } from "viem";
import type { Address } from "@altpool/core";
import type { EntityReport, WatchOptions } from "./index";

export type AlertKind = "throttle" | "unstaked" | "unlocking" | "low-balance" | "stuck" | "evicted" | "rejected" | "node-down";

export interface Alert {
  kind: AlertKind;
  entity: Address;
  label: string;
  /** One line, for a chat message. */
  message: string;
  hash?: string;
  at: number;
}

const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ETH`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export interface WebhookOptions {
  /** Shown in every message (default: the short address). */
  label?: string;
  /** Leave out these kinds (e.g. "rejected" on a busy entity). */
  mute?: AlertKind[];
  /** Called with each alert after it is sent (or fails), e.g. to log it. */
  onSent?: (a: Alert, ok: boolean, error?: string) => void;
  fetch?: typeof fetch;
}

/** POST each alert to every URL. Never throws: delivery failures go to onSent. */
export const postAlert = async (urls: string[], a: Alert, o: Pick<WebhookOptions, "onSent" | "fetch"> = {}) => {
  const body = JSON.stringify({ content: `**${a.label}** ${a.message}`, text: `${a.label}: ${a.message}`, ...a });
  await Promise.all(urls.map(async (url) => {
    try {
      const r = await (o.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      o.onSent?.(a, r.ok, r.ok ? undefined : `HTTP ${r.status}`);
    } catch (e) {
      o.onSent?.(a, false, (e as Error).message);
    }
  }));
};

/** watchEntity callbacks that turn each event into an alert. Spread into the options: watchEntity(a, { ...webhookAlerts(…) }). */
export const webhookAlerts = (entity: Address, urls: string[], o: WebhookOptions = {}): Partial<WatchOptions> => {
  const label = o.label ?? shortAddr(entity);
  const send = (kind: AlertKind, message: string, hash?: string) => {
    if (o.mute?.includes(kind)) return;
    void postAlert(urls, { kind, entity, label, message, hash, at: Date.now() }, o);
  };
  return {
    onThrottleWarning: (s) => send("throttle", s.reputation.status === "ok"
      ? `is ${s.headroom.untilThrottled} sends from being throttled (seen ${s.reputation.opsSeen}, included ${s.reputation.opsIncluded})`
      : `is ${s.reputation.status} by the alt mempool`),
    onStakeChange: (prev, next) => {
      if (next.withdrawTime && !prev.withdrawTime) send("unlocking", `started unlocking its stake: it stops counting as staked, so storage-reading validation will be rejected`);
      else if (prev.isStaked && !next.isStaked) send("unstaked", `is no longer staked (${eth(next.amount)})`);
    },
    onLowBalance: (s) => send("low-balance", `has ${eth(s.funds.balance)} left, about ${s.funds.txsLeft} more txs`),
    onStuck: (t) => send("stuck", `has a tx stuck in ${t.status} for ${Math.round((t.ageMs ?? 0) / 1000)} s, seen on ${Object.keys(t.nodes).join(" + ")}`, t.hash),
    onEviction: (e) => send("evicted", `lost a tx: ${e.kind}${e.reason ? ` (${e.reason})` : ""}`, e.hash),
    onRejection: (r) => send("rejected", `had a tx rejected on ${r.nodes.join(" + ")}: ${r.failed?.rule ?? `code ${r.errorCode}`}${r.failed?.detail ? `, ${r.failed.detail.slice(0, 120)}` : ""}`, r.hash),
  };
};

// ---------------------------------------------------------------- CI

export type Condition = "throttled" | "banned" | "unstaked" | "unlocking" | "low-balance" | "stuck" | "node-down" | "rejections";
export const CONDITIONS: Condition[] = ["throttled", "banned", "unstaked", "unlocking", "low-balance", "stuck", "node-down", "rejections"];

/** The conditions that hold for this report, each with the reason. Empty = healthy. */
export const failing = (s: EntityReport, conds: Condition[], o: { lowBalanceAt?: number; throttleWarnAt?: number } = {}): { condition: Condition; reason: string }[] => {
  const out: { condition: Condition; reason: string }[] = [];
  const has = (c: Condition) => conds.includes(c);
  if (has("banned") && s.reputation.status === "banned") out.push({ condition: "banned", reason: `reputation is banned (seen ${s.reputation.opsSeen}, included ${s.reputation.opsIncluded})` });
  if (has("throttled") && (s.reputation.status !== "ok" || s.headroom.untilThrottled <= (o.throttleWarnAt ?? 0)))
    out.push({ condition: "throttled", reason: s.reputation.status !== "ok" ? `reputation is ${s.reputation.status}` : `${s.headroom.untilThrottled} sends left before throttling` });
  if (has("unstaked") && !s.stake.isStaked) out.push({ condition: "unstaked", reason: `not staked (${eth(s.stake.amount)}, delay ${s.stake.unstakeDelaySec} s)` });
  if (has("unlocking") && s.stake.withdrawTime) out.push({ condition: "unlocking", reason: `stake unlocking, withdrawable at ${new Date(Number(s.stake.withdrawTime) * 1000).toISOString()}` });
  if (has("low-balance") && s.funds.txsLeft !== undefined && s.funds.txsLeft <= (o.lowBalanceAt ?? 5))
    out.push({ condition: "low-balance", reason: `${eth(s.funds.balance)} pays for about ${s.funds.txsLeft} more txs` });
  if (has("stuck")) for (const p of s.pending.filter((x) => x.stuck)) out.push({ condition: "stuck", reason: `${p.hash} ${p.status} for ${Math.round((p.ageMs ?? 0) / 1000)} s` });
  if (has("node-down")) for (const n of s.nodes.filter((x) => !x.ok)) out.push({ condition: "node-down", reason: `${n.name}: ${n.error ?? "down"}` });
  if (has("rejections") && s.rejections.length) out.push({ condition: "rejections", reason: `${s.rejections.length} rejected admissions, latest ${s.rejections[0]!.hash}` });
  return out;
};
