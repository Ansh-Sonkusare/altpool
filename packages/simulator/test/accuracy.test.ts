// Tests for the accuracy benchmark's fixture parser and outcome extraction. They say nothing about prediction accuracy:
// that number comes from `accuracy-cli.ts`.
import { describe, expect, it } from "vitest";
import {
  buildCases, compare, extractOutcome, identityOfRaw, identityOfWire, loadCaptures, parseCapture, type Capture, type Outcome,
} from "../src/accuracy";

const cap = (method: string, response: Capture["response"], params: unknown[] = []): Capture => ({ file: "t.json", request: { method, params }, response });
const byFile = (all: Capture[], f: string) => all.find((c) => c.file === f)!;

describe("parseCapture", () => {
  it("reads a {request, response} file", () => {
    const c = parseCapture(JSON.stringify({ endpoint: "x", request: { method: "m", params: [1] }, response: { result: 2 } }), "a/b.json");
    expect(c).toEqual({ file: "a/b.json", request: { method: "m", params: [1] }, response: { result: 2 } });
  });
  it("skips notes and non-JSON", () => {
    expect(parseCapture("not json", "x")).toBeUndefined();
    expect(parseCapture(JSON.stringify({ note: "r5 stake lifecycle" }), "x")).toBeUndefined();
    expect(parseCapture(JSON.stringify({ request: { method: "m" }, response: {} }), "x")).toBeUndefined();
  });
});

describe("extractOutcome", () => {
  it("a sidecar send hash is an alt admit", () => {
    const e = extractOutcome(cap("eth_sendFrameTransaction", { result: `0x${"ab".repeat(32)}` }));
    expect(e).toMatchObject({ outcome: { mempool: "alt", source: "sidecar-send", admitted: true } });
  });
  it("a sidecar send error is an alt reject with our rule id", () => {
    const e = extractOutcome(cap("eth_sendFrameTransaction", { error: { code: -32502, message: "payer uses banned opcode: TIMESTAMP" } }));
    expect(e).toMatchObject({ outcome: { mempool: "alt", admitted: false, rule: "OP-011" } });
  });
  it("an ethrex raw-send rejection is a public reject", () => {
    const raw = byFile(loadCaptures(), "public-r9/07-t1-unstaked-canonical.json");
    expect(extractOutcome(raw)).toMatchObject({ outcome: { mempool: "public", source: "ethrex-send", admitted: false, rule: "public-storage" } });
  });
  it("a raw send that is not a frame tx says nothing", () => {
    expect(extractOutcome(cap("eth_sendRawTransaction", { result: "0x1" }, ["0xf8b1"]))).toEqual({ inconclusive: "not a frame transaction" });
  });
  it("estimator answers about the signature, limits or the public gas cap are inconclusive", () => {
    for (const message of ["Invalid frame transaction signature", "total gas limit 1 exceeds the per-transaction gas cap 0 (EIP-7825); not simulated"])
      expect(extractOutcome(cap("eth_estimateFrameTransactionGas", { error: { code: -32500, message } }))).toHaveProperty("inconclusive");
  });
  it("a VERIFY revert on an unsigned estimate of a signed tx is inconclusive, but a nonce error is not", () => {
    const revert = cap("eth_estimateFrameTransactionGas", { error: { code: -32500, message: "validation frame 0: reverted" } });
    expect(extractOutcome(revert, { signed: true })).toHaveProperty("inconclusive");
    expect(extractOutcome(revert, { signed: false })).toMatchObject({ outcome: { rule: "simulation" } });
    const nonce = cap("eth_estimateFrameTransactionGas", { error: { code: -32500, message: "Invalid Transaction: Nonce mismatch: expected 2, got 1" } });
    expect(extractOutcome(nonce, { signed: true })).toMatchObject({ outcome: { source: "sidecar-estimate", admitted: false, rule: "simulation" } });
  });
  it("an admission record is read by its outcome and first failing check", () => {
    const rec = (outcome: string, checks: unknown[]) => cap("skandha_explorer_getTransaction", { result: { admission: { outcome, checks } } });
    expect(extractOutcome(rec("accepted", [{ rule: "gas-limit", verdict: "pass" }]))).toMatchObject({ outcome: { admitted: true } });
    expect(extractOutcome(rec("rejected", [{ rule: "simulation", verdict: "fail", detail: "validation frame 1: reverted" }]))).toMatchObject({ outcome: { admitted: false, rule: "simulation" } });
    expect(extractOutcome(cap("skandha_explorer_getTransaction", { result: { admission: null } }))).toHaveProperty("inconclusive");
  });
});

describe("transaction identity", () => {
  const all = loadCaptures();
  it("matches the signed raw simulate input to its unsigned wire estimate", () => {
    const sim = byFile(all, "public/31-ethrex_simulateFrameTransaction.json");
    const est = byFile(all, "public/28-eth_estimateFrameTransactionGas.json");
    expect(identityOfRaw(sim.request.params[0])).toBe(identityOfWire(est.request.params[0]));
  });
  it("differs when a field differs", () => {
    const est27 = byFile(all, "public/27-eth_estimateFrameTransactionGas.json");
    const est28 = byFile(all, "public/28-eth_estimateFrameTransactionGas.json");
    expect(identityOfWire(est27.request.params[0])).not.toBe(identityOfWire(est28.request.params[0]));
  });
  it("is undefined for partial or undecodable txs", () => {
    expect(identityOfWire({ sender: "0x01" })).toBeUndefined();
    expect(identityOfRaw("0x06c0")).toBeUndefined();
    expect(identityOfRaw("0xf8b1")).toBeUndefined();
  });
});

describe("buildCases", () => {
  const { cases, excluded } = buildCases(loadCaptures());
  it("pairs a simulate input with a separately captured node outcome and holds the outcome out of the input", () => {
    const c = cases.find((x) => x.input.file === "public/31-ethrex_simulateFrameTransaction.json");
    expect(c).toBeDefined();
    expect(c!.outcomes.map((o) => o.file)).toEqual(["public/28-eth_estimateFrameTransactionGas.json"]);
    expect(c!.input.request.method).toBe("ethrex_simulateFrameTransaction");
  });
  it("never uses a capture as both input and outcome", () => {
    for (const c of cases) expect(c.outcomes.every((o) => o.file !== c.input.file)).toBe(true);
  });
  it("lists a node outcome that has no pre-send simulate as excluded", () => {
    expect(excluded.some((e) => e.files.includes("public-r9/12-t1-alt-staked.json") && /no pre-send/.test(e.reason))).toBe(true);
  });
  it("lists a simulate with no usable outcome as excluded", () => {
    expect(excluded.some((e) => e.files.includes("public/29-ethrex_simulateFrameTransaction.json"))).toBe(true);
  });
  it("accounts for every captured file at most once as a case input", () => {
    const inputs = cases.map((c) => c.input.file);
    expect(new Set(inputs).size).toBe(inputs.length);
  });
});

describe("compare", () => {
  const rej = (rule: string): Outcome => ({ mempool: "alt", source: "sidecar-send", file: "f", admitted: false, rule });
  it("matches the verdict and the rule", () => {
    expect(compare("alt", { verdict: "rejected", rule: "storage", source: "model" }, rej("storage"))).toMatchObject({ judgement: "match", unverified: true });
    expect(compare("alt", { verdict: "admitted", source: "simulate" }, { ...rej("x"), admitted: true, rule: undefined })).toMatchObject({ judgement: "match", unverified: false });
  });
  it("reports why it differs", () => {
    expect(compare("alt", { verdict: "admitted", source: "model" }, rej("storage")).reason).toMatch(/predicted admit, node rejected \(storage\)/);
    expect(compare("alt", { verdict: "rejected", rule: "OP-011", source: "model" }, rej("storage")).reason).toMatch(/rule differs: predicted OP-011, node storage/);
    expect(compare("alt", { verdict: "rejected", rule: "storage", source: "model" }, { ...rej("x"), admitted: true, rule: undefined }).reason).toMatch(/node admitted/);
  });
});
