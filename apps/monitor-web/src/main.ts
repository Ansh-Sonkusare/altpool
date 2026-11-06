// Owner: Dev C. Shell and routing for the monitor.
//   ?entity=0x…  one entity, live, across the gateway and the miner's sidecar (entity.ts)
//   ?tx=0x…      one transaction's path across the sidecars, its frames and gas, and why it failed (tx.ts)
//   &node=both|gateway|miner, &fee=<eth> (entity view). Talks to the sidecars and ethrex directly (all allow any origin).
import "./style.css";
import { parseEther } from "viem";
import type { Address, Hex } from "@altpool/core";
import { watchEntity, watchNetwork, type EntityReport, type NetworkReport, type TxReport } from "@altpool/monitor";
import { renderCompare, renderEntity, type SessionEvent, type Tab } from "./entity";
import { renderTx, watchTx } from "./tx";
import { renderNetwork } from "./network";
import { KNOWN, ago, clock, esc, eth, isAddress, isHash, lc, nodesFor, num, short, type NodeChoice, type Tone } from "./ui";

const params = new URLSearchParams(location.search);
const store = {
  get: (k: string) => { try { return localStorage.getItem(`altpool.${k}`) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`altpool.${k}`, v); } catch { /* private mode */ } },
};

type Target = { kind: "entity"; addr: Address } | { kind: "compare"; addrs: Address[] } | { kind: "tx"; hash: Hex } | { kind: "network" } | { kind: "none" };
const state = {
  target: { kind: "none" } as Target,
  node: ((params.get("node") as NodeChoice) || "both") as NodeChoice,
  fee: params.get("fee") ? parseEther(params.get("fee")!) : undefined,
  tab: ((store.get("tab") as Tab) || "activity") as Tab,
  entity: undefined as EntityReport | undefined,
  compare: {} as Record<string, EntityReport | undefined>,
  compareErrors: {} as Record<string, string | undefined>,
  tx: undefined as TxReport | undefined,
  network: undefined as NetworkReport | undefined,
  error: undefined as string | undefined,
  events: [] as SessionEvent[],
  stop: undefined as (() => void) | undefined,
};

// ---------------------------------------------------------------- shell

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
<header class="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
  <div class="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
    <a href="?" class="flex items-center gap-2.5 whitespace-nowrap text-[17px] font-semibold text-ink no-underline">
      <span class="size-3.5 rotate-45 bg-accent" aria-hidden="true"></span>altpool <span class="text-accent">monitor</span>
    </a>
    <a id="netlink" href="?view=network" class="font-mono text-[13px] text-muted no-underline hover:text-ink">network</a>
    <form id="f" class="flex min-w-0 flex-[1_1_360px]">
      <label for="q" class="sr-only">Entity address or transaction hash</label>
      <input id="q" spellcheck="false" autocomplete="off" placeholder="address, addresses (a,b) or tx hash, 0x…"
        class="min-w-0 flex-1 border border-r-0 border-line bg-panel px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent" />
      <button class="cursor-pointer border border-accent bg-accent px-3.5 py-2 font-mono text-[13px] font-semibold text-accent-ink">Go</button>
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
const input = document.querySelector<HTMLInputElement>("#q")!;

const renderSeg = () => {
  seg.innerHTML = (["both", "gateway", "miner"] as NodeChoice[]).map((c) =>
    `<button data-node="${c}" aria-pressed="${state.node === c}" class="cursor-pointer border-r border-line px-3 py-2 font-mono text-[13px] last:border-r-0 ${state.node === c ? "bg-accent-soft font-semibold text-ink" : "text-muted"}">${c}</button>`).join("");
};
const setLive = (tone: "on" | "err" | "idle", text: string) => {
  dot.className = `size-2 ${tone === "on" ? "bg-accent animate-beat" : tone === "err" ? "bg-bad" : "bg-faint"}`;
  live.textContent = text;
};

const startScreen = () => {
  const picks = Object.entries(KNOWN).map(([addr, k]) =>
    `<a href="?entity=${esc(addr)}" class="border border-line px-4 py-3 text-ink no-underline hover:border-accent">
      <div class="font-semibold">${esc(k.label)}</div><div class="font-mono text-[12px] text-muted">${esc(short(addr))}</div></a>`).join("") +
    (Object.keys(KNOWN).length > 1 ? `<a href="?entity=${esc(Object.keys(KNOWN).join(","))}" class="border border-dashed border-line px-4 py-3 text-ink no-underline hover:border-accent">
      <div class="font-semibold">Compare</div><div class="font-mono text-[12px] text-muted">${esc(Object.values(KNOWN).map((k) => k.label).join(" vs "))}</div></a>` : "");
  return `
  <section class="mt-8 max-w-[760px] border border-line bg-panel p-8">
    <div class="label">Altpool · monitor</div>
    <h1 class="mb-3 mt-2 text-[34px] font-semibold leading-tight">See the alt mempool, live</h1>
    <p class="mb-5 text-muted">Paste an <b class="text-ink">address</b> to watch an entity: stake, reputation and sends left before throttling, the ETH it pays with, every inclusion’s VERIFY gas, and why anything was rejected. Paste a <b class="text-ink">tx hash</b> to follow one transaction across the gateway and the miner’s sidecar, or several addresses (a,b) to compare them.</p>
    <div class="flex flex-wrap gap-2.5">${picks}</div>
    ${state.error ? `<div class="mt-4 border border-bad px-3.5 py-2.5 font-mono text-[13px] text-bad">${esc(state.error)}</div>` : ""}
  </section>`;
};

const render = () => {
  const t = state.target;
  if (t.kind === "none") { view.innerHTML = startScreen(); return; }
  const loading = (what: string) =>
    `<div class="mt-16 text-center text-muted">${state.error ? `<span class="text-bad">${esc(state.error)}</span>` : `Reading ${esc(what)} from ${nodesFor(state.node).map((n) => n.name).join(" and ")}…`}</div>`;
  if (t.kind === "network") { view.innerHTML = state.network ? renderNetwork(state.network) : loading("every entity"); return; }
  if (t.kind === "compare") { view.innerHTML = renderCompare(t.addrs, state.compare, state.compareErrors); return; }
  if (t.kind === "entity") view.innerHTML = state.entity ? renderEntity(state.entity, state.tab, nodesFor(state.node), state.events) : loading(short(t.addr));
  else view.innerHTML = state.tx ? renderTx(state.tx, nodesFor(state.node)) : loading(short(t.hash));
};

// ---------------------------------------------------------------- routing

const log = (kind: string, tone: Tone, text: string, hash?: string) => {
  state.events.unshift({ at: Date.now(), kind, tone, text, hash });
  state.events.length = Math.min(state.events.length, 40);
};

const go = (target: Target, push = true) => {
  state.stop?.();
  state.stop = undefined;
  state.target = target;
  state.entity = undefined;
  state.compare = {};
  state.compareErrors = {};
  state.tx = undefined;
  state.network = undefined;
  state.error = undefined;
  state.events = [];
  const q = new URLSearchParams();
  if (target.kind === "entity") q.set("entity", target.addr);
  if (target.kind === "compare") q.set("entity", target.addrs.join(","));
  if (target.kind === "tx") q.set("tx", target.hash);
  if (target.kind === "network") q.set("view", "network");
  document.querySelector<HTMLElement>("#netlink")!.className = `font-mono text-[13px] no-underline hover:text-ink ${target.kind === "network" ? "font-semibold text-ink" : "text-muted"}`;
  if (state.node !== "both") q.set("node", state.node);
  if (params.get("fee")) q.set("fee", params.get("fee")!);
  const url = q.size ? `?${q}` : location.pathname;
  if (push) history.pushState(null, "", url); else history.replaceState(null, "", url);
  input.value = target.kind === "entity" ? target.addr : target.kind === "compare" ? target.addrs.join(",") : target.kind === "tx" ? target.hash : "";
  setLive("idle", target.kind === "none" ? "idle" : "connecting");
  render();
  const nodes = nodesFor(state.node);

  if (target.kind === "entity") {
    store.set("entity", target.addr);
    state.stop = watchEntity(target.addr, {
      nodes,
      feePerTx: state.fee ?? KNOWN[lc(target.addr)]?.fee,
      onStatus: (s) => {
        state.entity = s;
        state.error = undefined;
        const up = s.nodes.filter((n) => n.ok).length;
        setLive(up ? "on" : "err", up === s.nodes.length ? `live · ${clock(s.updatedAt)}` : `${up}/${s.nodes.length} nodes up`);
        render();
      },
      onInclusion: (i) => log("included", "ok", `block ${num(i.block)}${i.verifyGas !== undefined ? `, VERIFY ${num(i.verifyGas)}` : ""}`, i.hash),
      onRejection: (r) => log("rejected", "bad", `on ${r.nodes.join("+")}: ${r.failed?.rule ?? r.errorCode}`, r.hash),
      onEviction: (e) => log("evicted", "bad", `${e.kind}${e.reason ? `: ${e.reason}` : ""}`, e.hash),
      onStuck: (t) => log("stuck", "warn", `${t.status} for ${ago(t.ageMs ?? 0)}`, t.hash),
      onThrottleWarning: (s) => log("throttle warning", "warn", `${s.reputation.status}, ${s.headroom.untilThrottled} sends left`),
      onLowBalance: (s) => log("low balance", "warn", `${eth(s.funds.balance)}, ${s.funds.txsLeft} txs left`),
      onError: (e) => {
        state.error = `Poll failed: ${(e as Error)?.message ?? String(e)}. Retrying.`;
        setLive("err", "poll failed");
        if (!state.entity) render();
      },
    });
  } else if (target.kind === "network") {
    state.stop = watchNetwork({
      nodes,
      onReport: (r) => {
        state.network = r;
        state.error = undefined;
        const up = r.nodes.filter((n) => n.ok).length;
        setLive(up ? "on" : "err", `network · ${clock(r.updatedAt)}`);
        render();
      },
      onError: (e) => {
        state.error = `Network read failed: ${(e as Error)?.message ?? String(e)}. Retrying in 30 s.`;
        setLive("err", "network read failed");
        if (!state.network) render();
      },
    });
  } else if (target.kind === "compare") {
    const stops = target.addrs.map((a) => watchEntity(a, {
      nodes,
      feePerTx: state.fee ?? KNOWN[lc(a)]?.fee,
      onStatus: (s) => {
        state.compare[lc(a)] = s;
        state.compareErrors[lc(a)] = undefined;
        const ready = target.addrs.filter((x) => state.compare[lc(x)]).length;
        setLive("on", `live · ${ready}/${target.addrs.length} · ${clock(s.updatedAt)}`);
        render();
      },
      onError: (e) => {
        state.compareErrors[lc(a)] = `Poll failed: ${(e as Error)?.message ?? String(e)}. Retrying.`;
        if (!state.compare[lc(a)]) render();
      },
    }));
    state.stop = () => stops.forEach((s) => s());
  } else if (target.kind === "tx") {
    state.stop = watchTx(target.hash, nodes, (r) => {
      state.tx = r;
      state.error = undefined;
      const final = r.status === "OnChain" || r.status === "Finalized" || r.status === "Cancelled" || r.status === "Reverted" || r.nodes.some((n) => n.outcome === "rejected");
      setLive(final ? "idle" : "on", final ? `final · ${clock(r.updatedAt)}` : `following · ${clock(r.updatedAt)}`);
      render();
    }, (e) => {
      state.error = `Lookup failed: ${(e as Error)?.message ?? String(e)}. Retrying.`;
      setLive("err", "lookup failed");
      if (!state.tx) render();
    });
  }
};

const targetFrom = (p: URLSearchParams): Target => {
  if (p.get("view") === "network") return { kind: "network" };
  const tx = p.get("tx") ?? "";
  const addrs = [...new Set((p.get("entity") ?? "").split(",").map((s) => s.trim()).filter(isAddress))] as Address[];
  if (isHash(tx)) return { kind: "tx", hash: tx };
  if (addrs.length > 1) return { kind: "compare", addrs: addrs.slice(0, 6) };
  if (addrs.length === 1) return { kind: "entity", addr: addrs[0]! };
  return { kind: "none" };
};

// ---------------------------------------------------------------- events

document.querySelector<HTMLFormElement>("#f")!.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const v = input.value.trim();
  const many = v.split(/[\s,]+/).filter(isAddress) as Address[];
  if (isHash(v)) go({ kind: "tx", hash: v });
  else if (many.length > 1) go({ kind: "compare", addrs: [...new Set(many)].slice(0, 6) });
  else if (isAddress(v)) go({ kind: "entity", addr: v });
  else { state.error = "Paste a 20-byte address (0x + 40 hex) or a 32-byte tx hash (0x + 64 hex)."; setLive("err", "not an address or hash"); if (state.target.kind === "none") render(); }
});
seg.addEventListener("click", (ev) => {
  const c = (ev.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node as NodeChoice | undefined;
  if (!c || c === state.node) return;
  state.node = c;
  renderSeg();
  go(state.target, false);
});
view.addEventListener("click", (ev) => {
  const el = ev.target as HTMLElement;
  const tab = el.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
  if (tab) { state.tab = tab; store.set("tab", tab); render(); return; }
});
// In-app links (?tx=, ?entity=) switch views without a reload; explorer links open normally.
document.addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='?']");
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
  ev.preventDefault();
  go(targetFrom(new URLSearchParams(a.getAttribute("href")!.slice(1))));
});
addEventListener("popstate", () => go(targetFrom(new URLSearchParams(location.search)), false));

renderSeg();
const first = targetFrom(params);
const remembered = store.get("entity");
go(first.kind === "none" && isAddress(remembered) && !params.has("home") ? { kind: "entity", addr: remembered } : first, false);
