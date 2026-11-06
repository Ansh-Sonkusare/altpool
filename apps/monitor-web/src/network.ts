// Owner: Dev C. The network view (?view=network), for the devnet team: node health, gossip between the sidecars,
// every entity by headroom, and live numbers behind our rule findings (research repo docs/10).
import { DEVNET } from "@altpool/core";
import type { NetworkReport } from "@altpool/monitor";
import { TEXT, chip, clock, empty, entityLink, esc, eth, num, panelHead, sq, statCell, table, td, th, type Tone } from "./ui";

const secs = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const STATUS: Record<string, Tone> = { ok: "ok", throttled: "warn", banned: "bad" };

export const renderNetwork = (r: NetworkReport) => {
  const up = r.nodes.filter((n) => n.ok);
  const bad = r.entities.filter((e) => e.status !== "ok");
  const near = r.entities.filter((e) => e.status === "ok" && e.untilThrottled <= 20);
  const pending = up.reduce((s, n) => s + n.pending, 0);
  const slowest = r.propagation.filter((p) => p.medianMs !== undefined).sort((a, b) => b.medianMs! - a.medianMs!)[0];
  const names = r.nodes.map((n) => n.name);

  const cells = `
  <section class="grid border border-line bg-panel sm:grid-cols-2 lg:grid-cols-4" aria-label="Network headline">
    ${statCell("Nodes", up.length === r.nodes.length ? "ok" : "bad", `${up.length} / ${r.nodes.length} up`, r.nodes.map((n) => `${esc(n.name)} ${n.ok ? `${num(n.latencyMs ?? 0)} ms` : "down"}`).join(" · "))}
    ${statCell("Entities", bad.length ? "bad" : near.length ? "warn" : "ok", num(r.entities.length),
      `${bad.length ? `<span class="text-bad">${num(bad.length)} throttled or banned</span>` : "none throttled or banned"}${near.length ? ` · <span class="text-warn">${num(near.length)} near</span>` : ""}`)}
    ${statCell("Pending", "info", num(pending), up.map((n) => `${esc(n.name)} ${num(n.pending)}`).join(" · ") + ` <span class="text-faint">(of the latest 200 each)</span>`)}
    ${statCell("Gossip", slowest && slowest.medianMs! > 5000 ? "warn" : "info", slowest ? secs(slowest.medianMs) : "—",
      slowest ? `median, ${esc(slowest.from)} → ${esc(slowest.to)} (slowest way)${r.findings.sharedShare !== undefined ? ` · ${Math.round(r.findings.sharedShare * 100)}% reach both` : ""}` : "not enough shared txs")}
  </section>`;

  const findings = `
  <section class="mt-5 border border-line bg-panel" aria-label="Findings, live">
    ${panelHead("Findings, live", "research repo docs/10")}
    <div class="grid gap-px bg-line md:grid-cols-3">
      ${[
        { n: "01", title: "Txs reach both sidecars", tone: (r.findings.sharedShare ?? 1) < 0.95 ? "bad" : "ok",
          value: r.findings.sharedShare !== undefined ? `${Math.round(r.findings.sharedShare * 100)}%` : "—",
          body: `of recent txs are on every node; ${Object.entries(r.onlyOn).map(([k, v]) => `${num(v)} only on the ${esc(k)}`).join(", ")}. On Nov 6 the gateway didn’t pass exits on to the miner; gossip works now (median ${r.propagation.map((p) => `${esc(p.from)}→${esc(p.to)} ${secs(p.medianMs)}`).join(", ")}).` },
        { n: "02", title: "Rejections echo the public gas cap", tone: r.findings.echoedGasCap ? "warn" : "ok",
          value: num(r.findings.echoedGasCap),
          body: `recent rejected admissions record “prefix gas budget exceeded”, the public mempool’s limit, instead of their cause (a replay’s used nonce key). frame-doctor re-simulates to find it.` },
        { n: "03", title: "Seen, never included", tone: r.findings.seenNeverIncluded ? "warn" : "ok",
          value: num(r.findings.seenNeverIncluded),
          body: `entities have ops seen but none included on some node. On Nov 6 the gateway counted no inclusions at all, so busy entities throttled after ~110 sends; inclusions are counted again now.` },
      ].map((f) => `
        <div class="bg-panel p-4 sm:p-5">
          <div class="label">${sq(f.tone as Tone)}${f.n} · ${esc(f.title)}</div>
          <div class="mb-1 mt-1.5 font-mono text-[22px] font-semibold ${TEXT[f.tone as Tone]}">${f.value}</div>
          <p class="m-0 text-[13px] text-muted">${f.body}</p>
        </div>`).join("")}
    </div>
  </section>`;

  const gossip = `
  <section class="mt-5 border border-line bg-panel" aria-label="Gossip between sidecars">
    ${panelHead("Gossip between sidecars", "sent to one node (rpc), heard by the other (gossip)")}
    ${r.propagation.length
      ? table(th("From") + th("To") + th("Samples", true) + th("Median", true) + th("p90", true) + th("Max", true), r.propagation.map((p) =>
          `<tr>${td(`<span class="font-mono font-semibold">${esc(p.from)}</span>`)}${td(`<span class="font-mono">${esc(p.to)}</span>`)}${td(num(p.samples), "text-right font-mono")}${td(secs(p.medianMs), "text-right font-mono")}${td(secs(p.p90Ms), "text-right font-mono")}${td(`<span class="${p.maxMs !== undefined && p.maxMs > 10_000 ? "text-warn" : ""}">${secs(p.maxMs)}</span>`, "text-right font-mono")}</tr>`))
      : empty("One node only: nothing to compare.")}
  </section>`;

  const shown = r.entities.slice(0, 40);
  const entities = `
  <section class="mt-5 border border-line bg-panel" aria-label="Entities by headroom">
    ${panelHead(`Entities closest to throttling · ${num(shown.length)} of ${num(r.entities.length)}`, `throttled when seen/10 &gt; included + ${DEVNET.reputation.throttlingSlack}`)}
    ${r.entities.length
      ? table(th("Entity") + th("Status") + th("Sends left", true) + names.map((n) => th(`${n} seen/inc`, true)).join("") + th("Stake", true), shown.map((e) =>
          `<tr>${td(entityLink(e.address))}${td(`${sq(STATUS[e.status] ?? "muted")}<span class="${TEXT[STATUS[e.status] ?? "muted"]}">${esc(e.status)}</span>`)}${td(`<span class="${e.untilThrottled <= 20 ? "text-warn" : ""}">${num(e.untilThrottled)}</span>`, "text-right font-mono")}${names.map((n) => td(e.perNode[n] ? `${num(e.perNode[n]!.opsSeen)}/${num(e.perNode[n]!.opsIncluded)}` : `<span class="text-faint">—</span>`, "text-right font-mono")).join("")}${td(e.isStaked ? `<span class="text-accent">${eth(e.stake, 3)}</span>` : `<span class="text-faint">unstaked</span>`, "text-right font-mono")}</tr>`))
      : empty("No entities in the reputation tables.")}
  </section>`;

  const nodes = `
  <section class="mt-5 border border-line bg-panel" aria-label="Nodes">
    ${panelHead("Nodes", "")}
    ${table(th("Node") + th("Status") + th("Version") + th("Bundling") + th("Peers", true) + th("Latest seq", true) + th("Reputation rows", true) + th("Rejected (recent)", true), r.nodes.map((n) =>
      `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span><div class="break-all font-mono text-[12px] text-muted">${esc(n.url)}</div>`)}${td(n.ok ? `${sq("ok")}<span class="text-accent">up</span> <span class="text-muted">${num(n.latencyMs ?? 0)} ms</span>` : `${sq("bad")}<span class="text-bad">down</span> <span class="text-muted">${esc(n.error ?? "")}</span>`)}${td(`<span class="font-mono">${esc(n.version ?? "—")}</span>`)}${td(n.bundlingMode ? chip(n.bundlingMode, n.bundlingMode === "auto" ? "ok" : "info") : "—")}${td(n.peers !== undefined ? num(n.peers) : "—", "text-right font-mono")}${td(n.latestSeq !== undefined ? num(n.latestSeq) : "—", "text-right font-mono")}${td(`${num(n.reputationEntries)}${n.reputationTruncated ? `<span class="text-warn">+</span>` : ""}`, "text-right font-mono")}${td(num(n.rejectedRecent), "text-right font-mono")}</tr>`))}
  </section>`;

  return `
  <div class="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="m-0 text-[28px] font-semibold leading-tight">Network</h1>
    <span class="font-mono text-[13px] text-muted">chain ${DEVNET.chainId} · ${esc(names.join(" + "))} · recent history only (explorer pages hold 200)</span>
  </div>
  ${cells}${findings}${gossip}${entities}${nodes}
  <p class="mt-4 font-mono text-[12px] text-faint">updated ${clock(r.updatedAt)} · refreshes every 30 s (these are the heaviest explorer reads)</p>`;
};
