// Owner: Dev C. The entity view: headline cells, VERIFY gas chart, and the Activity / Rejections / Pending / Nodes tabs.
import { DEVNET } from "@altpool/core";
import type { EntityReport, NodeRef, Rejection } from "@altpool/monitor";
import { diagnoseAdmission } from "@altpool/simulator/rules";
import {
  FILL, KNOWN, TEXT, ago, chip, clock, empty, esc, eth, explainRejection, explorerUrl, lc, nodeChips, num, outLink, panelHead,
  short, sq, statCell, table, td, th, txLink, type Tone,
} from "./ui";

export type Tab = "activity" | "rejections" | "pending" | "nodes";
export interface SessionEvent { at: number; kind: string; tone: Tone; text: string; hash?: string }

/** VERIFY gas per inclusion, oldest to newest, against the public cap and our pin. */
const chart = (r: EntityReport) => {
  const pts = r.inclusions.filter((i) => i.verifyGas !== undefined).sort((a, b) => a.block - b.block);
  if (!pts.length) return `<div class="py-10 text-center text-muted">No inclusions with a VERIFY gas reading in the explorers’ recent history.</div>`;
  const pin = Number(DEVNET.verifyGasMax), cap = Number(DEVNET.publicVerifyGasCap);
  const max = Math.max(pin * 1.12, ...pts.map((p) => Number(p.verifyGas) * 1.1));
  const H = 180, y = (v: number) => H - (v / max) * (H - 12);
  const xs = pts.map((_, i) => (pts.length === 1 ? 500 : 16 + (i * 968) / (pts.length - 1)));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${xs[i]!.toFixed(1)},${y(Number(p.verifyGas)).toFixed(1)}`).join(" ");
  const area = `${line} L${xs[xs.length - 1]!.toFixed(1)},${H} L${xs[0]!.toFixed(1)},${H} Z`;
  const pct = (v: number) => `${((y(v) / H) * 100).toFixed(2)}%`;
  const last = pts[pts.length - 1]!;
  const lastY = y(Number(last.verifyGas));
  return `
  <div class="relative h-[190px]">
    <svg viewBox="0 0 1000 ${H}" preserveAspectRatio="none" class="block h-[180px] w-full" role="img"
      aria-label="VERIFY gas of the last ${pts.length} inclusions, latest ${num(last.verifyGas!)}, against the ${num(cap)} public cap and the ${num(pin)} pin">
      <defs><linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity="0.32"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="1000" y1="${y(pin)}" y2="${y(pin)}" stroke="var(--muted)" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
      <line x1="0" x2="1000" y1="${y(cap)}" y2="${y(cap)}" stroke="var(--warn)" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>
      ${pts.length > 1 ? `<path d="${area}" fill="url(#fade)"/>` : ""}
      <path d="${pts.length > 1 ? line : `M480,${lastY} L520,${lastY}`}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>
    <span class="label absolute right-0 -translate-y-full pb-0.5" style="top:${pct(pin)}">our pin ${num(pin)}</span>
    <span class="label absolute right-0 -translate-y-full pb-0.5 !text-warn" style="top:${pct(cap)}">public cap ${num(cap)}</span>
    <span class="absolute bottom-0 left-0 font-mono text-[11px] text-faint">block ${num(pts[0]!.block)}</span>
    <span class="absolute bottom-0 right-0 font-mono text-[11px] text-faint">block ${num(last.block)}</span>
  </div>`;
};

const explain = (rj: Rejection) =>
  explainRejection(diagnoseAdmission({ outcome: "rejected", checks: rj.checks }), rj.failed?.detail ?? "", rj.failed?.rule ?? `code ${rj.errorCode ?? "?"}`);

const tabBody = (r: EntityReport, tab: Tab, watched: NodeRef[], events: SessionEvent[]) => {
  if (tab === "rejections") {
    if (!r.rejections.length) return empty("No rejected admissions in the explorers’ recent history.");
    return table(th("When") + th("Tx") + th("Seen on") + th("Why"), r.rejections.map((rj) =>
      `<tr>${td(`<span class="whitespace-nowrap font-mono text-muted">${ago(r.updatedAt - rj.at)} ago</span>`)}${td(txLink(rj.hash))}${td(nodeChips(rj.nodes, watched))}${td(explain(rj))}</tr>`));
  }
  if (tab === "pending") {
    if (!r.pending.length) return empty("Nothing pending.");
    const x = r.exposure;
    const cost = new Map(x.txs.map((t) => [t.hash.toLowerCase(), t]));
    const clash = new Set(x.keyClashes.flatMap((k) => k.hashes.map((h) => h.toLowerCase())));
    const summary = `
      <div class="grid gap-px border-b border-line bg-line sm:grid-cols-3">
        <div class="bg-panel px-4 py-3 sm:px-5"><div class="label">Worst case owed</div><div class="font-mono text-[15px]">${eth(x.total)} <span class="text-muted">for ${num(x.txs.length)} pending</span></div></div>
        <div class="bg-panel px-4 py-3 sm:px-5"><div class="label">${sq(x.uncovered ? "bad" : "ok")}Covered by balance</div><div class="font-mono text-[15px] ${x.uncovered ? "text-bad" : "text-accent"}">${x.uncovered ? `${num(x.uncovered)} at risk` : "all"}</div><div class="text-[12px] text-muted">${x.uncovered ? "the sidecar cancels the newest first" : `${eth(r.funds.balance)} balance`}</div></div>
        <div class="bg-panel px-4 py-3 sm:px-5"><div class="label">${sq(x.keyClashes.length ? "warn" : "ok")}Nonce-key clashes</div><div class="font-mono text-[15px] ${x.keyClashes.length ? "text-warn" : "text-accent"}">${x.keyClashes.length ? num(x.keyClashes.length) : "none"}</div><div class="text-[12px] text-muted">${x.keyClashes.length ? "only one tx per key can land" : "every pending tx has its own key"}</div></div>
      </div>`;
    return summary + table(th("Tx") + th("Status") + th("Age", true) + th("Worst case", true) + th("Running total", true) + th("On nodes") + th("Flags"), r.pending.map((p) => {
      const c = cost.get(p.hash.toLowerCase());
      const flags = [p.stuck && chip("stuck", "bad"), c && !c.covered && chip("not covered", "bad"), clash.has(p.hash.toLowerCase()) && chip("key clash", "warn")].filter(Boolean).join("");
      return `<tr>${td(txLink(p.hash))}${td(`<span class="font-mono">${esc(p.status)}</span> <span class="text-muted">as ${esc(p.role)}</span>`)}${td(p.ageMs !== undefined ? ago(p.ageMs) : "—", "text-right font-mono")}${td(c ? eth(c.maxCost, 5) : `<span class="text-faint">not paid by it</span>`, "text-right font-mono")}${td(c ? `<span class="${c.covered ? "" : "text-bad"}">${eth(c.cumulative, 5)}</span>` : "—", "text-right font-mono")}${td(nodeChips(Object.keys(p.nodes), watched))}${td(flags || `<span class="text-muted">—</span>`)}</tr>`;
    }));
  }
  if (tab === "nodes") {
    return table(th("Node") + th("Status") + th("Latency", true) + th("Seen / included", true) + th("URL"), r.nodes.map((n) =>
      `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span>`)}${td(n.ok ? `${sq("ok")}<span class="text-accent">up</span>` : `${sq("bad")}<span class="text-bad">down</span> <span class="text-muted">${esc(n.error ?? "")}</span>`)}${td(n.latencyMs !== undefined ? `${num(n.latencyMs)} ms` : "—", "text-right font-mono")}${td(`${n.reputation ? `${num(n.reputation.opsSeen)} / ${num(n.reputation.opsIncluded)}` : `<span class="text-muted">not seen</span>`}${n.reputationError ? `<div class="text-[11px] text-warn" title="${esc(n.reputationError)}">stale${n.reputationAt ? `, from ${clock(n.reputationAt)}` : ""}</div>` : ""}`, "text-right font-mono")}${td(`<span class="break-all font-mono text-[12px] text-muted">${esc(n.url)}</span>`)}</tr>`));
  }
  const inclusions = r.inclusions.length
    ? table(th("Tx") + th("Block", true) + th("VERIFY gas", true) + th("Cost", true) + th("Seen on") + th(""), r.inclusions.map((i) =>
        `<tr>${td(txLink(i.hash))}${td(num(i.block), "text-right font-mono")}${td(i.verifyGas === undefined ? `<span class="text-muted">n/a</span>` : `${num(i.verifyGas)}${i.verifyGas > DEVNET.publicVerifyGasCap ? ` ${chip("over public cap", "warn")}` : ""}`, "text-right font-mono")}${td(i.cost === undefined ? "—" : eth(i.cost), "text-right font-mono")}${td(nodeChips(i.nodes, watched))}${td(outLink(explorerUrl(i.hash, i.nodes), "explorer"))}</tr>`))
    : empty("No inclusions in the explorers’ recent history.");
  const evictions = r.evictions.length
    ? `<div class="label border-t border-line px-5 pb-1 pt-4">Evicted</div>` + table(th("Tx") + th("Kind") + th("Reason"), r.evictions.map((e) =>
        `<tr>${td(txLink(e.hash))}${td(`<span class="font-mono text-bad">${esc(e.kind)}</span>`)}${td(`<span class="text-muted">${esc(e.reason ?? "")}</span>`)}</tr>`))
    : "";
  const log = events.length
    ? `<div class="border-t border-line px-5 py-3"><div class="label mb-1">This session</div><div class="max-h-40 overflow-auto font-mono text-[12.5px] leading-relaxed text-muted">${events.map((e) =>
        `<div>${clock(e.at)} <span class="${TEXT[e.tone]} font-semibold">${esc(e.kind)}</span> ${e.hash ? txLink(e.hash) : ""} ${esc(e.text)}</div>`).join("")}</div></div>`
    : "";
  return inclusions + evictions + log;
};

export const renderEntity = (r: EntityReport, tab: Tab, watched: NodeRef[], events: SessionEvent[]) => {
  const known = KNOWN[lc(r.address)];
  const rep = r.reputation, h = r.headroom, f = r.funds;
  const repTone: Tone = rep.status === "ok" ? "ok" : rep.status === "throttled" ? "warn" : "bad";
  const throttleAt = (rep.opsIncluded + DEVNET.reputation.throttlingSlack + 1) * DEVNET.reputation.minInclusionDenominator;
  const used = Math.min(100, Math.round((rep.opsSeen / throttleAt) * 100));
  const hTone: Tone = rep.status !== "ok" ? "bad" : h.untilThrottled <= 20 ? "warn" : "ok";
  const lowFunds = f.txsLeft !== undefined && f.txsLeft <= 5;
  const perNode = r.nodes.filter((n) => n.reputation).map((n) => `${n.name} ${n.reputation!.opsSeen}/${n.reputation!.opsIncluded}${n.reputationError ? " (stale)" : ""}`).join(" · ");
  const up = r.nodes.filter((n) => n.ok).length;
  const counts: Record<Tab, number> = { activity: r.inclusions.length, rejections: r.rejections.length, pending: r.pending.length, nodes: r.nodes.length };
  const tabTone: Partial<Record<Tab, Tone>> = { rejections: r.rejections.length ? "bad" : undefined, pending: r.pending.some((p) => p.stuck) || r.exposure.uncovered ? "bad" : r.exposure.keyClashes.length ? "warn" : undefined, nodes: up < r.nodes.length ? "bad" : undefined };

  return `
  <div class="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="m-0 text-[28px] font-semibold leading-tight">${esc(known?.label ?? "Entity")}</h1>
    <span class="break-all font-mono text-[13px] text-muted">${esc(r.address)}</span>
  </div>

  <section class="grid border border-line bg-panel sm:grid-cols-2 lg:grid-cols-4" aria-label="Headline">
    ${statCell("Stake", r.stake.withdrawTime ? "warn" : r.stake.isStaked ? "ok" : "bad",
      r.stake.withdrawTime ? "Unlocking" : r.stake.isStaked ? "Staked" : "Unstaked",
      `${eth(r.stake.amount, 3)} · delay ${num(Math.round(r.stake.unstakeDelaySec / 3600))} h`)}
    ${statCell("Reputation", repTone, esc(rep.status), `seen ${num(rep.opsSeen)} · included ${num(rep.opsIncluded)}${perNode ? `<br><span class="font-mono text-[12px] text-faint">${esc(perNode)}</span>` : ""}`)}
    ${statCell("Headroom", hTone, `${num(h.untilThrottled)} <span class="text-[14px] font-normal text-muted">sends</span>`,
      `until throttled · ${num(h.untilBanned)} until banned${r.throttleEta?.minutes !== undefined ? `<br><span class="text-warn">throttled in ~${num(Math.round(r.throttleEta.minutes))} min at this rate</span>` : ""}`,
      `<div class="mb-1.5 mt-2.5 h-1 bg-line"><div class="h-full ${FILL[hTone]}" style="width:${used}%"></div></div>`)}
    ${statCell("Funds", lowFunds ? "warn" : "info", eth(f.balance),
      [f.txsLeft !== undefined ? `<span class="${lowFunds ? "text-warn" : ""}">${num(f.txsLeft)} txs left</span>` : "no receipts yet",
       f.avgCost !== undefined ? `~${eth(f.avgCost)} per tx` : "",
       f.marginPerTx !== undefined ? `margin <span class="${f.marginPerTx >= 0n ? "text-accent" : "text-bad"}">${eth(f.marginPerTx)}</span>` : ""].filter(Boolean).join(" · "))}
  </section>

  <section class="mt-5 border border-line bg-panel" aria-label="Activity">
    ${panelHead(`Entity · ${esc(short(r.address))}`, `<span class="${up ? "!text-accent" : "!text-bad"}">${up ? "● streaming" : "● no node"} · ${up} of ${r.nodes.length} nodes</span>`)}
    <div class="border-b border-line px-4 pb-2 pt-4 sm:px-5">
      <div class="mb-2 flex flex-wrap justify-between gap-3"><span class="label">VERIFY gas per inclusion</span><span class="label">latest ${r.inclusions[0]?.verifyGas !== undefined ? num(r.inclusions[0].verifyGas) : "—"}</span></div>
      ${chart(r)}
    </div>
    <div class="flex overflow-x-auto border-b border-line" role="tablist">
      ${(["activity", "rejections", "pending", "nodes"] as Tab[]).map((t) =>
        `<button role="tab" data-tab="${t}" aria-selected="${tab === t}" class="cursor-pointer whitespace-nowrap border-r border-line px-4 py-3 font-mono text-[13px] sm:px-5 ${tab === t ? "bg-panel-2 font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "text-muted"}">${t} <span class="${tabTone[t] ? TEXT[tabTone[t]!] : "text-faint"}">${counts[t]}</span></button>`).join("")}
    </div>
    <div class="min-h-40" role="tabpanel">${tabBody(r, tab, watched, events)}</div>
    <div class="flex flex-wrap justify-between gap-x-4 gap-y-2 border-t border-line bg-panel-2 px-4 py-3 sm:px-5">
      <span class="label !text-accent">${typeof WebSocket !== "undefined" ? "Streaming explorer events" : "Polling every 10 s"}<span class="ml-1.5 inline-block h-[13px] w-2 animate-blink bg-accent align-[-2px]"></span></span>
      <span class="label">Chain ${DEVNET.chainId} · ${esc(r.nodes.map((n) => n.name).join(" + "))} · updated ${clock(r.updatedAt)}</span>
    </div>
  </section>`;
};

/** Side by side: one compact card per entity (?entity=a,b). Each card opens the full view. */
export const renderCompare = (addrs: string[], reports: Record<string, EntityReport | undefined>, errors: Record<string, string | undefined>) => {
  const spark = (r: EntityReport) => {
    const pts = r.inclusions.filter((i) => i.verifyGas !== undefined).sort((a, b) => a.block - b.block);
    if (pts.length < 2) return `<div class="h-10 font-mono text-[12px] leading-10 text-faint">${pts.length ? `VERIFY ${num(pts[0]!.verifyGas!)}` : "no inclusions yet"}</div>`;
    const max = Math.max(Number(DEVNET.verifyGasMax) * 1.12, ...pts.map((p) => Number(p.verifyGas) * 1.1));
    const y = (v: number) => 40 - (v / max) * 36;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${(4 + (i * 292) / (pts.length - 1)).toFixed(1)},${y(Number(p.verifyGas)).toFixed(1)}`).join(" ");
    const cap = y(Number(DEVNET.publicVerifyGasCap));
    return `<svg viewBox="0 0 300 40" preserveAspectRatio="none" class="block h-10 w-full" role="img" aria-label="VERIFY gas over the last ${pts.length} inclusions">
      <line x1="0" x2="300" y1="${cap}" y2="${cap}" stroke="var(--warn)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const row = (k: string, v: string) => `<div class="flex justify-between gap-3 border-b border-line py-1.5 last:border-b-0"><span class="label">${esc(k)}</span><span class="text-right font-mono text-[13px]">${v}</span></div>`;
  const card = (a: string) => {
    const r = reports[a];
    const name = KNOWN[lc(a)]?.label ?? "Entity";
    const head = `<a href="?entity=${esc(a)}" class="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 text-ink no-underline hover:bg-panel-2 sm:px-5">
      <span class="text-[18px] font-semibold">${esc(name)}</span><span class="font-mono text-[12px] text-muted">${esc(short(a))} →</span></a>`;
    if (!r) return `<section class="border border-line bg-panel">${head}<div class="px-5 py-10 text-center text-muted">${errors[a] ? `<span class="text-bad">${esc(errors[a])}</span>` : "reading…"}</div></section>`;
    const rep = r.reputation, f = r.funds;
    const repTone: Tone = rep.status === "ok" ? "ok" : rep.status === "throttled" ? "warn" : "bad";
    const up = r.nodes.filter((n) => n.ok).length;
    const latest = r.inclusions[0];
    return `<section class="border border-line bg-panel">${head}
      <div class="px-4 pt-3 sm:px-5">${spark(r)}</div>
      <div class="px-4 pb-2 pt-1 sm:px-5">
        ${row("Stake", `${sq(r.stake.isStaked ? "ok" : "bad")}<span class="${r.stake.isStaked ? "text-accent" : "text-bad"}">${r.stake.isStaked ? "staked" : "unstaked"}</span> ${eth(r.stake.amount, 3)}`)}
        ${row("Reputation", `${sq(repTone)}<span class="${TEXT[repTone]}">${esc(rep.status)}</span> ${num(rep.opsSeen)}/${num(rep.opsIncluded)}`)}
        ${row("Headroom", `${num(r.headroom.untilThrottled)} sends`)}
        ${row("Funds", `${eth(f.balance)}${f.txsLeft !== undefined ? ` · ${num(f.txsLeft)} txs` : ""}`)}
        ${row("Latest VERIFY", latest?.verifyGas !== undefined ? `${num(latest.verifyGas)} <span class="text-faint">block ${num(latest.block)}</span>` : "—")}
        ${row("Activity", `${num(r.inclusions.length)} in · <span class="${r.rejections.length ? "text-bad" : ""}">${num(r.rejections.length)} rejected</span> · <span class="${r.pending.some((p) => p.stuck) ? "text-bad" : ""}">${num(r.pending.length)} pending</span>`)}
        ${row("Nodes", `<span class="${up === r.nodes.length ? "text-accent" : "text-bad"}">${up} of ${r.nodes.length} up</span>`)}
      </div></section>`;
  };
  return `
  <div class="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="m-0 text-[28px] font-semibold leading-tight">Compare</h1>
    <span class="font-mono text-[13px] text-muted">${addrs.length} entities · same nodes, same rules</span>
  </div>
  <div class="grid gap-5 md:grid-cols-2 ${addrs.length >= 3 ? "xl:grid-cols-3" : ""}">${addrs.map(card).join("")}</div>`;
};
