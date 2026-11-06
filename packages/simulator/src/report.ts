// Owner: Dev C. AdmissionReport -> terminal text. Shared by frame-doctor and apps/demo.
import { DEVNET, explorerTx, type AdmissionReport, type MempoolVerdict, type RuleCheck } from "@altpool/core";

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stdout?: { isTTY?: boolean } } }).process;
const useColor = !env?.env.NO_COLOR && (env?.env.FORCE_COLOR !== undefined || env?.stdout?.isTTY === true);
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { red: paint("31"), green: paint("32"), yellow: paint("33"), dim: paint("2"), bold: paint("1"), cyan: paint("36") };

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const gas = (n: bigint) => n.toLocaleString("en-US");

const SOURCE: Record<MempoolVerdict["source"], string> = {
  send: "sent", simulate: "node simulation", explorer: "explorer record", model: "local model, unverified",
};

export const renderVerdict = (v: MempoolVerdict): string[] => {
  const ok = v.verdict === "admitted";
  const mark = ok ? c.green("✓ admitted") : c.red("✗ rejected");
  const f = v.failed;
  const what = f
    ? [c.bold(f.rule), f.ercRule && c.dim(`(${f.ercRule})`), f.entity && `${f.entity.role} ${short(f.entity.address)}`, f.frameIndex !== undefined && `frame ${f.frameIndex}`]
        .filter(Boolean).join(" ")
    : "";
  const out = [`  ${v.mempool.padEnd(6)} ${mark}  ${what}  ${c.dim(`[${SOURCE[v.source]}]`)}`];
  if (v.where) out.push(`         ${c.dim("at:")} ${v.where}`);
  if (v.error?.revertReason) out.push(`         ${c.dim("revert:")} "${v.error.revertReason}"`);
  else if (!ok && v.error?.message) out.push(`         ${c.dim("node:")} ${v.error.message}`);
  if (v.fix) out.push(`         ${c.yellow("fix:")} ${v.fix}`);
  return out;
};

export const renderChecks = (checks: RuleCheck[]): string =>
  "  " + c.dim("checks: ") + checks.map((k) => {
    const label = `${k.rule}${k.frameIndex !== undefined ? `#${k.frameIndex}` : ""}`;
    return k.verdict === "pass" ? c.green(`✓${label}`) : k.verdict === "fail" ? c.red(`✗${label}`) : c.dim(`·${label}`);
  }).join(" ");

export interface RenderOptions { verbose?: boolean; title?: string }

export const renderReport = (r: AdmissionReport, o: RenderOptions = {}): string => {
  const lines = [c.bold(o.title ?? `frame-doctor ${r.txHash ?? ""}`)];
  lines.push(...renderVerdict(r.verdicts.public), ...renderVerdict(r.verdicts.alt));
  if (r.verifyGas !== undefined) {
    const overCap = r.verifyGas > DEVNET.publicVerifyGasCap;
    lines.push(`  ${c.dim("VERIFY gas")} ${overCap ? c.yellow(gas(r.verifyGas)) : gas(r.verifyGas)} ${c.dim(`(public cap ${gas(DEVNET.publicVerifyGasCap)}, our pin ${gas(DEVNET.verifyGasMax)})`)}`);
  }
  if (r.focil) lines.push(`  ${c.dim("FOCIL")} ${r.focil.eligible ? c.green("✓ eligible") : c.yellow("✗ not eligible")}  ${c.dim(r.focil.reason)}`);
  if (o.verbose && r.verdicts.alt.checks?.length) lines.push(renderChecks(r.verdicts.alt.checks));
  if (r.txHash && r.verdicts.alt.source === "explorer") lines.push(`  ${c.dim("explorer")} ${c.cyan(explorerTx(r.txHash))}`);
  return lines.join("\n");
};

/** A one-line summary, e.g. for the SDK's precheck log or the demo. */
export const summarize = (r: AdmissionReport): string =>
  (["public", "alt"] as const).map((m) => {
    const v = r.verdicts[m];
    return `${m} ${v.verdict === "admitted" ? "✓" : `✗ ${v.failed?.rule ?? ""}`}`.trim();
  }).join(", ");

/** One line for a routing decision, e.g. "route  alt via miner: public rejects …; alt admits; miner: VERIFY …". */
export const renderRoute = (d: { target: string; node?: string; reason: string; verified: boolean; fixes: string[] }): string => {
  const where = d.target === "public" ? c.green("public") : d.target === "alt" ? c.green(`alt via ${d.node}`) : c.red("nowhere");
  const lines = [`  ${c.bold("route")}  ${where}${d.verified ? "" : c.dim(" (unverified)")}  ${c.dim(d.reason)}`];
  for (const f of d.fixes) lines.push(`         ${c.yellow("fix:")} ${f}`);
  return lines.join("\n");
};
