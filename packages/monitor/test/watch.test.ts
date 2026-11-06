import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { entityStatus, txReport, watchEntity, type EntityReport } from "../src";
import { gateway } from "@altpool/core";

const ENTITY = "0x00000000000000000000000000000000000000e1" as const;
const URL_ = "http://fake.sidecar";
const deposit = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [10n ** 18n, 86_400n, 0n]);

/** A sidecar that also answers ethrex's eth_* calls. `fail` names methods that error; `hold` delays every reply. */
let fail = new Set<string>();
let hold: Promise<void> | undefined;
const answers: Record<string, () => unknown> = {
  skandha_explorer_listReputation: () => ({ items: [{ address: ENTITY, opsSeen: 3, opsIncluded: 1, status: "ok" }] }),
  skandha_explorer_listTransactions: () => ({ items: [] }),
  skandha_explorer_listAdmissions: () => ({ items: [] }),
  eth_call: () => deposit,
  eth_getBalance: () => "0x0",
  eth_getTransactionReceipt: () => null,
};

beforeEach(() => {
  fail = new Set();
  hold = undefined;
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body);
    await hold;
    const body = fail.has(method) ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `${method} failed` } }
      : answers[method] ? { jsonrpc: "2.0", id: 1, result: answers[method]!() }
      : { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Frame transaction not found" } };
    return new Response(JSON.stringify(body));
  });
});
afterEach(() => vi.unstubAllGlobals());

const opts = { nodes: [{ name: "node", url: URL_ }], ethrexUrl: URL_, live: false, intervalMs: 20 };
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };

it("a failed listReputation is an error, not reputation ok with 0 seen", async () => {
  fail.add("skandha_explorer_listReputation");
  await expect(entityStatus(ENTITY, gateway(URL_), { ethrexUrl: URL_ })).rejects.toThrow(/listReputation failed/);
});

it("re-delivers onStatus after a failed poll even when the data is unchanged", async () => {
  const seen: string[] = [];
  const stop = watchEntity(ENTITY, { ...opts, onStatus: () => seen.push("status"), onError: () => seen.push("error") });
  await until(() => seen.length === 1);
  fail.add("skandha_explorer_listReputation");
  await until(() => seen.includes("error"));
  fail.clear();
  await until(() => seen.at(-1) === "status" && seen.length >= 3);
  stop();
  expect(seen.slice(0, 2)).toEqual(["status", "error"]);
});

it("never calls onStatus after it is stopped", async () => {
  let release!: () => void;
  hold = new Promise((r) => { release = r; });
  const onStatus = vi.fn(), onPoll = vi.fn();
  const stop = watchEntity(ENTITY, { ...opts, onStatus, onPoll });
  stop();
  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(onStatus).not.toHaveBeenCalled();
  expect(onPoll).not.toHaveBeenCalled();
});

it("reports every poll with its outcome and the next poll time", async () => {
  const polls: { at: number; ok: boolean; nextAt: number }[] = [];
  let last: EntityReport | undefined;
  const stop = watchEntity(ENTITY, { ...opts, onStatus: (s) => { last = s; }, onPoll: (p) => polls.push(p) });
  await until(() => polls.length >= 3);
  fail.add("eth_getBalance");
  await until(() => polls.some((p) => !p.ok));
  stop();
  expect(last?.reputation.opsSeen).toBe(3);
  expect(polls[0]!.ok).toBe(true);
  expect(polls[0]!.nextAt - polls[0]!.at).toBe(20);
});

it("txReport: a node that never saw the tx is reachable and unknown, not unreachable", async () => {
  const r = await txReport(`0x${"ab".repeat(32)}`, { nodes: opts.nodes, ethrexUrl: URL_ });
  expect(r.nodes[0]).toMatchObject({ ok: true, known: false, error: undefined });
  fail.add("skandha_explorer_getTransaction");
  const down = await txReport(`0x${"ab".repeat(32)}`, { nodes: opts.nodes, ethrexUrl: URL_ });
  expect(down.nodes[0]).toMatchObject({ ok: false, error: "skandha_explorer_getTransaction failed" });
});
