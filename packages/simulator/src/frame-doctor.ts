#!/usr/bin/env tsx
// Owner: Dev C.
// frame-doctor <rawTx>        will each mempool admit this tx? (ethrex simulate + alt rule model)
// frame-doctor <txHash>       what happened to a sent tx? (explorer admission record, status, receipt)
// frame-doctor --fixture <f>  replay a captured call from @altpool/core/fixtures, offline (add --staked for stake lookups)
// Raw-tx mode ends with the route: public, alt via gateway or miner, or nowhere (with fixes).
// Flags: --json, -v/--verbose. Exit 0 when some mempool admits it (raw tx) or the alt mempool did (hash), 1 when none
// does, 2 on usage or RPC errors.
import { fixture } from "@altpool/core/fixtures";
import { DEVNET, explorerTx, gateway as gatewayClient, type AdmissionReport, type Hex, type MempoolVerdict, type RuleCheck } from "@altpool/core";
import { createSimulator } from "./check";
import { replaySimulator } from "./replay";
import { diagnoseAdmission, diagnoseError } from "./rules";
import { c, renderChecks, renderReport, renderRoute, renderVerdict } from "./report";
import { routeFromReport } from "./route";

const USAGE = "usage: frame-doctor <rawTx | txHash> [--node <sidecar url>] [--json] [-v]\n       frame-doctor --fixture <path under core/fixtures> [--staked] [--json] [-v]";

const args = process.argv.slice(2);
const flag = (...names: string[]) => names.some((n) => args.includes(n));
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const json = flag("--json");
const verbose = flag("-v", "--verbose");
const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "--fixture" && args[i - 1] !== "--node");

const bigintJson = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

interface SentReport { txHash: Hex; node?: string; alt?: MempoolVerdict; status?: string; block?: number; frameStatuses?: string[]; verifyGasUsed?: bigint; checks?: RuleCheck[] }

/** The leading VERIFY frames of an explorer record's frames (mode 1). */
const prefixCount = (frames: { mode: number | string }[] = []) => {
  let n = 0;
  while (n < frames.length && Number(frames[n]!.mode) === 1) n++;
  return n;
};

const fromRecord = (txHash: Hex, rec: any, receipt?: any, status?: any): SentReport => {
  const a = rec?.admission;
  const d = a ? diagnoseAdmission(a) : undefined;
  const alt: MempoolVerdict | undefined = a && {
    mempool: "alt", source: "explorer", verdict: a.outcome === "rejected" ? "rejected" : "admitted", checks: a.checks,
    ...(d && {
      failed: { rule: d.rule, ercRule: d.ercRule, frameIndex: d.frameIndex, entity: d.entity?.address ? { role: d.entity.role, address: d.entity.address } : undefined },
      fix: d.fix, error: { code: a.errorCode ?? 0, message: d.detail, revertReason: d.revertReason },
    }),
  };
  const n = prefixCount(a?.frames);
  const verifyGasUsed = receipt?.frameReceipts && n
    ? receipt.frameReceipts.slice(0, n).reduce((s: bigint, f: any) => s + BigInt(typeof f.gasUsed === "object" ? f.gasUsed.execution : f.gasUsed), 0n)
    : undefined;
  return {
    txHash, alt, checks: a?.checks,
    status: status?.status ?? rec?.entry?.status ?? (receipt ? (receipt.status === "0x1" || receipt.status === "success" ? "OnChain" : "Reverted") : undefined),
    block: receipt?.blockNumber ? Number(receipt.blockNumber) : undefined,
    frameStatuses: receipt?.frameReceipts?.map((f: any) => (f.status === "0x1" || f.status === "success" ? "ok" : "failed")) ?? a?.frameStatuses,
    verifyGasUsed,
  };
};

const renderSent = (r: SentReport): string => {
  const lines = [c.bold(`frame-doctor ${r.txHash}`)];
  if (r.alt) lines.push(...renderVerdict(r.alt));
  else if (r.block !== undefined) lines.push(`  alt    ${c.yellow("? no admission record")}  the tx is on chain, but the explorer no longer has (or never had) its record.`);
  else lines.push(`  alt    ${c.yellow("? unknown hash")}  neither the explorer nor the chain knows it. Pass the raw tx to simulate it.`);
  lines.push(`  public ${c.dim("· not checked for a sent tx (pass the raw tx to simulate it)")}`);
  if (r.status) lines.push(`  ${c.dim("status")} ${r.status}${r.block !== undefined ? ` in block ${r.block}` : ""}${r.frameStatuses ? `, frames: ${r.frameStatuses.join(", ")}` : ""}`);
  if (r.verifyGasUsed !== undefined) lines.push(`  ${c.dim("VERIFY gas used")} ${r.verifyGasUsed.toLocaleString("en-US")}`);
  if (verbose && r.checks?.length) lines.push(renderChecks(r.checks));
  if (r.alt || r.block !== undefined) lines.push(`  ${c.dim("explorer")} ${c.cyan(explorerLink(r.txHash, r.node))}`);
  if (r.node) lines.push(`  ${c.dim("node")} ${r.node}`);
  return lines.join("\n");
};

const done = (out: AdmissionReport | SentReport | { fixture: string; verdict: MempoolVerdict }, text: string, altAdmitted: boolean | undefined): never => {
  console.log(json ? bigintJson(out) : text);
  process.exit(altAdmitted === undefined ? 2 : altAdmitted ? 0 : 1);
};

const checkRaw = async (raw: Hex, sim = createSimulator()) => {
  const r = await sim.check(raw);
  const route = routeFromReport(r);
  done({ ...r, route: { ...route, report: undefined } } as AdmissionReport, `${renderReport(r, { verbose })}\n${renderRoute(route)}`, route.target !== "none");
};

/** Explorer link on the node that holds the record (the explorer defaults to the gateway's view). */
const explorerLink = (hash: Hex, node?: string) =>
  node && node !== DEVNET.gatewayUrl ? `${explorerTx(hash)}?node=${encodeURIComponent(node)}` : explorerTx(hash);

/** Exits go to the miner's sidecar, which the gateway does not hear from: ask both (or --node <url>). */
const checkHash = async (hash: Hex) => {
  const nodes = value("--node") ? [value("--node")!] : [DEVNET.gatewayUrl, DEVNET.minerSidecarUrl];
  let r: SentReport | undefined;
  for (const url of nodes) {
    const gw = gatewayClient(url);
    const [rec, receipt, status] = await Promise.all([
      gw.admission(hash).catch(() => undefined),
      gw.receipt(hash).catch(() => undefined),
      gw.txStatus(hash).catch(() => undefined),
    ]);
    const here = { ...fromRecord(hash, rec, receipt, status), node: url };
    // Prefer a node whose record says admitted (the gateway may only hold a rejected replay), then any record.
    if (!r || (here.alt?.verdict === "admitted" && r.alt?.verdict !== "admitted") || (!r.alt && here.alt) || (r.block === undefined && here.block !== undefined && !r.alt)) r = here;
  }
  r = r!;
  done(r, renderSent(r), r.alt ? r.alt.verdict === "admitted" : r.block !== undefined ? r.status === "OnChain" : undefined);
};

/** Offline replay: answer the simulator's calls from one captured fixture. */
const replay = async (path: string) => {
  const f = fixture(path);
  const m = f.request.method;
  if (m === "ethrex_simulateFrameTransaction") {
    const sim = replaySimulator(f, { staked: flag("--staked"), label: path });
    return checkRaw(sim.raw, sim);
  }
  if (m === "skandha_explorer_getTransaction") {
    const r = fromRecord(f.request.params[0] as Hex, f.response.result);
    return done(r, renderSent(r), r.alt ? r.alt.verdict === "admitted" : undefined);
  }
  if (f.response.error) {
    const mempool = m === "eth_sendRawTransaction" ? "public" : "alt";
    const d = diagnoseError(f.response.error, mempool);
    const v: MempoolVerdict = {
      mempool, source: "send", verdict: "rejected", fix: d.fix,
      failed: { rule: d.rule, ercRule: d.ercRule, frameIndex: d.frameIndex, entity: d.entity?.address ? { role: d.entity.role, address: d.entity.address } : undefined },
      error: { code: f.response.error.code, message: f.response.error.message, revertReason: d.revertReason },
    };
    return done({ fixture: path, verdict: v }, [c.bold(`frame-doctor ${path} (${m})`), ...renderVerdict(v)].join("\n"), false);
  }
  console.error(`frame-doctor: ${path} is a ${m} call with no rejection to explain`);
  process.exit(2);
};

const main = async () => {
  const fx = value("--fixture");
  if (fx) return replay(fx);
  const arg = positional[0];
  if (!arg || !/^0x[0-9a-fA-F]+$/.test(arg)) { console.error(USAGE); process.exit(2); }
  return arg.length === 66 ? checkHash(arg as Hex) : checkRaw(arg as Hex);
};

main().catch((e) => {
  console.error(`frame-doctor: ${(e as Error).message}`);
  process.exit(2);
});
