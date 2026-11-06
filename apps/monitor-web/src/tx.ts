// Owner: Dev C. The paste-a-hash view: one tx's path across the sidecars, its frames and gas, and why it failed.
import { DEVNET, type Hex } from "@altpool/core";
import { txReport, type NodeRef, type TxNodeView, type TxReport } from "@altpool/monitor";
import { diagnoseAdmission } from "@altpool/simulator/rules";
import {
  EXPIRY_VERIFIER, KNOWN, ago, chip, clock, empty, entityLink, esc, eth, explainRejection, explorerUrl, lc, num, outLink,
  panelHead, short, sq, statCell, table, td, th, type Tone,
} from "./ui";

const MODE: Record<number, string> = { 0: "DEFAULT", 1: "VERIFY", 2: "SENDER" };
const STATUS_TONE: Record<string, Tone> = { OnChain: "ok", Finalized: "ok", New: "info", Pending: "info", Submitted: "info", Cancelled: "bad", Reverted: "bad" };

const frameRole = (r: TxReport, i: number) => {
  const f = r.frames[i]!;
  if (f.target && lc(f.target) === EXPIRY_VERIFIER) return "deadline (expiry verifier)";
  if (f.mode === 1) {
    const who = f.target ?? r.sender;
    const label = who ? KNOWN[lc(who)]?.label : undefined;
    const scope = f.flags & 3;
    return `${label ?? "entity"} validation${scope === 3 ? ", approves execution + payment" : scope === 1 ? ", approves payment" : scope === 2 ? ", approves execution" : ""}`;
  }
  return f.mode === 2 ? "the call the tx exists for" : "";
};

/** One row per node: how it got the tx, then each lifecycle event, timed from the first node to see it. */
const pathRow = (r: TxReport, n: TxNodeView) => {
  const t0 = r.firstSeen?.at ?? n.receivedAt ?? 0;
  const rel = (at: number) => `+${((at - t0) / 1000).toFixed(1)}s`;
  if (!n.ok) return `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span>`)}${td(`${sq("bad")}<span class="text-bad">unreachable</span> <span class="text-muted">${esc(n.error ?? "")}</span>`)}</tr>`;
  if (!n.known) return `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span>`)}${td(`${chip("never reached this node", "muted", true)}`)}</tr>`;
  const via = n.source === "rpc" ? chip("sent here", "info") : n.source?.startsWith("gossip") ? chip("gossip", "info", false, n.source) : n.source ? chip(n.source, "info") : "";
  const steps = n.events.map((e) => {
    const tone: Tone = e.kind === "included" ? "ok" : e.kind === "rejected" || e.kind === "dropped" ? "bad" : e.kind === "replaced" ? "warn" : "info";
    return `<span class="whitespace-nowrap"><span class="font-semibold ${tone === "info" ? "text-ink" : tone === "ok" ? "text-accent" : tone === "bad" ? "text-bad" : "text-warn"}">${esc(e.kind)}</span>${e.status && e.kind !== "included" ? ` <span class="text-muted">${esc(e.status)}</span>` : ""} <span class="text-faint">${rel(e.at)}</span></span>`;
  }).join(`<span class="mx-2 text-faint">→</span>`);
  const outcome = n.outcome && !n.events.length ? `<span class="font-semibold">${esc(n.outcome)}</span>` : "";
  return `<tr>${td(`<span class="font-mono font-semibold">${esc(n.name)}</span>`)}${td(`<div class="flex flex-wrap items-center gap-y-1 font-mono text-[12.5px]">${via}${n.receivedAt !== undefined ? `<span class="mr-3 text-faint">${clock(n.receivedAt)} (${rel(n.receivedAt)})</span>` : ""}${steps || outcome}</div>`)}</tr>`;
};

export const renderTx = (r: TxReport, watched: NodeRef[]) => {
  const rejectedOn = r.nodes.filter((n) => n.outcome === "rejected");
  // A tx refused at admission never gets a mempool status: call it what it is.
  const st = r.status ?? (rejectedOn.length ? "Rejected" : undefined);
  const tone: Tone = st === "Rejected" ? "bad" : st ? STATUS_TONE[st] ?? "muted" : "muted";
  const failedCheck = rejectedOn[0]?.checks.find((c) => c.verdict === "fail");
  const diag = rejectedOn.length ? diagnoseAdmission({ outcome: "rejected", checks: rejectedOn[0]!.checks }) : undefined;
  const knownOn = r.nodes.filter((n) => n.known).map((n) => n.name);
  const verifyLimit = r.frames.slice(0, r.prefixCount).reduce((s, f) => s + f.executionLimit, 0n);

  const head = `
  <div class="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h1 class="m-0 text-[28px] font-semibold leading-tight">Transaction</h1>
    <span class="break-all font-mono text-[13px] text-muted">${esc(r.hash)}</span>
    <span class="ml-auto">${outLink(explorerUrl(r.hash, knownOn), "explorer")}</span>
  </div>`;

  if (!knownOn.length && !r.receipt) {
    return head + `<section class="border border-line bg-panel">${empty(`Neither ${watched.map((n) => n.name).join(" nor ")} nor the chain knows this hash. Explorers keep recent history only; for a tx you haven’t sent yet, run frame-doctor on the raw tx.`)}</section>`;
  }

  const cells = `
  <section class="grid border border-line bg-panel sm:grid-cols-2 lg:grid-cols-4" aria-label="Summary">
    ${statCell("Status", tone, esc(st ?? "unknown"), r.receipt ? `block ${num(r.receipt.block)}` : rejectedOn.length ? `rejected on ${esc(rejectedOn.map((n) => n.name).join(" + "))}` : "not mined")}
    ${statCell("VERIFY gas", r.verifyGas !== undefined && r.verifyGas > DEVNET.publicVerifyGasCap ? "warn" : "info",
      r.verifyGas !== undefined ? num(r.verifyGas) : "—",
      `limit ${num(verifyLimit)} · public cap ${num(DEVNET.publicVerifyGasCap)}${r.verifyGas !== undefined && r.verifyGas > DEVNET.publicVerifyGasCap ? `<br><span class="text-warn">over the public cap: alt mempool only</span>` : ""}`)}
    ${statCell("Cost", "info", r.receipt?.cost !== undefined ? eth(r.receipt.cost, 5) : "—", r.receipt ? `${num(r.receipt.gasUsed)} gas` : "")}
    ${statCell("Sender", "info", r.sender ? entityLink(r.sender) : "—",
      [r.payer && r.sender && lc(r.payer) !== lc(r.sender) ? `paid by ${entityLink(r.payer)}` : r.payer ? "pays for itself" : "",
       r.nonceKeys?.some((k) => k !== 0n) ? `nonce key ${esc(short("0x" + r.nonceKeys.find((k) => k !== 0n)!.toString(16)))}` : r.nonce !== undefined ? `nonce ${num(r.nonce)}` : ""].filter(Boolean).join(" · "))}
  </section>`;

  const path = `
  <section class="mt-5 border border-line bg-panel" aria-label="Path across nodes">
    ${panelHead("Path across nodes", r.lag.length ? `<span class="!text-info">${esc(r.lag.map((l) => `${l.node} +${(l.ms / 1000).toFixed(1)}s`).join(" · "))}</span>` : r.firstSeen ? `first seen on ${esc(r.firstSeen.node)}` : "")}
    ${table(`${th("Node")}${th("Received · events")}`, r.nodes.map((n) => pathRow(r, n)))}
  </section>`;

  const frames = r.frames.length ? `
  <section class="mt-5 border border-line bg-panel" aria-label="Frames">
    ${panelHead(`Frames · ${r.frames.length}`, `${r.prefixCount} validation`)}
    ${table(th("#") + th("Mode") + th("Target") + th("Limit", true) + th("Used", true) + th("Status"), r.frames.map((f) => {
      const out = r.receipt?.frames[f.index];
      const target = f.target ? (lc(f.target) === EXPIRY_VERIFIER ? `<span class="font-mono text-muted">0x…8141</span>` : entityLink(f.target)) : `<span class="text-muted">sender</span>`;
      return `<tr>${td(`<span class="font-mono">${f.index}</span>`)}${td(`<span class="font-mono font-semibold">${esc(MODE[f.mode] ?? f.mode)}</span><div class="text-[12px] text-muted">${esc(frameRole(r, f.index))}</div>`)}${td(target)}${td(`${num(f.executionLimit)}${f.stateLimit ? `<div class="text-[12px] text-muted">+ ${num(f.stateLimit)} state</div>` : ""}`, "text-right font-mono")}${td(out ? `${num(out.gasUsed)}${out.stateGasUsed ? `<div class="text-[12px] text-muted">+ ${num(out.stateGasUsed)} state</div>` : ""}` : "—", "text-right font-mono")}${td(out ? (out.status === "ok" ? `${sq("ok")}<span class="text-accent">ok</span>` : `${sq("bad")}<span class="text-bad">failed</span>`) : `<span class="text-muted">—</span>`)}</tr>`;
    }))}
  </section>` : "";

  const why = rejectedOn.length ? `
  <section class="mt-5 border border-bad bg-panel" aria-label="Why it was rejected">
    ${panelHead(`<span class="!text-bad">Rejected on ${esc(rejectedOn.map((n) => n.name).join(" + "))}</span>`, rejectedOn[0]!.errorCode !== undefined ? `code ${rejectedOn[0]!.errorCode}` : "")}
    <div class="px-4 py-4 sm:px-5">${explainRejection(diag, failedCheck?.detail ?? "", failedCheck?.rule ?? "rejected")}</div>
  </section>` : "";

  const checks = r.nodes.find((n) => n.checks.length)?.checks ?? [];
  const checkList = checks.length ? `
  <section class="mt-5 border border-line bg-panel" aria-label="Admission checks">
    ${panelHead("Admission checks", `${checks.filter((c) => c.verdict === "pass").length} pass · ${checks.filter((c) => c.verdict === "fail").length} fail · ${checks.filter((c) => c.verdict === "skipped").length} skipped`)}
    <div class="flex flex-wrap gap-1 px-4 py-4 sm:px-5">${checks.map((c) => chip(`${c.verdict === "pass" ? "✓" : c.verdict === "fail" ? "✗" : "·"} ${c.rule}${c.frameIndex !== undefined ? ` #${c.frameIndex}` : ""}`, c.verdict === "pass" ? "ok" : c.verdict === "fail" ? "bad" : "muted", c.verdict === "skipped", c.detail ?? c.verdict)).join("")}</div>
  </section>` : "";

  return head + cells + why + path + frames + checkList +
    `<p class="mt-4 font-mono text-[12px] text-faint">updated ${clock(r.updatedAt)} · ${r.firstSeen ? `first seen ${ago(r.updatedAt - r.firstSeen.at)} ago` : ""}</p>`;
};

/** Load once, then refresh every few seconds until the tx is final. Returns a stop function. */
export const watchTx = (hash: Hex, nodes: NodeRef[], onReport: (r: TxReport) => void, onError: (e: unknown) => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const r = await txReport(hash, { nodes });
      if (stopped) return;
      onReport(r);
      const final = r.status === "OnChain" || r.status === "Finalized" || r.status === "Cancelled" || r.status === "Reverted" || r.nodes.some((n) => n.outcome === "rejected");
      if (!final) timer = setTimeout(tick, 3000);
    } catch (e) {
      if (!stopped) { onError(e); timer = setTimeout(tick, 5000); }
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
};
