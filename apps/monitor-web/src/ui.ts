// Owner: Dev C. Shared formatting and small Tailwind building blocks for the monitor views.
import { formatEther } from "viem";
import { DEVNET, explorerTx } from "@altpool/core";
import { DEFAULT_NODES, type NodeRef } from "@altpool/monitor";
import deployments from "../../../packages/contracts/deployments.json";

export const EXIT_FEE = 10n ** 16n; // packages/contracts/src/exit.ts (not imported: that module is Node-only)
export const lc = (a: string) => a.toLowerCase();
export const KNOWN: Record<string, { label: string; fee?: bigint }> = {};
if (deployments.exitRelay) KNOWN[lc(deployments.exitRelay)] = { label: "ExitRelay", fee: EXIT_FEE };
if (deployments.exitRelayRR) KNOWN[lc(deployments.exitRelayRR)] = { label: "ExitRelayRR", fee: EXIT_FEE };
export const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141";

export type NodeChoice = "both" | "gateway" | "miner";
export const nodesFor = (c: NodeChoice): NodeRef[] => (c === "both" ? DEFAULT_NODES : DEFAULT_NODES.filter((n) => n.name === c));

export const isAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isHash = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(s);

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
export const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
export const eth = (wei: bigint, dp = 4) => `${Number(formatEther(wei)).toFixed(dp)} ETH`;
export const num = (x: number | bigint) => x.toLocaleString("en-US");
export const ago = (ms: number) =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

const urlOf = (name: string) => DEFAULT_NODES.find((n) => n.name === name)?.url ?? DEVNET.gatewayUrl;
/** Explorer link on a node that has the tx (the explorer defaults to the gateway's view). */
export const explorerUrl = (hash: string, on: string[] = []) =>
  !on.length || on.includes("gateway") ? explorerTx(hash) : `${explorerTx(hash)}?node=${encodeURIComponent(urlOf(on[0]!))}`;
/** In-app links: a tx opens the tx view, an address the entity view. */
export const txLink = (hash: string) => `<a class="font-mono text-info hover:underline" href="?tx=${esc(hash)}">${esc(short(hash))}</a>`;
export const entityLink = (addr: string) => `<a class="font-mono text-info hover:underline" href="?entity=${esc(addr)}">${esc(KNOWN[lc(addr)]?.label ?? short(addr))}</a>`;
export const outLink = (href: string, text: string) =>
  `<a class="font-mono text-[12px] text-info hover:underline" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text)} ↗</a>`;

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";
export const TEXT: Record<Tone, string> = { ok: "text-accent", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted" };
export const FILL: Record<Tone, string> = { ok: "bg-accent", warn: "bg-warn", bad: "bg-bad", info: "bg-info", muted: "bg-faint" };
export const sq = (t: Tone) => `<span class="mr-2 inline-block size-2 align-[1px] ${FILL[t]}" aria-hidden="true"></span>`;
export const chip = (text: string, tone: Tone, off = false, title = "") =>
  `<span class="mb-0.5 mr-1 inline-block whitespace-nowrap border px-1.5 py-px font-mono text-[11px] tracking-wide ${off ? "border-dashed text-faint" : `border-current font-semibold ${TEXT[tone]}`}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

export const th = (label: string, right = false) =>
  `<th class="whitespace-nowrap border-b border-line px-4 py-2.5 sm:px-5 ${right ? "text-right" : "text-left"}"><span class="label">${esc(label)}</span></th>`;
export const td = (html: string, cls = "") => `<td class="border-b border-line px-4 py-2.5 align-top sm:px-5 ${cls}">${html}</td>`;
export const table = (head: string, rows: string[]) =>
  `<div class="overflow-x-auto"><table class="w-full border-collapse text-[13.5px] [&_tr:last-child_td]:border-b-0"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
export const empty = (text: string) => `<div class="px-5 py-8 text-muted">${esc(text)}</div>`;

export const statCell = (label: string, tone: Tone, value: string, sub: string, extra = "") => `
  <div class="min-w-0 border-line p-4 sm:px-5 [&:not(:last-child)]:border-b lg:border-b-0 lg:[&:not(:last-child)]:border-r">
    <div class="label">${sq(tone)}${esc(label)}</div>
    <div class="mb-1 mt-1.5 break-words font-mono text-[22px] font-semibold leading-snug ${TEXT[tone]}">${value}</div>
    ${extra}
    <div class="text-[13px] text-muted">${sub}</div>
  </div>`;

/** Chips for every watched node: solid where the node has the tx, dashed where it never reached it. */
export const nodeChips = (on: string[], watched: NodeRef[]) =>
  watched.map((n) => (on.includes(n.name) ? chip(n.name, "info") : chip(`${n.name} —`, "muted", true, `never reached the ${n.name}`))).join("");

/** The rule, revert and fix for a rejection, with the echoed public gas-cap text called out. */
export const explainRejection = (d: { rule?: string; revertReason?: string; fix?: string } | undefined, detail: string, fallback: string) => {
  // On Nov 6 the sidecars recorded rejected ExitRelay replays with the public mempool's gas-cap text, not the cause.
  const echoed = /prefix gas budget exceeded/.test(detail);
  return `<div class="font-mono text-[13px] font-semibold text-bad">${esc(d?.rule ?? fallback)}${d?.revertReason ? ` · ${esc(d.revertReason)}` : ""}</div>
    ${detail ? `<div class="mt-1 max-w-[70ch] break-words font-mono text-[12px] text-muted">${esc(detail.slice(0, 200))}</div>` : ""}
    <div class="mt-1 max-w-[70ch] text-[13px] text-muted">${echoed
      ? "This is the public mempool’s gas cap, echoed by the sidecar, not the cause. A replayed note shows this; run frame-doctor on the raw tx for the real reason."
      : esc(d?.fix ?? "")}</div>`;
};

export const panelHead = (left: string, right: string) =>
  `<div class="flex flex-wrap justify-between gap-3 border-b border-line px-4 py-3 sm:px-5"><span class="label">${left}</span><span class="label">${right}</span></div>`;
