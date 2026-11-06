// The network view, for the devnet team: node health, gossip between the sidecars, every entity by headroom, and live
// numbers behind our rule findings (docs/10). Explorer pages hold at most 200 items, so everything is "recent".
import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkEntity, NetworkReport } from "@altpool/monitor";
import { Card, CardBar, cx } from "../components/ui";
import { clockAt, DEVNET, ethDp, KNOWN, lc, num, nodesFor, secs, short, type NodeChoice } from "./fmt";
import { useNetworkLive, useNow } from "./hooks";
import { Chip, Empty, EntityLink, Heading, Meter, Pulse, Skeleton, Stat, Stats, Table, Tag, Td, TEXT, type Tone } from "./parts";

const STATUS: Record<string, Tone> = { ok: "ok", throttled: "warn", banned: "bad" };

const WARN = 20;
type SortKey = "headroom" | "seen" | "included" | "stake" | "status";
type Filter = "all" | "trouble" | "near" | "staked" | "unstaked" | "known";
const SORTS: { id: SortKey; label: string }[] = [
  { id: "headroom", label: "Fewest sends left" }, { id: "status", label: "Worst status first" }, { id: "seen", label: "Most sends seen" },
  { id: "included", label: "Most included" }, { id: "stake", label: "Largest stake" },
];
const RANK = { banned: 0, throttled: 1, ok: 2 } as const;
const most = (e: NetworkEntity, k: "opsSeen" | "opsIncluded") => Math.max(0, ...Object.values(e.perNode).map((p) => p[k]));
const KEY: Record<SortKey, (a: NetworkEntity, b: NetworkEntity) => number> = {
  headroom: (a, b) => a.untilThrottled - b.untilThrottled,
  status: (a, b) => RANK[a.status] - RANK[b.status] || a.untilThrottled - b.untilThrottled,
  seen: (a, b) => most(b, "opsSeen") - most(a, "opsSeen"),
  included: (a, b) => most(b, "opsIncluded") - most(a, "opsIncluded"),
  stake: (a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0),
};
const GRID = "md:grid-cols-[minmax(0,1.3fr)_104px_minmax(150px,1fr)_minmax(0,1.2fr)_110px]";
const PAGE = 25;

interface Move { address: string; dSeen: number; dHead: number; fresh: boolean; status: string }

const label = (e: NetworkEntity) => KNOWN[lc(e.address)]?.label;
const perNodeText = (e: NetworkEntity) => Object.entries(e.perNode).map(([n, p]) => `${n} ${num(p.opsSeen)}/${num(p.opsIncluded)}`).join(" · ");

const Row = ({ e }: { e: NetworkEntity }) => (
  <li className={cx("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-ln px-4 py-3 last:border-b-0", GRID)}>
    <span className="min-w-0 truncate font-mono text-[13px]"><EntityLink addr={e.address} /> {label(e) && <span className="text-dim">{short(e.address)}</span>}</span>
    <span><Tag tone={STATUS[e.status] ?? "muted"}>{e.status}</Tag></span>
    <span className="flex items-center gap-3 max-md:col-span-2">
      <span className="w-full min-w-[80px] max-w-[200px] flex-1"><Meter value={e.untilThrottled} max={200} tone={e.status !== "ok" ? "bad" : e.untilThrottled <= WARN ? "warn" : "ok"} label={`${e.untilThrottled} sends left before throttling`} ticks={[{ at: WARN, label: "warn at 20", className: "bg-warn" }]} /></span>
      <span className={cx("w-16 flex-none text-right font-mono text-[12.5px] tabular-nums", e.untilThrottled <= WARN ? "text-warn" : "text-fg1")}>{num(e.untilThrottled)}<span className="text-dim"> left</span></span>
    </span>
    <span className="font-mono text-[12px] text-fg2 max-md:col-span-2">{perNodeText(e) || "not seen"}</span>
    <span className="text-right font-mono text-[12.5px] tabular-nums max-md:col-span-2 max-md:text-left">{e.isStaked ? <span className="text-ok">{ethDp(e.stake, 3)}</span> : <span className="text-dim">unstaked</span>}</span>
  </li>
);

const Mini = ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-2 bg-s1 p-4">
    <div><div className="text-[14px] text-fg">{title}</div><div className="font-mono text-[12px] text-fg2">{sub}</div></div>
    {children}
  </div>
);

const Entities = ({ r }: { r: NetworkReport }) => {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("headroom");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [moves, setMoves] = useState<Move[]>();
  const prev = useRef<NetworkReport>(undefined);

  // Movers compare this refresh with the last one this page saw. The first read has nothing to compare.
  useEffect(() => {
    const p = prev.current;
    prev.current = r;
    if (!p || p === r) return;
    const before = new Map(p.entities.map((e) => [e.address, e]));
    const total = (e: NetworkEntity) => Object.values(e.perNode).reduce((s, x) => s + x.opsSeen, 0);
    setMoves(r.entities.flatMap((e): Move[] => {
      const o = before.get(e.address);
      const m = { address: e.address, dSeen: total(e) - (o ? total(o) : 0), dHead: e.untilThrottled - (o?.untilThrottled ?? e.untilThrottled), fresh: !o, status: e.status };
      return m.dSeen || m.dHead || m.fresh || o?.status !== e.status ? [m] : [];
    }).sort((a, b) => Math.abs(b.dSeen) - Math.abs(a.dSeen)).slice(0, 5));
  }, [r]);

  const counts = useMemo(() => ({
    all: r.entities.length, trouble: r.entities.filter((e) => e.status !== "ok").length,
    near: r.entities.filter((e) => e.status === "ok" && e.untilThrottled <= WARN).length,
    staked: r.entities.filter((e) => e.isStaked).length, unstaked: r.entities.filter((e) => !e.isStaked).length,
    known: r.entities.filter((e) => KNOWN[lc(e.address)]).length,
  }), [r.entities]);
  const rows = useMemo(() => {
    const t = lc(q.trim());
    return r.entities
      .filter((e) => (filter === "all" || (filter === "trouble" ? e.status !== "ok" : filter === "near" ? e.status === "ok" && e.untilThrottled <= WARN : filter === "staked" ? e.isStaked : filter === "unstaked" ? !e.isStaked : !!KNOWN[lc(e.address)]))
        && (!t || lc(e.address).includes(t) || lc(label(e) ?? "").includes(t)))
      .sort(KEY[sort]);
  }, [r.entities, q, sort, filter]);
  const closest = useMemo(() => [...r.entities].sort(KEY.status).slice(0, 5), [r.entities]);
  const reset = () => setShown(PAGE);

  return (
    <Card className="overflow-hidden">
      <CardBar><span className="text-fg">Entities · {num(r.entities.length)}</span><span>throttled when seen/10 &gt; included + {DEVNET.reputation.throttlingSlack}</span></CardBar>
      <div className="grid grid-cols-1 gap-px border-b border-ln bg-ln min-[861px]:grid-cols-2">
        <Mini title="Closest to throttling" sub="banned or throttled first, then fewest sends left">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {closest.map((e) => (
              <li key={e.address} className="flex items-center justify-between gap-3 font-mono text-[12.5px]"><EntityLink addr={e.address} /><span className={TEXT[STATUS[e.status] ?? "muted"]}>{e.status === "ok" ? `${num(e.untilThrottled)} left` : e.status}</span></li>
            ))}
          </ul>
        </Mini>
        <Mini title="Moved since the last refresh" sub="biggest change in sends seen, this page only">
          {moves === undefined ? <p className="m-0 text-[13px]/[20px] text-fg2">Movers appear after the next refresh, in under 30 s.</p>
            : moves.length === 0 ? <p className="m-0 text-[13px]/[20px] text-fg2">No entity changed in the last 30 s.</p> : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {moves.map((m) => (
                  <li key={m.address} className="flex items-center justify-between gap-3 font-mono text-[12.5px]">
                    <EntityLink addr={m.address} />
                    <span className="text-fg2">{m.fresh ? <Tag tone="info">new</Tag> : <>{m.dSeen !== 0 && <span className="text-fg1">{m.dSeen > 0 ? "+" : ""}{num(m.dSeen)} seen</span>}{m.dHead !== 0 && <> · {num(m.dHead)} left</>}</>}</span>
                  </li>
                ))}
              </ul>
            )}
        </Mini>
      </div>
      <div className="flex flex-col gap-3 border-b border-ln px-4 py-3">
        <div className="flex flex-wrap gap-3">
          <label className="sr-only" htmlFor="ent-q">Search entities by address or name</label>
          <input id="ent-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="Search address or name" spellCheck={false} autoComplete="off"
            className="min-h-11 min-w-0 flex-1 basis-56 rounded-lg border border-ln2 bg-bg px-3 font-mono text-[13px] text-fg placeholder:text-dim" />
          <label className="flex items-center gap-2 font-mono text-[12px] text-fg2 max-[560px]:w-full">Sort
            <select value={sort} onChange={(e) => { setSort(e.target.value as SortKey); reset(); }} className="min-h-11 min-w-0 flex-1 rounded-lg border border-ln2 bg-bg px-2 font-mono text-[12.5px] text-fg">
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter entities">
          {([["all", "All"], ["trouble", "Throttled or banned"], ["near", `Near, ${WARN} or fewer left`], ["staked", "Staked"], ["unstaked", "Unstaked"], ["known", "Ours"]] as [Filter, string][]).map(([id, text]) => (
            <Chip key={id} on={filter === id} count={counts[id]} tone={id === "trouble" ? "bad" : id === "near" ? "warn" : undefined} onClick={() => { setFilter(id); reset(); }}>{text}</Chip>
          ))}
        </div>
      </div>
      {rows.length === 0 ? <Empty>{r.entities.length ? "No entity matches that search and filter." : "No entities in the reputation tables."}</Empty> : (
        <>
          <div aria-hidden="true" className={cx("hidden gap-x-4 border-b border-ln px-4 py-2 font-mono text-[11.5px] text-fg2 md:grid", GRID)}>
            <span>Entity</span><span>Status</span><span>Sends left before throttling</span><span>Seen / included, per node</span><span className="text-right">Stake</span>
          </div>
          <ul className="m-0 list-none p-0">{rows.slice(0, shown).map((e) => <Row key={e.address} e={e} />)}</ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ln px-4 py-3 font-mono text-[12px] text-fg2" role="status">
            <span>Showing {num(Math.min(shown, rows.length))} of {num(rows.length)} matching</span>
            {rows.length > shown && <button type="button" onClick={() => setShown(shown + PAGE)} className="min-h-11 rounded-lg border border-ln2 px-5 text-fg1 hover:border-amberln hover:text-amber">Show {Math.min(PAGE, rows.length - shown)} more</button>}
          </div>
        </>
      )}
    </Card>
  );
};

const Report = ({ r }: { r: NetworkReport }) => {
  const up = r.nodes.filter((n) => n.ok);
  const bad = r.entities.filter((e) => e.status !== "ok");
  const near = r.entities.filter((e) => e.status === "ok" && e.untilThrottled <= 20);
  const pending = up.reduce((s, n) => s + n.pending, 0);
  const slowest = r.propagation.filter((p) => p.medianMs !== undefined).sort((a, b) => b.medianMs! - a.medianMs!)[0];
  const names = r.nodes.map((n) => n.name);
  const shared = r.findings.sharedShare;
  const findings: { title: string; tone: Tone; value: string; body: React.ReactNode }[] = [
    { title: "Txs reach both sidecars", tone: (shared ?? 1) < 0.95 ? "bad" : "ok", value: shared !== undefined ? `${Math.round(shared * 100)}%` : "n/a",
      body: `of recent txs are on every node. ${Object.entries(r.onlyOn).map(([k, v]) => `${num(v)} only on the ${k}`).join(", ")}. On Nov 6 the gateway did not pass exits on to the miner. Gossip works now (median ${r.propagation.map((p) => `${p.from} to ${p.to} ${secs(p.medianMs)}`).join(", ")}).` },
    { title: "Rejections echo the public gas cap", tone: r.findings.echoedGasCap ? "warn" : "ok", value: num(r.findings.echoedGasCap),
      body: "recent rejected admissions record \"prefix gas budget exceeded\", the public mempool's limit, instead of their cause (a replay's used nonce key). frame-doctor re-simulates to find it." },
    { title: "Seen, never included", tone: r.findings.seenNeverIncluded ? "warn" : "ok", value: num(r.findings.seenNeverIncluded),
      body: "entities have ops seen but none included on some node. On Nov 6 the gateway counted no inclusions at all, so busy entities throttled after about 110 sends. Inclusions are counted again now." },
  ];

  return (
    <>
      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Network headline</span><span>chain {DEVNET.chainId} · {names.join(" + ")} · recent history only</span></CardBar>
        <Stats cols={4}>
          <Stat label="Nodes" tone={up.length === r.nodes.length ? "ok" : "bad"} big={`${up.length} / ${r.nodes.length} up`} sub={r.nodes.map((n) => `${n.name} ${n.ok ? `${num(n.latencyMs ?? 0)} ms` : "down"}`).join(" · ")} />
          <Stat label="Entities" tone={bad.length ? "bad" : near.length ? "warn" : "ok"} big={num(r.entities.length)}
            sub={<>{bad.length ? <span className="text-bad">{num(bad.length)} throttled or banned</span> : "none throttled or banned"}{near.length > 0 && <> · <span className="text-warn">{num(near.length)} near</span></>}</>} />
          <Stat label="Pending" tone="info" big={num(pending)} sub={`${up.map((n) => `${n.name} ${num(n.pending)}`).join(" · ")} (of the latest 200 each)`} />
          <Stat label="Gossip" tone={slowest && slowest.medianMs! > 5000 ? "warn" : "info"} big={slowest ? secs(slowest.medianMs) : "n/a"}
            sub={slowest ? `median, ${slowest.from} to ${slowest.to} (slowest way)${shared !== undefined ? ` · ${Math.round(shared * 100)}% reach both` : ""}` : "not enough shared txs"} />
        </Stats>
      </Card>

      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Findings, live</span><span>research repo docs/10</span></CardBar>
        <div className="grid grid-cols-1 gap-px bg-ln min-[861px]:grid-cols-3">
          {findings.map((f) => (
            <div key={f.title} className="flex flex-col gap-1.5 bg-s1 p-4">
              <span className="font-mono text-[12px] text-fg2"><Tag tone={f.tone}>{f.title}</Tag></span>
              <span className={`text-[28px]/[1.15] font-light tabular-nums ${TEXT[f.tone]}`}>{f.value}</span>
              <p className="m-0 text-[13px]/[20px] text-fg2">{f.body}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Gossip between sidecars</span><span>sent to one node (rpc), heard by the other (gossip)</span></CardBar>
        {r.propagation.length ? (
          <Table head={["From", "To", "Samples", "Median", "p90", "Max"]} right={[2, 3, 4, 5]}>
            {r.propagation.map((p) => (
              <tr key={p.from + p.to}>
                <Td>{p.from}</Td><Td>{p.to}</Td><Td right>{num(p.samples)}</Td><Td right>{secs(p.medianMs)}</Td><Td right>{secs(p.p90Ms)}</Td>
                <Td right className={p.maxMs !== undefined && p.maxMs > 10_000 ? "text-warn" : ""}>{secs(p.maxMs)}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>One node only, so there is nothing to compare.</Empty>}
      </Card>

      <Entities r={r} />

      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Nodes</span><span /></CardBar>
        <Table head={["Node", "Status", "Version", "Bundling", "Peers", "Latest seq", "Reputation rows", "Rejected (recent)"]} right={[4, 5, 6, 7]}>
          {r.nodes.map((n) => (
            <tr key={n.name}>
              <Td>{n.name}<div className="break-all text-[12px] text-fg2">{n.url}</div></Td>
              <Td className="whitespace-nowrap">{n.ok ? <><Tag tone="ok">up</Tag> <span className="text-fg2">{num(n.latencyMs ?? 0)} ms</span></> : <><Tag tone="bad">down</Tag> <span className="text-fg2">{n.error}</span></>}</Td>
              <Td>{n.version ?? "n/a"}</Td>
              <Td>{n.bundlingMode ? <Tag tone={n.bundlingMode === "auto" ? "ok" : "info"}>{n.bundlingMode}</Tag> : "n/a"}</Td>
              <Td right>{n.peers !== undefined ? num(n.peers) : "n/a"}</Td>
              <Td right>{n.latestSeq !== undefined ? num(n.latestSeq) : "n/a"}</Td>
              <Td right>{num(n.reputationEntries)}{n.reputationTruncated && <span className="text-warn" title="more pages existed than were read">+</span>}</Td>
              <Td right>{num(n.rejectedRecent)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <p className="m-0 font-mono text-[12px] text-fg2">updated {clockAt(r.updatedAt)} · refreshes every 30 s, since these are the heaviest explorer reads</p>
    </>
  );
};

export const Network = ({ choice }: { choice: NodeChoice }) => {
  const n = useNetworkLive(choice);
  const now = useNow(1000);
  return (
    <div className="flex flex-col gap-6">
      <Heading title="Network" sub={`every entity and node at once · ${nodesFor(choice).map((x) => x.name).join(" + ")}`}
        aside={<Pulse state={n.error ? "err" : n.value ? "live" : undefined} word={n.error ? "Read failed, retrying in 30 s." : n.value ? "Live." : "Reading."}>
          {n.error ?? (n.value ? `Updated ${Math.round((now - n.at!) / 1000)} s ago (${clockAt(n.at!)}). Refreshes every 30 s.` : "Reading every entity's reputation. This takes a few seconds.")}
        </Pulse>} />
      {n.value ? <Report r={n.value} /> : (
        <Card className="flex flex-col gap-3 p-5" aria-busy="true">
          <p className="m-0 text-[14px]/[22px] text-fg2">{n.error ? <span className="text-bad">{n.error}</span> : "Reading reputation tables, transactions and rejections from every node…"}</p>
          <Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-5/6" /><Skeleton className="h-6 w-2/3" />
        </Card>
      )}
    </div>
  );
};
