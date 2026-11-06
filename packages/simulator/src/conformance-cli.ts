#!/usr/bin/env tsx
// Owner: Dev C. Usage: conformance [vectors-dir] [--json] [--strict] [--all]
// Plays the ERC-8421 vectors against our rule model. Prints per file: agree / differ / not modelled, then each difference.
// --all also lists the agreeing cases; --strict exits 1 when any case differs (default: 0, it's a report).
import { runConformance, VECTORS_DIR } from "./conformance";
import { c } from "./report";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("-")) ?? VECTORS_DIR;
const r = runConformance(dir);

if (args.includes("--json")) {
  console.log(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(args.includes("--strict") && r.totals.differ ? 1 : 0);
}

console.log(c.bold("ERC-8421 conformance vectors vs our rule model"));
console.log(c.dim(`descriptor: min stake ${r.descriptor.minStake} wei, min unstake delay ${r.descriptor.minUnstakeDelay} s · vectors: exp-mempool-l2s d1a57c6 (Apache-2.0)\n`));
const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(c.dim(`${pad("file", 26)}${pad("agree", 8)}${pad("differ", 8)}not modelled`));
for (const f of [...r.files, r.totals]) {
  const line = `${pad(f.file.replace(/\.json$/, ""), 26)}${pad(f.agree, 8)}${pad(f.differ, 8)}${f.notModelled}`;
  console.log(f.file === "total" ? c.bold(line) : f.differ ? c.yellow(line) : line);
}

const differ = r.results.filter((x) => x.status === "differ");
if (differ.length) {
  console.log(`\n${c.bold("Differences")} ${c.dim("(expected by ERC-8421 → what our model says)")}`);
  for (const d of differ) console.log(`  ${c.yellow("≠")} ${d.file.replace(/\.json$/, "")} · ${d.name}${d.tx ? ` (tx ${d.tx + 1})` : ""}: ${d.expected} → ${c.bold(d.ours)}${d.note ? `\n      ${c.dim(d.note)}` : ""}`);
}
if (args.includes("--all")) {
  console.log(`\n${c.bold("Agreeing")}`);
  for (const a of r.results.filter((x) => x.status === "agree")) console.log(`  ${c.green("=")} ${a.file.replace(/\.json$/, "")} · ${a.name}${a.tx ? ` (tx ${a.tx + 1})` : ""}: ${a.expected}`);
}
process.exit(args.includes("--strict") && differ.length ? 1 : 0);
