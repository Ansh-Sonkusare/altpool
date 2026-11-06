#!/usr/bin/env tsx
// Owner: Dev C. Usage: watch-entity <address> [--interval ms] [--once]
// The terminal view of watchEntity (the cut-list fallback for apps/monitor-web).
import { DEVNET, explorerTx, type Address, type EntityStatus } from "@altpool/core";
import { entityStatus, watchEntity } from "./index";

const args = process.argv.slice(2);
const entity = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as Address | undefined;
if (!entity) {
  console.error("usage: watch-entity <address> [--interval ms] [--once]");
  process.exit(2);
}
const i = args.indexOf("--interval");
const intervalMs = i >= 0 ? Number(args[i + 1]) : 3000;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint("31"), green = paint("32"), yellow = paint("33"), dim = paint("2"), bold = paint("1");
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4)} ETH`;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;

const render = (s: EntityStatus): string => {
  const r = s.reputation;
  const repColor = r.status === "ok" ? green : r.status === "throttled" ? yellow : red;
  const h = s.headroom;
  const warn = r.status === "ok" && h.untilThrottled <= 20;
  const lines = [
    `${dim(new Date().toLocaleTimeString())} ${bold(s.address)}`,
    `  stake       ${s.stake.isStaked ? green("staked") : red("unstaked")} ${eth(s.stake.amount)}, unstake delay ${s.stake.unstakeDelaySec}s${s.stake.withdrawTime ? yellow(" (unlocking)") : ""}`,
    `  reputation  ${repColor(r.status)}  seen ${r.opsSeen}, included ${r.opsIncluded}${r.isWhitelisted ? " (whitelisted)" : ""}`,
    `  headroom    ${warn ? yellow(`${h.untilThrottled} sends until throttled`) : `${h.untilThrottled} sends until throttled`}, ${h.untilBanned} until banned` +
      (r.opsIncluded === 0 && r.opsSeen > 0 ? dim("  (included stays 0 on the public gateway, docs/10 #3)") : ""),
    `  pending     ${s.pending.length ? s.pending.map((p) => `${short(p.hash)} ${p.status} as ${p.role}`).join(", ") : dim("none")}`,
  ];
  for (const inc of s.inclusions.slice(0, 5))
    lines.push(`  included    ${short(inc.hash)} block ${inc.block}${inc.verifyGas !== undefined ? `, VERIFY gas ${inc.verifyGas.toLocaleString("en-US")}` : ""}  ${dim(explorerTx(inc.hash))}`);
  for (const e of s.evictions.slice(0, 5)) lines.push(`  ${red("evicted")}     ${short(e.hash)} ${e.kind}${e.reason ? `: ${e.reason}` : ""}`);
  return lines.join("\n");
};

if (args.includes("--once")) {
  console.log(render(await entityStatus(entity)));
} else {
  console.log(dim(`watching ${entity} on chain ${DEVNET.chainId} every ${intervalMs} ms (ctrl-c to stop)\n`));
  watchEntity(entity, {
    intervalMs,
    onStatus: (s) => console.log(render(s) + "\n"),
    onError: (e) => console.error(red(`poll failed: ${(e as Error).message ?? e}`)),
  });
}
