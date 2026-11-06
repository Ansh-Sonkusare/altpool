// Owner: Dev C. One entity, live, across the gateway and the miner's sidecar: stake, reputation and headroom, funds,
// VERIFY gas per inclusion, rejections explained, pending txs per node, node health.
// URL: ?entity=0x…[&node=both|gateway|miner][&fee=0.01]. Talks to the sidecars and ethrex directly (all allow any origin).
import "./style.css";
import { formatEther, parseEther } from "viem";
import { DEVNET, explorerTx, type Address } from "@altpool/core";
import { DEFAULT_NODES, watchEntity, type EntityReport, type NodeRef, type Rejection } from "@altpool/monitor";
import { diagnoseAdmission } from "@altpool/simulator/rules";
import deployments from "../../../packages/contracts/deployments.json";

// ---------------------------------------------------------------- setup

const EXIT_FEE = 10n ** 16n; // packages/contracts/src/exit.ts (not imported: that module is Node-only)
const lc = (a: string) => a.toLowerCase();
const KNOWN: Record<string, { label: string; fee?: bigint }> = {};
if (deployments.exitRelay) KNOWN[lc(deployments.exitRelay)] = { label: "ExitRelay", fee: EXIT_FEE };
if (deployments.exitRelayRR) KNOWN[lc(deployments.exitRelayRR)] = { label: "ExitRelayRR", fee: EXIT_FEE };

type NodeChoice = "both" | "gateway" | "miner";
type Tab = "activity" | "rejections" | "pending" | "nodes";
const params = new URLSearchParams(location.search);
const isAddress = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);
const store = {
  get: (k: string) => { try { return localStorage.getItem(`altpool.${k}`) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`altpool.${k}`, v); } catch { /* private mode */ } },
};

const state = {
  entity: (params.get("entity") ?? store.get("entity")) as string,
  node: ((params.get("node") as NodeChoice) || "both") as NodeChoice,
  fee: params.get("fee") ? parseEther(params.get("fee")!) : undefined,
  tab: ((store.get("tab") as Tab) || "activity") as Tab,
  report: undefined as EntityReport | undefined,
  error: undefined as string | undefined,
  events: [] as { at: number; kind: string; tone: Tone; text: string; hash?: string; nodes?: string[] }[],
  stop: undefined as (() => void) | undefined,
};
const nodesFor = (c: NodeChoice): NodeRef[] => (c === "both" ? DEFAULT_NODES : DEFAULT_NODES.filter((n) => n.name === c));

// ---------------------------------------------------------------- formatting

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const eth = (wei: bigint, dp = 4) => `${Number(formatEther(wei)).toFixed(dp)} ETH`;
const num = (x: number | bigint) => x.toLocaleString("en-US");
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
const urlOf = (name: string) => DEFAULT_NODES.find((n) => n.name === name)?.url ?? DEVNET.gatewayUrl;
/** Explorer link on a node that has the tx (the explorer defaults to the gateway's view). */
const txUrl = (hash: string, on: string[] = []) =>
  !on.length || on.includes("gateway") ? explorerTx(hash) : `${explorerTx(hash)}?node=${encodeURIComponent(urlOf(on[0]!))}`;
const txLink = (hash: string, on?: string[]) =>
  `<a class="font-mono text-info hover:underline" href="${esc(txUrl(hash, on))}" target="_blank" rel="noreferrer">${esc(short(hash))}</a>`;

type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const TEXT: Record<Tone, string> = { ok: "text-accent", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted" };
const FILL: Record<Tone, string> = { ok: "bg-accent", warn: "bg-warn", bad: "bg-bad", info: "bg-info", muted: "bg-faint" };
const sq = (t: Tone) => `<span class="mr-2 inline-block size-2 align-[1px] ${FILL[t]}" aria-hidden="true"></span>`;
const chip = (text: string, tone: Tone, off = false, title = "") =>
  `<span class="mb-0.5 mr-1 inline-block whitespace-nowrap border px-1.5 py-px font-mono text-[11px] tracking-wide ${off ? "border-dashed text-faint" : `border-current font-semibold ${TEXT[tone]}`}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

// ---------------------------------------------------------------- shell

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
<header class="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
  <div class="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
    <a href="?" class="flex items-center gap-2.5 whitespace-nowrap text-[17px] font-semibold text-ink no-underline">
      <span class="size-3.5 rotate-45 bg-accent" aria-hidden="true"></span>altpool <span class="text-accent">monitor</span>
    </a>
    <form id="f" class="flex min-w-0 flex-[1_1_360px]">
      <label for="addr" class="sr-only">Entity address</label>
      <input id="addr" spellcheck="false" autocomplete="off" placeholder="entity address 0x…" value="${esc(state.entity)}"
        class="min-w-0 flex-1 border border-r-0 border-line bg-panel px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent" />
      <button class="cursor-pointer border border-accent bg-accent px-3.5 py-2 font-mono text-[13px] font-semibold text-accent-ink">Watch</button>
    </form>
    <div id="seg" class="inline-flex border border-line" role="group" aria-label="Which sidecars to read"></div>
    <div class="flex items-center gap-2 whitespace-nowrap">
      <span id="dot" class="size-2 bg-faint" aria-hidden="true"></span><span id="live" class="label">idle</span>
    </div>
  </div>
</header>
<main id="view" class="mx-auto max-w-[1240px] px-4 pb-14 pt-7 sm:px-6"></main>`;

const view = document.querySelector<HTMLElement>("#view")!;
const dot = document.querySelector<HTMLElement>("#dot")!;
const live = document.querySelector<HTMLElement>("#live")!;
const seg = document.querySelector<HTMLElement>("#seg")!;

const renderSeg = () => {
  seg.innerHTML = (["both", "gateway", "miner"] as NodeChoice[]).map((c) =>
    `<button data-node="${c}" aria-pressed="${state.node === c}" class="cursor-pointer border-r border-line px-3 py-2 font-mono text-[13px] last:border-r-0 ${state.node === c ? "bg-accent-soft font-semibold text-ink" : "text-muted"}">${c}</button>`).join("");
};
const setLive = (tone: "on" | "err" | "idle", text: string) => {
  dot.className = `size-2 ${tone === "on" ? "bg-accent animate-beat" : tone === "err" ? "bg-bad" : "bg-faint"}`;
  live.textContent = text;
};

// ---------------------------------------------------------------- views

const startScreen = () => {
  const picks = Object.entries(KNOWN).map(([addr, k]) =>
    `<button data-pick="${esc(addr)}" class="cursor-pointer border border-line bg-transparent px-4 py-3 text-left hover:border-accent">
      <div class="font-semibold">${esc(k.label)}</div><div class="font-mono text-[12px] text-muted">${esc(short(addr))}</div></button>`).join("");
  view.innerHTML = `
  <section class="mt-8 max-w-[760px] border border-line bg-panel p-8">
    <div class="label">Altpool · entity monitor</div>
    <h1 class="mb-3 mt-2 text-[34px] font-semibold leading-tight">Watch an alt-mempool entity, live</h1>
    <p class="mb-5 text-muted">Stake, reputation and sends left before throttling, the ETH it has to pay with, every inclusion’s VERIFY gas, and why anything was rejected. Read from the gateway and the miner’s sidecar at once.</p>
    <div class="flex flex-wrap gap-2.5">${picks}</div>
    ${state.error ? `<div class="mt-4 border border-bad px-3.5 py-2.5 font-mono text-[13px] text-bad">${esc(state.error)}</div>` : ""}
  </section>`;
};

const statCell = (label: string, tone: Tone, value: string, sub: string, extra = "") => `
  <div class="min-w-0 border-line p-4 sm:px-5 [&:not(:last-child)]:border-b lg:border-b-0 lg:[&:not(:last-child)]:border-r">
    <div class="label">${sq(tone)}${esc(label)}</div>
    <div class="mb-1 mt-1.5 break-words font-mono text-[22px] font-semibold leading-snug ${TEXT[tone]}">${value}</div>
    ${extra}
    <div class="text-[13px] text-muted">${sub}</div>
  </div>`;

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
      aria-label="VERIFY gas of the last ${pts.length} inclusions, latest ${num(last.verifyGas!)}, against the 100,000 public cap and the 450,000 pin">
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

const th = (label: string, right = false) => `<th class="whitespace-nowrap border-b border-line px-4 py-2.5 sm:px-5 ${right ? "text-right" : "text-left"}"><span class="label">${esc(label)}</span></th>`;
const td = (html: string, cls = "") => `<td class="border-b border-line px-4 py-2.5 align-top sm:px-5 ${cls}">${html}</td>`;
const table = (head: string, rows: string[]) =>
  `<div class="overflow-x-auto"><table class="w-full border-collapse text-[13.5px] [&_tr:last-child_td]:border-b-0"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const empty = (text: string) => `<div class="px-5 py-8 text-muted">${esc(text)}</div>`;

/** Chips for every watched node: solid where the node lists the tx, dashed where it never reached it. */
const nodeChips = (on: string[]) =>
  nodesFor(state.node).map((n) => (on.includes(n.name) ? chip(n.name, "info") : chip(`${n.name} —`, "muted", true, `never reached the ${n.name}`))).join("");

const explain = (rj: Rejection) => {
  const d = diagnoseAdmission({ outcome: "rejected", checks: rj.checks });
  const detail = rj.failed?.detail ?? "";
  // On Nov 6 the sidecars recorded rejected ExitRelay replays with the public mempool's gas-cap text, not the cause.
  const echoed = /prefix gas budget exceeded/.test(detail);
  return `<div class="font-mono text-[13px] font-semibold text-bad">${esc(d?.rule ?? rj.failed?.rule ?? `code ${rj.errorCode ?? "?"}`)}${d?.revertReason ? ` · ${esc(d.revertReason)}` : ""}</div>
    ${detail ? `<div class="mt-1 max-w-[70ch] break-words font-mono text-[12px] text-muted">${esc(detail.slice(0, 160))}</div>` : ""}
    <div class="mt-1 max-w-[70ch] text-[13px] text-muted">${echoed
      ? "This is the public mempool’s gas cap, echoed by the sidecar, not the cause. A replayed note shows this; run frame-doctor on the raw tx for the real reason."
      : esc(d?.fix ?? "")}</div>`;
};

const tabBody = (r: EntityReport) => {
  if (state.tab === "rejections") {
    if (!r.rejections.length) return empty("No rejected admissions in the explorers’ recent history.");
    return table(th("When") + th("Tx") + th("Seen on") + th("Why"), r.rejections.map((rj) =>
      `<tr>${td(`<span class="whitespace-nowrap font-mono text-muted">${ago(r.updatedAt - rj.at)} ago</span>`)}${td(txLink(rj.hash, rj.nodes))}${td(nodeChips(rj.nodes))}${td(explain(rj))}</tr>`));
  }
  if (state.tab === "pending") {
    if (!r.pending.length) return empty("Nothing pending.");
    return table(th("Tx") + th("Status") + th("Age", true) + th("On nodes") + th("Flag"), r.pending.map((p) =>
      `<tr>${td(txLink(p.hash, Object.keys(p.nodes)))}${td(`<span class="font-mono">${esc(p.status)}</span> <span class="text-muted">as ${esc(p.role)}</span>`)}${td(p.ageMs !== undefined ? ago(p.ageMs) : "—", "text-right font-mono")}${td(nodeChips(Object.keys(p.nodes)))}${td(p.stuck ? chip("stuck", "bad") : `<span class="text-muted">—</span>`)}</tr>`));
  }
  if (state.tab === "nodes") {
    return table(th("Node") + th("Status") + th("Latency", true) + th("Seen / included", true) + th("URL"), r.nodes.map((n) =>
      `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span>`)}${td(n.ok ? `${sq("ok")}<span class="text-accent">up</span>` : `${sq("bad")}<span class="text-bad">down</span> <span class="text-muted">${esc(n.error ?? "")}</span>`)}${td(n.latencyMs !== undefined ? `${num(n.latencyMs)} ms` : "—", "text-right font-mono")}${td(n.reputation ? `${num(n.reputation.opsSeen)} / ${num(n.reputation.opsIncluded)}` : `<span class="text-muted">not seen</span>`, "text-right font-mono")}${td(`<span class="break-all font-mono text-[12px] text-muted">${esc(n.url)}</span>`)}</tr>`));
  }
  const inclusions = r.inclusions.length
    ? table(th("Tx") + th("Block", true) + th("VERIFY gas", true) + th("Cost", true) + th("Seen on"), r.inclusions.map((i) =>
        `<tr>${td(txLink(i.hash, i.nodes))}${td(num(i.block), "text-right font-mono")}${td(i.verifyGas === undefined ? `<span class="text-muted">n/a</span>` : `${num(i.verifyGas)}${i.verifyGas > DEVNET.publicVerifyGasCap ? ` ${chip("over public cap", "warn")}` : ""}`, "text-right font-mono")}${td(i.cost === undefined ? "—" : eth(i.cost), "text-right font-mono")}${td(nodeChips(i.nodes))}</tr>`))
    : empty("No inclusions in the explorers’ recent history.");
  const evictions = r.evictions.length
    ? `<div class="label border-t border-line px-5 pb-1 pt-4">Evicted</div>` + table(th("Tx") + th("Kind") + th("Reason"), r.evictions.map((e) =>
        `<tr>${td(txLink(e.hash))}${td(`<span class="font-mono text-bad">${esc(e.kind)}</span>`)}${td(`<span class="text-muted">${esc(e.reason ?? "")}</span>`)}</tr>`))
    : "";
  const log = state.events.length
    ? `<div class="border-t border-line px-5 py-3"><div class="label mb-1">This session</div><div class="max-h-40 overflow-auto font-mono text-[12.5px] leading-relaxed text-muted">${state.events.map((e) =>
        `<div>${clock(e.at)} <span class="${TEXT[e.tone]} font-semibold">${esc(e.kind)}</span> ${e.hash ? txLink(e.hash, e.nodes) : ""} ${esc(e.text)}</div>`).join("")}</div></div>`
    : "";
  return inclusions + evictions + log;
};

const render = () => {
  const r = state.report;
  if (!r) {
    if (!isAddress(state.entity)) return startScreen();
    view.innerHTML = `<div class="mt-16 text-center text-muted">${state.error ? `<span class="text-bad">${esc(state.error)}</span>` : `Reading ${esc(short(state.entity))} from ${nodesFor(state.node).map((n) => n.name).join(" and ")}…`}</div>`;
    return;
  }
  const known = KNOWN[lc(r.address)];
  const rep = r.reputation, h = r.headroom, f = r.funds;
  const repTone: Tone = rep.status === "ok" ? "ok" : rep.status === "throttled" ? "warn" : "bad";
  const throttleAt = (rep.opsIncluded + DEVNET.reputation.throttlingSlack + 1) * DEVNET.reputation.minInclusionDenominator;
  const used = Math.min(100, Math.round((rep.opsSeen / throttleAt) * 100));
  const hTone: Tone = rep.status !== "ok" ? "bad" : h.untilThrottled <= 20 ? "warn" : "ok";
  const lowFunds = f.txsLeft !== undefined && f.txsLeft <= 5;
  const perNode = r.nodes.filter((n) => n.reputation).map((n) => `${n.name} ${n.reputation!.opsSeen}/${n.reputation!.opsIncluded}`).join(" · ");
  const up = r.nodes.filter((n) => n.ok).length;
  const counts: Record<Tab, number> = { activity: r.inclusions.length, rejections: r.rejections.length, pending: r.pending.length, nodes: r.nodes.length };
  const tabTone: Partial<Record<Tab, Tone>> = { rejections: r.rejections.length ? "bad" : undefined, pending: r.pending.some((p) => p.stuck) ? "bad" : undefined, nodes: up < r.nodes.length ? "bad" : undefined };

  view.innerHTML = `
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
    <div class="flex flex-wrap justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <span class="label">Entity · ${esc(short(r.address))}</span>
      <span class="label ${up ? "!text-accent" : "!text-bad"}">${up ? "● streaming" : "● no node"} · ${up} of ${r.nodes.length} nodes</span>
    </div>
    <div class="border-b border-line px-4 pb-2 pt-4 sm:px-5">
      <div class="mb-2 flex flex-wrap justify-between gap-3"><span class="label">VERIFY gas per inclusion</span><span class="label">latest ${r.inclusions[0]?.verifyGas !== undefined ? num(r.inclusions[0].verifyGas) : "—"}</span></div>
      ${chart(r)}
    </div>
    <div class="flex overflow-x-auto border-b border-line" role="tablist">
      ${(["activity", "rejections", "pending", "nodes"] as Tab[]).map((t) =>
        `<button role="tab" data-tab="${t}" aria-selected="${state.tab === t}" class="cursor-pointer whitespace-nowrap border-r border-line px-4 py-3 font-mono text-[13px] sm:px-5 ${state.tab === t ? "bg-panel-2 font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "text-muted"}">${t} <span class="${tabTone[t] ? TEXT[tabTone[t]!] : "text-faint"}">${counts[t]}</span></button>`).join("")}
    </div>
    <div class="min-h-40" role="tabpanel">${tabBody(r)}</div>
    <div class="flex flex-wrap justify-between gap-x-4 gap-y-2 border-t border-line bg-panel-2 px-4 py-3 sm:px-5">
      <span class="label !text-accent">${typeof WebSocket !== "undefined" ? "Streaming explorer events" : "Polling"}<span class="ml-1.5 inline-block h-[13px] w-2 animate-blink bg-accent align-[-2px]"></span></span>
      <span class="label">Chain ${DEVNET.chainId} · ${esc(r.nodes.map((n) => n.name).join(" + "))} · updated ${clock(r.updatedAt)}</span>
    </div>
  </section>`;
};

// ---------------------------------------------------------------- wiring

const log = (kind: string, tone: Tone, text: string, hash?: string, nodes?: string[]) => {
  state.events.unshift({ at: Date.now(), kind, tone, text, hash, nodes });
  state.events.length = Math.min(state.events.length, 40);
};

const watch = (addr: Address) => {
  state.stop?.();
  state.entity = addr;
  state.report = undefined;
  state.error = undefined;
  state.events = [];
  store.set("entity", addr);
  const q = new URLSearchParams({ entity: addr });
  if (state.node !== "both") q.set("node", state.node);
  if (params.get("fee")) q.set("fee", params.get("fee")!);
  history.replaceState(null, "", `?${q}`);
  setLive("idle", "connecting");
  render();
  state.stop = watchEntity(addr, {
    nodes: nodesFor(state.node),
    feePerTx: state.fee ?? KNOWN[lc(addr)]?.fee,
    onStatus: (s) => {
      state.report = s;
      state.error = undefined;
      const up = s.nodes.filter((n) => n.ok).length;
      setLive(up ? "on" : "err", up === s.nodes.length ? `live · ${clock(s.updatedAt)}` : `${up}/${s.nodes.length} nodes up`);
      render();
    },
    onInclusion: (i) => log("included", "ok", `block ${num(i.block)}${i.verifyGas !== undefined ? `, VERIFY ${num(i.verifyGas)}` : ""}`, i.hash, i.nodes),
    onRejection: (r) => log("rejected", "bad", `on ${r.nodes.join("+")}: ${r.failed?.rule ?? r.errorCode}`, r.hash, r.nodes),
    onEviction: (e) => log("evicted", "bad", `${e.kind}${e.reason ? `: ${e.reason}` : ""}`, e.hash),
    onStuck: (t) => log("stuck", "warn", `${t.status} for ${ago(t.ageMs ?? 0)}`, t.hash, Object.keys(t.nodes)),
    onThrottleWarning: (s) => log("throttle warning", "warn", `${s.reputation.status}, ${s.headroom.untilThrottled} sends left`),
    onLowBalance: (s) => log("low balance", "warn", `${eth(s.funds.balance)}, ${s.funds.txsLeft} txs left`),
    onError: (e) => {
      state.error = `Poll failed: ${(e as Error)?.message ?? String(e)}. Retrying.`;
      setLive("err", "poll failed");
      if (!state.report) render();
    },
  });
};

document.querySelector<HTMLFormElement>("#f")!.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const v = document.querySelector<HTMLInputElement>("#addr")!.value.trim();
  if (isAddress(v)) watch(v);
  else { state.error = "That is not a 20-byte 0x address."; setLive("err", "bad address"); if (!state.report) render(); }
});
seg.addEventListener("click", (ev) => {
  const c = (ev.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node as NodeChoice | undefined;
  if (!c || c === state.node) return;
  state.node = c;
  renderSeg();
  if (isAddress(state.entity)) watch(state.entity);
});
view.addEventListener("click", (ev) => {
  const el = ev.target as HTMLElement;
  const tab = el.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
  if (tab) { state.tab = tab; store.set("tab", tab); render(); return; }
  const pick = el.closest<HTMLElement>("[data-pick]")?.dataset.pick;
  if (pick && isAddress(pick)) { document.querySelector<HTMLInputElement>("#addr")!.value = pick; watch(pick); }
});

renderSeg();
if (isAddress(state.entity)) watch(state.entity);
else render();
