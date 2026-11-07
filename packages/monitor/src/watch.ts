#!/usr/bin/env tsx
// Owner: Dev C. The terminal view of watchEntity (the cut-list fallback for apps/monitor-web).
//
//   watch-entity <address>... [options]            watch one or more entities, live
//   watch-entity <address>... --once [--fail-if …]  one snapshot; with --fail-if, exit 1 when a condition holds (CI)
//
//   --node gateway|miner|<url>   repeatable; default both the gateway and the miner's sidecar
//   --fee <eth>                  what the entity earns per tx (ExitRelay: 0.01), for the margin line
//   --alert-webhook <url>        repeatable; POST each alert (Discord, Slack, Telegram sendMessage?chat_id=…)
//   --mute <kind,…>              alert kinds to leave out: throttle unlocking unstaked low-balance stuck evicted rejected
//   --fail-if <cond,…>           throttled banned unstaked unlocking low-balance stuck node-down rejections uncovered key-clash, or "all"
//   --throttle-warn-at <n>       sends left that count as "near throttling" (default 20)
//   --low-balance-at <n>         txs left that count as low balance (default 5)
//   --interval <ms>              fallback poll period (default 10000; live events trigger polls sooner)
//   --json                       with --once: print the reports as JSON
//
// Exit codes: 0 healthy (or watching), 1 a --fail-if condition holds, 2 usage error or no node reachable.
import { formatEther, parseEther } from "viem";
import { DEVNET, explorerTx, type Address } from "@altpool/core";
import {
  CONDITIONS, DEFAULT_NODES, entityReport, failing, watchEntity, webhookAlerts,
  type AlertKind, type Condition, type EntityReport, type NodeRef,
} from "./index";

const USAGE = "usage: watch-entity <address>... [--node gateway|miner|<url>]... [--fee <eth>] [--alert-webhook <url>]... [--mute <kinds>] [--once [--fail-if <conds>] [--json]] [--throttle-warn-at n] [--low-balance-at n] [--interval ms]";
const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const list = (flag: string) => values(flag).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
const entities = [...new Set(args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()))] as Address[];
if (!entities.length) { console.error(USAGE); process.exit(2); }

const intervalMs = Number(values("--interval")[0] ?? 10_000);
const feePerTx = values("--fee")[0] ? parseEther(values("--fee")[0]!) : undefined;
const throttleWarnAt = Number(values("--throttle-warn-at")[0] ?? 20);
const lowBalanceAt = Number(values("--low-balance-at")[0] ?? 5);
const webhooks = values("--alert-webhook");
const mute = list("--mute") as AlertKind[];
const failIf = (list("--fail-if").includes("all") ? CONDITIONS : list("--fail-if")) as Condition[];
const unknown = failIf.filter((c) => !CONDITIONS.includes(c));
if (unknown.length) { console.error(`unknown --fail-if condition(s): ${unknown.join(", ")}; known: ${CONDITIONS.join(" ")}`); process.exit(2); }
const nodes: NodeRef[] = values("--node").length
  ? values("--node").map((n) => DEFAULT_NODES.find((d) => d.name === n) ?? { name: new URL(n).host, url: n })
  : DEFAULT_NODES;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint("31"), green = paint("32"), yellow = paint("33"), dim = paint("2"), bold = paint("1"), cyan = paint("36");
const plain = (s: string) => s;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ETH`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const tag = (a: string) => (entities.length > 1 ? `${dim(`[${a.slice(0, 6)}…${a.slice(-4)}]`)} ` : "");
const ago = (ms?: number) => (ms === undefined ? "" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
const nodeUrl = (name: string) => nodes.find((n) => n.name === name)?.url ?? DEVNET.gatewayUrl;
/** Explorer link on a node that has the tx (the explorer defaults to the gateway's view). */
const txLink = (h: string, on: string[]) =>
  on.includes("gateway") || !on.length ? explorerTx(h) : `${explorerTx(h)}?node=${encodeURIComponent(nodeUrl(on[0]!))}`;

const render = (s: EntityReport): string => {
  const r = s.reputation, h = s.headroom, f = s.funds;
  const repColor = r.status === "ok" ? green : r.status === "throttled" ? yellow : red;
  const perNode = s.nodes.filter((n) => n.reputation).map((n) => `${n.name} ${n.reputation!.opsSeen}/${n.reputation!.opsIncluded}${n.reputationError ? " stale" : ""}`).join(", ");
  const lines = [
    `${dim(new Date(s.updatedAt).toLocaleTimeString())} ${bold(s.address)}`,
    `  nodes       ${s.nodes.map((n) => (n.ok ? `${green(n.name)} ${dim(`${n.latencyMs}ms`)}` : `${red(n.name)} ${dim(n.error ?? "down")}`)).join("  ")}`,
    `  stake       ${s.stake.isStaked ? green("staked") : red("unstaked")} ${eth(s.stake.amount)}, unstake delay ${s.stake.unstakeDelaySec}s${s.stake.withdrawTime ? yellow(" (unlocking)") : ""}`,
    `  reputation  ${repColor(r.status)}  seen ${r.opsSeen}, included ${r.opsIncluded}  ${dim(perNode ? `(seen/included per node: ${perNode})` : "")}`,
    `  headroom    ${(r.status === "ok" && h.untilThrottled <= throttleWarnAt ? yellow : plain)(`${h.untilThrottled} sends until throttled`)}, ${h.untilBanned} until banned` +
      (s.throttleEta?.minutes !== undefined ? yellow(`  (throttled in ~${Math.round(s.throttleEta.minutes)} min at this rate)`) : ""),
    `  funds       ${eth(f.balance)}` + (f.avgCost !== undefined ? `, ~${eth(f.avgCost)} per tx` : "") +
      (f.txsLeft !== undefined ? `, ${(f.txsLeft <= lowBalanceAt ? yellow : plain)(`${f.txsLeft} txs left`)}` : "") +
      (f.marginPerTx !== undefined ? `, margin ${(f.marginPerTx >= 0n ? green : red)(eth(f.marginPerTx))} per tx` : ""),
    `  exposure    ${s.exposure.txs.length ? `${eth(s.exposure.total)} worst case for ${s.exposure.txs.length} pending, ${s.exposure.uncovered ? red(`${s.exposure.uncovered} not covered by the balance`) : green("all covered")}` : dim("nothing pending that it pays for")}` +
      (s.exposure.keyClashes.length ? yellow(`, ${s.exposure.keyClashes.length} nonce-key clash${s.exposure.keyClashes.length > 1 ? "es" : ""}`) : ""),
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

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

// ---------------------------------------------------------------- one snapshot (and CI)

if (args.includes("--once")) {
  const results = await Promise.all(entities.map(async (e) => {
    try { return { e, r: await entityReport(e, { nodes, feePerTx }) }; }
    catch (err) { return { e, error: (err as Error).message }; }
  }));
  let failed = false, unreachable = false;
  const out: unknown[] = [];
  for (const x of results) {
    if (!x.r) { unreachable = true; console.error(red(`${x.e}: ${x.error}`)); continue; }
    const bad = failing(x.r, failIf, { lowBalanceAt, throttleWarnAt });
    if (bad.length) failed = true;
    if (args.includes("--json")) { out.push({ ...x.r, failing: bad }); continue; }
    console.log(render(x.r));
    if (failIf.length) console.log(bad.length ? bad.map((b) => `  ${red("FAIL")}        ${b.condition}: ${b.reason}`).join("\n") : `  ${green("PASS")}        ${failIf.join(", ")}`);
    console.log();
  }
  if (out.length) console.log(json(entities.length === 1 ? out[0] : out));
  process.exit(unreachable ? 2 : failed ? 1 : 0);
}

// ---------------------------------------------------------------- live

const event = (a: string, what: string, detail: string) => console.log(`${tag(a)}${cyan("▸")} ${bold(what)} ${detail}`);
console.log(dim(`watching ${entities.length} ${entities.length > 1 ? "entities" : "entity"} on chain ${DEVNET.chainId} via ${nodes.map((n) => n.name).join(" + ")}: live events, and a poll every ${intervalMs} ms` +
  `${webhooks.length ? `; alerts to ${webhooks.length} webhook${webhooks.length > 1 ? "s" : ""}${mute.length ? ` (muted: ${mute.join(", ")})` : ""}` : ""} (ctrl-c to stop)\n`));

for (const entity of entities) {
  const alerts = webhooks.length
    ? webhookAlerts(entity, webhooks, { mute, onSent: (al, ok, err) => event(entity, ok ? "alert sent" : red("alert failed"), `${al.kind}${err ? `: ${err}` : ""}`) })
    : {};
  const both = <K extends keyof typeof alerts>(k: K, mine: NonNullable<(typeof alerts)[K]>) =>
    ((...a: unknown[]) => { (mine as (...x: unknown[]) => void)(...a); (alerts[k] as ((...x: unknown[]) => void) | undefined)?.(...a); }) as NonNullable<(typeof alerts)[K]>;
  watchEntity(entity, {
    nodes, feePerTx, intervalMs, throttleWarnAt, lowBalanceAt,
    onStatus: (s) => console.log(render(s) + "\n"),
    onInclusion: both("onInclusion", (i) => event(entity, "included", `${i.hash} block ${i.block}${i.verifyGas !== undefined ? `, VERIFY ${i.verifyGas.toLocaleString("en-US")}` : ""}  ${dim(txLink(i.hash, i.nodes))}`)),
    onRejection: both("onRejection", (r) => event(entity, red("rejected"), `${r.hash} on ${r.nodes.join("+")}: ${r.failed?.rule ?? r.errorCode}`)),
    onEviction: both("onEviction", (e) => event(entity, red("evicted"), `${e.hash} ${e.kind}${e.reason ? `: ${e.reason}` : ""}`)),
    onStuck: both("onStuck", (t) => event(entity, yellow("stuck"), `${t.hash} ${t.status} for ${ago(t.ageMs)}, on ${Object.keys(t.nodes).join("+")}`)),
    onThrottleWarning: both("onThrottleWarning", (s) => event(entity, yellow("throttle warning"), `${s.reputation.status}, ${s.headroom.untilThrottled} sends left`)),
    onLowBalance: both("onLowBalance", (s) => event(entity, yellow("low balance"), `${eth(s.funds.balance)}, ${s.funds.txsLeft} txs left`)),
    onStakeChange: both("onStakeChange", (_p, n) => event(entity, yellow("stake changed"), `${n.isStaked ? "staked" : "unstaked"} ${eth(n.amount)}${n.withdrawTime ? ", unlocking" : ""}`)),
    onError: (e) => console.error(`${tag(entity)}${red(`poll failed: ${(e as Error).message ?? e}`)}`),
  });
}
