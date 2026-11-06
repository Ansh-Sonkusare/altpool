// Pure handlers behind the MCP tools; server.ts only wires them to stdio. Handlers never throw: bad input and
// upstream failures come back as { isError: true } with a fix line.
import { createPublicClient, http, isAddress } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, type Address, type Hex } from "@altpool/core";
import { altpoolActions, createAltMempoolClient, fromWire } from "altpool";
import { checkAdmission, renderReport, summarize } from "@altpool/simulator";
import { entityStatus } from "@altpool/monitor";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** bigint and Date do not survive JSON.stringify; stringify bigints, Dates become ISO. */
export const toJson = (v: unknown): string => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const ok = (...parts: string[]): ToolResult => ({ content: parts.map((text) => ({ type: "text", text })) });
const fail = (message: string, fix: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `${message}\nFix: ${fix}` }] });
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export type Node = "miner" | "gateway";
const nodeUrl = (n: Node) => (n === "gateway" ? DEVNET.gatewayUrl : DEVNET.minerSidecarUrl);

export async function getAdmissionReportTool(args: { hash: string; node?: Node }): Promise<ToolResult> {
  if (!HASH.test(args.hash)) return fail(`"${args.hash}" is not a transaction hash.`, "Pass a 0x-prefixed 32-byte (66 character) hash.");
  const node = args.node ?? "miner";
  try {
    const sidecar = createAltMempoolClient({ httpUrl: nodeUrl(node), profile: getProfile(DEVNET.profile), name: node });
    const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar }));
    const r = await client.altpool.getAdmissionReport({ hash: args.hash as Hex });
    if (!r) return ok(`No record of ${args.hash} on the ${node} node; try the ${node === "miner" ? "gateway" : "miner"} node (admission records are node-local and in memory).`);
    const failed = r.failed.length ? ` failed: ${r.failed.map((c) => c.rule).join(", ")}.` : "";
    return ok(`${node} node: outcome ${r.outcome}, ${r.checks.length} checks.${failed}${r.explanation?.fix ? ` Fix: ${r.explanation.fix}` : ""}`, toJson(r));
  } catch (e) {
    return fail(`Could not read the admission record: ${msgOf(e)}`, "Check the node is reachable, or retry with the other node.");
  }
}

export async function checkAdmissionTool(args: { raw?: string; tx?: unknown }): Promise<ToolResult> {
  if ((args.raw === undefined) === (args.tx === undefined)) return fail("Pass exactly one of `raw` or `tx`.", "Give the 0x frame-tx hex as `raw`, or the wire-JSON FrameTx as `tx`.");
  if (args.raw !== undefined) {
    if (HASH.test(args.raw)) return getAdmissionReportTool({ hash: args.raw });
    if (!HEX.test(args.raw)) return fail("`raw` is not hex.", "Pass the 0x-prefixed, even-length hex of the encoded frame tx (or a 66-char tx hash to read its admission record).");
  }
  try {
    const input = args.raw !== undefined ? (args.raw as Hex) : fromWire(args.tx);
    const report = await checkAdmission(input);
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    let text: string;
    try { text = `${summarize(report)}\n${renderReport(report, { verbose: true })}`; } finally { prev === undefined ? delete process.env.NO_COLOR : (process.env.NO_COLOR = prev); }
    const caveat = [report.verdicts.public, report.verdicts.alt].some((v) => v.source === "model")
      ? "\nNote: a verdict with source \"model\" is our local rule model, not the node's own answer (unverified)."
      : "";
    return ok(text + caveat, toJson(report));
  } catch (e) {
    return fail(`Could not check the transaction: ${msgOf(e)}`, "Make sure `raw` is a frame tx encoded with the ethrex-eip8141-tracer profile, or `tx` is wire JSON (hex-string numbers).");
  }
}

export async function entityStatusTool(args: { address: string }): Promise<ToolResult> {
  if (!isAddress(args.address, { strict: false })) return fail(`"${args.address}" is not an address.`, "Pass a 0x-prefixed 20-byte (42 character) address.");
  try {
    const s = await entityStatus(args.address as Address);
    const t = `${s.address}: ${s.stake.isStaked ? "staked" : "NOT staked"} (${s.stake.amount} wei, unstake delay ${s.stake.unstakeDelaySec}s); reputation ${s.reputation.status} (seen ${s.reputation.opsSeen}, included ${s.reputation.opsIncluded}); headroom ${s.headroom.untilThrottled} until throttled, ${s.headroom.untilBanned} until banned; ${s.pending.length} pending, ${s.inclusions.length} recent inclusions.`;
    return ok(t, toJson(s));
  } catch (e) {
    return fail(`Could not read entity status: ${msgOf(e)}`, "Check the gateway is reachable and retry.");
  }
}
