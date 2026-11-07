// Offline: input validation, session files, the rule catalog. Every case here returns before touching the network.
import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RULES, checkAdmissionTool, explainRuleTool, getAdmissionReportTool, parseCalls, parseSession, prepareOwnerTxTool,
  sendCallsTool, submitFrameTxTool, waitForReceiptTool, type SessionFile,
} from "../src/index";

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const sessionPk = keccak256(stringToHex("altpool mcp test session"));
const validSession = (): SessionFile => ({
  kind: "altpool-bridge-session",
  chainId: 1337,
  account: "0x9f1331A6E016620Bab4674ECf3e233E72A92862a",
  owner: "0xEae72d881c92712a0EA33E95cB64F6CdCD45B444",
  session: { key: privateKeyToAccount(sessionPk).address, validUntil: "2000000000", maxValuePerTx: "1000", maxCostPerTx: "10000000000000000", target: "0x23864f6a599992d1964F3988ddE398F989D134A0" },
  ownerSignature: `0x${"11".repeat(65)}`,
  sessionPrivateKey: sessionPk,
});

describe("parseCalls", () => {
  it("accepts decimal and hex numbers, defaults value and data", () => {
    const [a, b] = parseCalls([{ to: "0x23864f6a599992d1964f3988dde398f989d134a0" }, { to: "0x23864f6a599992d1964F3988ddE398F989D134A0", value: "0x10", gas: "21000", data: "0xd0e30db0" }]);
    expect(a).toMatchObject({ to: "0x23864f6a599992d1964F3988ddE398F989D134A0", value: 0n, data: "0x", gas: undefined, state: undefined });
    expect(b).toMatchObject({ value: 16n, gas: 21_000n, data: "0xd0e30db0" });
  });
  it("rejects bad input with the field named", () => {
    expect(() => parseCalls([])).toThrow(/at least one/);
    expect(() => parseCalls([{ to: "0x12" }])).toThrow(/calls\[0\]\.to/);
    expect(() => parseCalls([{ to: "0x23864f6a599992d1964f3988dde398f989d134a0", value: "1 eth" }])).toThrow(/calls\[0\]\.value/);
    expect(() => parseCalls([{ to: "0x23864f6a599992d1964f3988dde398f989d134a0", data: "0xabc" }])).toThrow(/data/);
    expect(() => parseCalls(Array(7).fill({ to: "0x23864f6a599992d1964f3988dde398f989d134a0" }))).toThrow(/At most 6/);
  });
});

describe("parseSession", () => {
  it("loads the wallet-bridge-web export", () => {
    const s = parseSession(validSession());
    expect(s.session.validUntil).toBe(2_000_000_000n);
    expect(s.session.maxValuePerTx).toBe(1000n);
    expect(s.bridge.address).toBe("0x9f1331A6E016620Bab4674ECf3e233E72A92862a");
  });
  it("refuses files that would fail on-chain or are not sessions", () => {
    expect(() => parseSession({ ...validSession(), kind: "x" })).toThrow(/not an altpool session/i);
    expect(() => parseSession({ ...validSession(), chainId: 1 })).toThrow(/chain 1/);
    expect(() => parseSession({ ...validSession(), sessionPrivateKey: keccak256("0x01") })).toThrow(/does not match session.key/);
    expect(() => parseSession({ ...validSession(), ownerSignature: "0x1234" })).toThrow(/65 bytes/);
  });
});

describe("explain_rule", () => {
  it("finds by ERC id, sidecar check id and keyword", () => {
    expect(text(explainRuleTool({ rule: "BUDGET-010" }))).toMatch(/100,000/);
    expect(text(explainRuleTool({ rule: "storage" }))).toMatch(/^STORAGE/);
    expect(text(explainRuleTool({ rule: "OP-061" }))).toMatch(/OPCODES/);
    expect(text(explainRuleTool({ rule: "timestamp" }))).toMatch(/expiry_verify/);
    expect(explainRuleTool({ rule: "zzz" }).isError).toBe(true);
  });
  it("every rule has a fix and maps to sidecar checks", () => {
    for (const r of RULES) { expect(r.fix.length).toBeGreaterThan(10); expect(r.sidecar.length).toBeGreaterThan(0); }
  });
});

describe("tool input validation (no network)", () => {
  const isFix = (r: { isError?: boolean; content: { text: string }[] }) => r.isError === true && /Fix:/.test(text(r));
  it("rejects before any RPC", async () => {
    expect(isFix(await checkAdmissionTool({}))).toBe(true);
    expect(isFix(await checkAdmissionTool({ raw: "nothex" }))).toBe(true);
    expect(isFix(await getAdmissionReportTool({ hash: "0x12" }))).toBe(true);
    expect(isFix(await waitForReceiptTool({ hash: "0x12" }))).toBe(true);
    expect(isFix(await sendCallsTool({ calls: [] }))).toBe(true);
    expect(isFix(await prepareOwnerTxTool({ account: "nope", calls: [{ to: "0x23864f6a599992d1964f3988dde398f989d134a0" }] }))).toBe(true);
    expect(isFix(await submitFrameTxTool({}))).toBe(true);
    expect(isFix(await submitFrameTxTool({ raw: "0x06", tx: {} }))).toBe(true);
  });
});
