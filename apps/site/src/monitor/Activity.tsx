// The activity timeline: inclusions, evictions, rejections and pending txs in one list, newest first, with filters.
import { useMemo, useState, type ReactNode } from "react";
import { diagnoseAdmission } from "@altpool/simulator/rules";
import type { EntityReport, NodeRef } from "@altpool/monitor";
import { cx } from "../components/ui";
import { ago, clockAt, DEVNET, ethDp, explorerUrl, num } from "./fmt";
import type { SessionEvent } from "./hooks";
import { Chip, ExtLink, NodeTags, Skeleton, Tag, TxLink, Why, type Tone } from "./parts";

type Kind = "included" | "rejected" | "evicted" | "pending" | "signal";
interface Item { id: string; kind: Kind; tone: Tone; label: string; at?: number; hash?: string; nodes?: string[]; isNew?: boolean; body: ReactNode }

const FILTERS: { id: "all" | Kind; label: string; tone?: Tone }[] = [
  { id: "all", label: "All" }, { id: "included", label: "Included" }, { id: "rejected", label: "Rejected", tone: "bad" },
  { id: "evicted", label: "Evicted", tone: "bad" }, { id: "pending", label: "Pending", tone: "warn" }, { id: "signal", label: "Signals", tone: "warn" },
];
const EMPTY: Record<string, string> = {
  all: "Nothing recorded for this entity in the explorers' recent history (200 transactions per node).",
  included: "No inclusions in the recent history yet.",
  rejected: "No rejected admissions in the recent history. That is the healthy state.",
  evicted: "Nothing was dropped or replaced.",
  pending: "Nothing is waiting in a mempool right now.",
  signal: "No throttle, balance or stake signals fired since you opened this page.",
};
const PAGE = 10;
const SIGNALS = new Set(["throttle warning", "low balance", "stake changed"]);

export const Activity = ({ r, watched, events, firstSeen, now, blockTime, loading, error }: {
  r?: EntityReport; watched: NodeRef[]; events: SessionEvent[]; firstSeen: ReadonlySet<string>; now: number;
  blockTime: (b: number) => number | undefined; loading: boolean; error?: string;
}) => {
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [shown, setShown] = useState(PAGE);

  const items = useMemo<Item[]>(() => {
    if (!r) return [];
    const out: Item[] = [];
    for (const i of r.inclusions) out.push({
      id: `i${i.hash}`, kind: "included", tone: "ok", label: "included", at: blockTime(i.block), hash: i.hash, nodes: i.nodes, isNew: !firstSeen.has(i.hash),
      body: (
        <span className="font-mono text-[12.5px]/[19px] text-fg2">
          block {num(i.block)}
          {i.verifyGas !== undefined && <> · VERIFY <span className="text-fg1">{num(i.verifyGas)}</span>{i.verifyGas > DEVNET.publicVerifyGasCap && <> <Tag tone="warn" title="Above the public mempool's VERIFY gas cap: only the alt mempool admits it">over public cap</Tag></>}</>}
          {i.cost !== undefined && <> · cost {ethDp(i.cost)}</>}
        </span>
      ),
    });
    for (const rj of r.rejections) out.push({
      id: `r${rj.hash}`, kind: "rejected", tone: "bad", label: "rejected", at: rj.at, hash: rj.hash, nodes: rj.nodes,
      body: <Why d={diagnoseAdmission({ outcome: "rejected", checks: rj.checks })} detail={rj.failed?.detail ?? ""} fallback={rj.failed?.rule ?? `code ${rj.errorCode ?? "?"}`} />,
    });
    for (const e of r.evictions) out.push({
      id: `e${e.hash}`, kind: "evicted", tone: "bad", label: e.kind === "replaced" ? "replaced" : e.kind === "Cancelled" ? "cancelled" : "dropped", hash: e.hash,
      body: <span className="font-mono text-[12.5px]/[19px] text-fg2">{e.reason ?? "no reason recorded"}</span>,
    });
    for (const p of r.pending) out.push({
      id: `p${p.hash}`, kind: "pending", tone: p.stuck ? "bad" : "info", label: p.stuck ? "stuck" : "pending", at: p.ageMs !== undefined ? r.updatedAt - p.ageMs : undefined, hash: p.hash, nodes: Object.keys(p.nodes),
      body: <span className="font-mono text-[12.5px]/[19px] text-fg2">{p.status} as {p.role}{p.ageMs !== undefined && <> · waiting {ago(p.ageMs)}</>}{p.stuck && <span className="text-bad"> · past the stuck limit</span>}</span>,
    });
    for (const e of events) if (SIGNALS.has(e.kind)) out.push({
      id: `s${e.id}`, kind: "signal", tone: e.tone, label: e.kind, at: e.at, hash: e.hash,
      body: <span className="font-mono text-[12.5px]/[19px] text-fg2">{e.text}</span>,
    });
    return out.sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  }, [r, events, firstSeen, blockTime]);

  const count = (k: "all" | Kind) => (k === "all" ? items.length : items.filter((i) => i.kind === k).length);
  const list = items.filter((i) => filter === "all" || i.kind === filter);
  const visible = list.slice(0, shown);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-ln px-4 py-3" role="group" aria-label="Filter activity">
        {FILTERS.filter((f) => f.id === "all" || f.id !== "signal" || count("signal") > 0).map((f) => (
          <Chip key={f.id} on={filter === f.id} tone={f.tone} count={r ? count(f.id) : undefined} onClick={() => { setFilter(f.id); setShown(PAGE); }}>{f.label}</Chip>
        ))}
      </div>
      {!r ? (
        <div className="flex flex-col gap-4 p-4" aria-busy={loading}>
          <p className="m-0 text-[14px]/[22px] text-fg2">{error ? <span className="text-bad">{error}</span> : `Reading the last 200 transactions from ${watched.map((n) => n.name).join(" and ")}. The first read takes a few seconds.`}</p>
          {[0, 1, 2].map((i) => <div key={i} className="flex items-center gap-3"><Skeleton className="h-5 w-20" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-4 w-12" /></div>)}
        </div>
      ) : !list.length ? (
        <p className="m-0 p-5 text-[14px]/[22px] text-fg2">{EMPTY[filter]}</p>
      ) : (
        <>
          <ol className="m-0 list-none p-0">
            {visible.map((it) => (
              <li key={it.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-b border-ln px-4 py-3.5 last:border-b-0">
                <span className="pt-0.5"><Tag tone={it.tone}>{it.label}</Tag></span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                    {it.hash && <TxLink hash={it.hash} />}
                    {it.isNew && <Tag tone="info">new since you opened this</Tag>}
                  </span>
                  {it.body}
                  {it.nodes && <NodeTags on={it.nodes} watched={watched} />}
                </div>
                <div className="flex flex-col items-end gap-1 text-right font-mono text-[12px] text-fg2">
                  <time title={it.at ? clockAt(it.at) : undefined} dateTime={it.at ? new Date(it.at).toISOString() : undefined} className="whitespace-nowrap">{it.at ? `${ago(now - it.at)} ago` : it.kind === "included" ? "…" : "time not recorded"}</time>
                  {it.hash && <ExtLink href={explorerUrl(it.hash, it.nodes)} className="text-acc">explorer</ExtLink>}
                </div>
              </li>
            ))}
          </ol>
          {list.length > shown && (
            <div className="border-t border-ln p-3 text-center">
              <button type="button" onClick={() => setShown(shown + PAGE)} className="min-h-11 rounded-md border border-ln2 px-5 font-mono text-[13px] text-fg1 hover:border-accln hover:text-acc">Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
