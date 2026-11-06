#!/usr/bin/env tsx
// Owner: Dev C. Usage: watch-entity <address> [--node gateway|miner|<url>]... [--fee <eth>] [--interval ms] [--once]
// The terminal view of watchEntity (the cut-list fallback for apps/monitor-web). Default: the gateway and the miner's
// sidecar together. --fee is what the entity earns per tx (ExitRelay: 0.01), for the margin line.
import { formatEther, parseEther } from "viem";
import { DEVNET, explorerTx, type Address } from "@altpool/core";
import { DEFAULT_NODES, entityReport, watchEntity, type EntityReport, type NodeRef } from "./index";

const args = process.argv.slice(2);
const entity = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as Address | undefined;
if (!entity) {
  console.error("usage: watch-entity <address> [--node gateway|miner|<url>]... [--fee <eth>] [--interval ms] [--once]");
  process.exit(2);
}
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const intervalMs = Number(values("--interval")[0] ?? 3000);
const feePerTx = values("--fee")[0] ? parseEther(values("--fee")[0]!) : undefined;
const nodes: NodeRef[] = values("--node").length
  ? values("--node").map((n) => DEFAULT_NODES.find((d) => d.name === n) ?? { name: new URL(n).host, url: n })
  : DEFAULT_NODES;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint("31"), green = paint("32"), yellow = paint("33"), dim = paint("2"), bold = paint("1"), cyan = paint("36");
const plain = (s: string) => s;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ETH`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const ago = (ms?: number) => (ms === undefined ? "" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
const nodeUrl = (name: string) => nodes.find((n) => n.name === name)?.url ?? DEVNET.gatewayUrl;
/** Explorer link on a node that has the tx (the explorer defaults to the gateway's view). */
const txLink = (h: string, on: string[]) =>
  on.includes("gateway") || !on.length ? explorerTx(h) : `${explorerTx(h)}?node=${encodeURIComponent(nodeUrl(on[0]!))}`;

const render = (s: EntityReport): string => {
  const r = s.reputation, h = s.headroom, f = s.funds;
  const repColor = r.status === "ok" ? green : r.status === "throttled" ? yellow : red;
  const perNode = s.nodes.filter((n) => n.reputation).map((n) => `${n.name} ${n.reputation!.opsSeen}/${n.reputation!.opsIncluded}`).join(", ");
  const lines = [
    `${dim(new Date(s.updatedAt).toLocaleTimeString())} ${bold(s.address)}`,
    `  nodes       ${s.nodes.map((n) => (n.ok ? `${green(n.name)} ${dim(`${n.latencyMs}ms`)}` : `${red(n.name)} ${dim(n.error ?? "down")}`)).join("  ")}`,
    `  stake       ${s.stake.isStaked ? green("staked") : red("unstaked")} ${eth(s.stake.amount)}, unstake delay ${s.stake.unstakeDelaySec}s${s.stake.withdrawTime ? yellow(" (unlocking)") : ""}`,
    `  reputation  ${repColor(r.status)}  seen ${r.opsSeen}, included ${r.opsIncluded}  ${dim(perNode ? `(seen/included per node: ${perNode})` : "")}`,
    `  headroom    ${(r.status === "ok" && h.untilThrottled <= 20 ? yellow : plain)(`${h.untilThrottled} sends until throttled`)}, ${h.untilBanned} until banned` +
      (s.throttleEta?.minutes !== undefined ? yellow(`  (throttled in ~${Math.round(s.throttleEta.minutes)} min at this rate)`) : ""),
    `  funds       ${eth(f.balance)}` + (f.avgCost !== undefined ? `, ~${eth(f.avgCost)} per tx` : "") +
      (f.txsLeft !== undefined ? `, ${(f.txsLeft <= 5 ? yellow : plain)(`${f.txsLeft} txs left`)}` : "") +
      (f.marginPerTx !== undefined ? `, margin ${(f.marginPerTx >= 0n ? green : red)(eth(f.marginPerTx))} per tx` : ""),
    `  pending     ${s.pending.length ? s.pending.map((p) => `${short(p.hash)} ${p.status} ${ago(p.ageMs)}${p.stuck ? red(" STUCK") : ""} on ${Object.keys(p.nodes).join("+")}`).join(", ") : dim("none")}`,
  ];
  for (const inc of s.inclusions.slice(0, 5))
    lines.push(`  included    ${short(inc.hash)} block ${inc.block}${inc.verifyGas !== undefined ? `, VERIFY ${inc.verifyGas.toLocaleString("en-US")}` : ""}${inc.cost !== undefined ? `, cost ${eth(inc.cost)}` : ""} ${dim(`on ${inc.nodes.join("+")}`)}`);
  for (const rj of s.rejections.slice(0, 5))
    lines.push(`  ${red("rejected")}    ${short(rj.hash)} ${ago(s.updatedAt - rj.at)} ago on ${rj.nodes.join("+")}: ${rj.failed ? `${rj.failed.rule}${rj.failed.detail ? ` ${dim(rj.failed.detail.slice(0, 80))}` : ""}` : `code ${rj.errorCode ?? "?"}`}`);
  if (s.rejections.length > 5) lines.push(dim(`              … ${s.rejections.length - 5} more rejections`));
  for (const e of s.evictions.slice(0, 5)) lines.push(`  ${red("evicted")}     ${short(e.hash)} ${e.kind}${e.reason ? `: ${e.reason}` : ""}`);
  return lines.join("\n");
};

const event = (what: string, detail: string) => console.log(`${cyan("▸")} ${bold(what)} ${detail}`);

if (args.includes("--once")) {
  console.log(render(await entityReport(entity, { nodes, feePerTx })));
} else {
  console.log(dim(`watching ${entity} on chain ${DEVNET.chainId} via ${nodes.map((n) => n.name).join(" + ")}: live events, and a poll every ${intervalMs} ms (ctrl-c to stop)\n`));
  watchEntity(entity, {
    nodes, feePerTx, intervalMs,
    onStatus: (s) => console.log(render(s) + "\n"),
    onInclusion: (i) => event("included", `${i.hash} block ${i.block}${i.verifyGas !== undefined ? `, VERIFY ${i.verifyGas.toLocaleString("en-US")}` : ""}  ${dim(txLink(i.hash, i.nodes))}`),
    onRejection: (r) => event(red("rejected"), `${r.hash} on ${r.nodes.join("+")}: ${r.failed?.rule ?? r.errorCode}`),
    onEviction: (e) => event(red("evicted"), `${e.hash} ${e.kind}${e.reason ? `: ${e.reason}` : ""}`),
    onStuck: (t) => event(yellow("stuck"), `${t.hash} ${t.status} for ${ago(t.ageMs)}, on ${Object.keys(t.nodes).join("+")}`),
    onThrottleWarning: (s) => event(yellow("throttle warning"), `${s.reputation.status}, ${s.headroom.untilThrottled} sends left`),
    onLowBalance: (s) => event(yellow("low balance"), `${eth(s.funds.balance)}, ${s.funds.txsLeft} txs left`),
    onError: (e) => console.error(red(`poll failed: ${(e as Error).message ?? e}`)),
  });
}
