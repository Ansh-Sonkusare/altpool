// The pieces of the live tracker: step rows with their chain transactions, and the sidecar lifecycle panel.
import { useEffect, useState } from "react";
import { exitUrl } from "../altpool";
import type { Fact, StepState } from "../liveExit/steps";
import { cx, ExtLink, short } from "../components/ui";
import type { ChainTx, Lifecycle } from "./steps";

export const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
const clockOf = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

/** True while the tab is in front. Browsers slow timers in a hidden tab, so the poll indicator says so. */
export const useVisible = () => {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
};

/** Pending = hollow ring, running = spinning arc, done = filled with a check, error = filled with a cross. The state is also in the label. */
export const StepDot = ({ status }: { status: StepState["status"] }) => (
  <span role="img" aria-label={status === "idle" ? "pending" : status === "running" ? "running" : status === "done" ? "done" : "failed"}
    className={cx(
      "relative grid size-6 flex-none place-items-center rounded-full border text-[12px]/none",
      status === "idle" && "border-dashed border-ln2",
      status === "running" && "border-amberln bg-amberbg",
      status === "done" && "border-okln bg-okbg text-okt",
      status === "error" && "border-bad/60 bg-bad/10 text-bad",
    )}>
    {status === "running" && <i className="absolute -inset-px rounded-full border border-transparent border-t-amber animate-spin motion-reduce:animate-none" />}
    {status === "done" ? "✓" : status === "error" ? "×" : null}
  </span>
);

const toneOf = (f: Fact) => (f.tone === "ok" ? "text-okt" : f.tone === "bad" ? "text-bad" : f.tone === "warn" ? "text-warn" : "text-fg1");

const TX_TEXT = { pending: "sent, waiting for a block", confirmed: "confirmed", failed: "failed" } as const;

/** One chain transaction: its hash links to the miner-view explorer from the moment it is known. */
export const TxLine = ({ tx, now }: { tx: ChainTx; now: number }) => (
  <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ln bg-bg px-3 py-2 font-mono text-[12.5px]">
    <span className={cx(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]/normal before:size-[5px] before:rounded-full before:bg-current before:content-['']",
      tx.state === "confirmed" ? "border-okln bg-okbg text-okt" : tx.state === "failed" ? "border-bad/40 bg-bad/10 text-bad" : "border-amberln bg-amberbg text-amber before:animate-bl",
    )}>{tx.state === "confirmed" && tx.block !== undefined ? `confirmed, block ${tx.block.toLocaleString("en-US")}` : TX_TEXT[tx.state]}</span>
    <span className="text-fg">{tx.label}</span>
    <ExtLink href={exitUrl(tx.hash)} className="min-h-6 text-amber tabular-nums underline decoration-amberln underline-offset-4">{short(tx.hash)}</ExtLink>
    <span className="ml-auto text-fg2 tabular-nums">{secs((tx.doneAt ?? now) - tx.sentAt)}</span>
  </li>
);

export const StepRow = ({ title, sub, s, txs, now }: { title: string; sub: string; s: StepState; txs: ChainTx[]; now: number }) => (
  <li className={cx("flex gap-4 border-b border-ln px-5 py-4 last:border-b-0 max-[560px]:px-4", s.status === "idle" && "opacity-55")}>
    <StepDot status={s.status} />
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-fg">{title} <span className="text-[13px] text-fg2">{sub}</span></span>
        <span className="font-mono text-[12px] text-fg2 tabular-nums">
          {s.status === "running" && s.startedAt !== undefined ? secs(now - s.startedAt) : s.ms !== undefined ? secs(s.ms) : ""}
        </span>
      </div>
      {txs.length > 0 && <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{txs.map((t) => <TxLine key={t.hash} tx={t} now={now} />)}</ul>}
      {s.facts.length > 0 && (
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-[12.5px]/[1.5] max-[560px]:grid-cols-1 max-[560px]:gap-y-0">
          {s.facts.map((f) => (
            <div key={f.k} className="contents">
              <dt className="text-fg2">{f.k}</dt>
              <dd className={cx("m-0 break-all max-[560px]:mb-1.5", toneOf(f))}>
                {f.href ? <ExtLink href={f.href} className="underline decoration-ln2 underline-offset-4">{f.v}</ExtLink> : f.v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {s.note && <p className="m-0 text-[13px] text-warn">{s.note}</p>}
      {s.detail && (
        <details className="text-[13px] text-fg2">
          <summary className="cursor-pointer">full verdict</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-ln bg-bg p-3 font-mono text-[12px]/[1.5] text-fg1">{s.detail}</pre>
        </details>
      )}
      {s.error && <p role="alert" className="m-0 break-words font-mono text-[12.5px] text-bad">{s.error}</p>}
    </div>
  </li>
);

// The sidecar's pipeline for one transaction. Accepted is our own marker: the submit call returned the hash.
const STAGES = ["Accepted", "Pending", "Submitted", "OnChain"] as const;
const STAGE_HELP: Record<string, string> = {
  Accepted: "the sidecar took it",
  Pending: "validated, in its mempool",
  Submitted: "handed to the block builder",
  OnChain: "in a block",
  New: "in the sidecar's mempool",
  Receipt: "the receipt is readable",
  Finalized: "final",
  Reverted: "included, then failed",
  Cancelled: "dropped by the sidecar",
};
const stageOf = (status: string): number => {
  if (status === "New") return 0;
  if (status === "Finalized" || status === "Receipt") return STAGES.length - 1;
  const i = STAGES.indexOf(status as (typeof STAGES)[number]);
  return i >= 0 ? i : status === "Reverted" || status === "Cancelled" ? STAGES.length - 1 : 0;
};

/** Lifecycle of the nine-frame transaction as the sidecar reports it, with the poll that produced it. */
export const LifecyclePanel = ({ lc, now }: { lc: Lifecycle; now: number }) => {
  const visible = useVisible();
  const last = lc.events[lc.events.length - 1]!;
  const isBad = (status: string) => status === "Reverted" || status === "Cancelled";
  const bad = lc.events.find((e) => isBad(e.status));
  const good = lc.events.filter((e) => !isBad(e.status));
  const reached = Math.max(0, ...good.map((e) => stageOf(e.status)));
  const failedAt = bad ? Math.min(reached + 1, STAGES.length - 1) : -1;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-ln2 bg-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[12px] text-fg2">
        <span className="flex items-center gap-2" aria-live="polite">
          <span className="relative grid size-3 place-items-center" aria-hidden="true">
            <i className={cx("size-[7px] rounded-full", lc.live ? "bg-amber" : "bg-dim")} />
            {lc.live && <i key={lc.polls} className="absolute inset-0 rounded-full border border-amber animate-ping [animation-iteration-count:1] motion-reduce:hidden" />}
          </span>
          {lc.live
            ? <span>polling skandha_frameTransactionStatus every {secs(lc.intervalMs)}, poll {lc.polls}{lc.lastPollAt ? `, last ${secs(now - lc.lastPollAt)} ago` : ""}{visible ? "" : ", tab hidden so the browser slows it"}</span>
            : <span>polling stopped after {lc.polls} polls{lc.failedPolls ? `, ${lc.failedPolls} failed` : ""}</span>}
        </span>
        <span className="tabular-nums">{secs((lc.live ? now : last.at) - lc.sentAt)} since submit</span>
      </div>
      <ol className="m-0 grid list-none grid-cols-4 gap-2 p-0 max-[560px]:grid-cols-2">
        {STAGES.map((name, i) => {
          const failed = i === failedAt;
          const state = failed ? "failed" : bad ? (i < failedAt ? "done" : "idle") : i < reached ? "done" : i === reached ? (lc.live ? "now" : "done") : i === reached + 1 && lc.live ? "next" : "idle";
          const hit = failed ? bad : good.find((e) => stageOf(e.status) === i);
          const tone = state === "failed" ? "text-bad" : state === "done" ? "text-okt" : state === "idle" ? "text-dim" : "text-amber";
          return (
            <li key={name} className={cx("flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2",
              state === "failed" ? "border-bad/40 bg-bad/10" : state === "done" ? "border-okln bg-okbg" : state === "idle" ? "border-dashed border-ln2" : "border-amberln bg-amberbg")}>
              <span className={cx("flex items-center gap-2 font-mono text-[12px]", tone)}>
                <span aria-hidden="true">{state === "failed" ? "×" : state === "done" ? "✓" : state === "idle" ? "○" : "…"}</span>
                {failed ? bad!.status : name}
                <span className="sr-only">{state === "now" ? "current" : state === "next" ? "next" : state}</span>
              </span>
              <span className="text-[12px]/[16px] text-fg2">{STAGE_HELP[failed ? bad!.status : name]}</span>
              <span className="font-mono text-[11px] text-fg2 tabular-nums">{hit ? `${clockOf(hit.at)} (+${secs(hit.at - lc.sentAt)})` : state === "next" ? "waiting" : state === "done" ? "passed between polls" : ""}</span>
            </li>
          );
        })}
      </ol>
      <ol className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[12px]">
        {lc.events.map((e, i) => (
          <li key={i} className="flex flex-wrap gap-x-3 text-fg2">
            <span className="tabular-nums">{clockOf(e.at)}</span>
            <span className={cx("tabular-nums", i === lc.events.length - 1 ? "text-fg" : "")}>+{secs(e.at - lc.sentAt)}</span>
            <span className={cx(e.status === "Reverted" || e.status === "Cancelled" ? "text-bad" : "text-fg1")}>{e.status}</span>
            <span className="min-w-0 break-words">{e.note ?? STAGE_HELP[e.status]}</span>
          </li>
        ))}
        {lc.carriedBy && <li className="flex flex-wrap gap-x-3 text-fg2"><span>carried by chain tx</span><ExtLink href={exitUrl(lc.carriedBy)} className="text-amber">{short(lc.carriedBy)}</ExtLink></li>}
      </ol>
    </div>
  );
};
