import { describe, expect, it } from "vitest";
import { fixture, mockWithdrawProof, scenario, scenarios } from "../src/fixtures";

describe("captured fixtures", () => {
  it("every scenario loads as {request, response}", () => {
    for (const s of scenarios) {
      const calls = scenario(s);
      expect(calls.length, s).toBeGreaterThan(0);
      for (const c of calls) expect(typeof c.request.method, c.file).toBe("string");
    }
  });

  it("ethrex simulate reports the public-mempool violation", () => {
    const r = fixture("public/29-ethrex_simulateFrameTransaction.json").response.result;
    expect(r.canonicalMempoolValid).toBe(false);
    expect(r.canonicalMempoolViolation).toBe("StorageReadNonSender");
  });

  it("frame_simulateTransactionV1 is not deployed on the devnet", () => {
    expect(fixture("public/22-frame_simulateTransactionV1.json").response.error?.code).toBe(-32601);
  });

  it("mock proof parses", () => {
    expect(mockWithdrawProof().fee).toBe(10n ** 16n);
  });
});
