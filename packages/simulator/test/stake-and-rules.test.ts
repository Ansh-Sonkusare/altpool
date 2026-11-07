import { describe, expect, it } from "vitest";
import { runAccuracy } from "../src/accuracy";
import { diagnoseError, diagnoseSimulation } from "../src/rules";

describe("stake delay is compared with the node's minimum (0), not our 86400", () => {
  it("case 4 (alt): an entity staked with delay 0 is admitted, as the node did", async () => {
    const r = await runAccuracy();
    const c = r.cases.find((x) => x.input.includes("case04-alt"))!;
    expect(c.comparisons[0]).toMatchObject({ mempool: "alt", judgement: "match", predicted: { verdict: "admitted" } });
  });
});

describe("rule mapping", () => {
  const sim = (canonicalMempoolViolation: string | null, executionError: string | null = null) =>
    ({ canonicalMempoolValid: false, canonicalMempoolViolation, executionError }) as never;

  it("public 'Invalid frame transaction signature' -> signature", () => {
    expect(diagnoseError({ code: -32000, message: "Invalid params: Invalid frame transaction signature" }, "public").rule).toBe("signature");
  });
  it("alt -32507 -> signature", () => {
    expect(diagnoseError({ code: -32507, message: "Invalid frame transaction signature" }, "alt").rule).toBe("signature");
  });
  it("simulation violation 'frame signature list does not authenticate the sender' -> signature", () => {
    expect(diagnoseSimulation(sim("frame signature list does not authenticate the sender"))?.rule).toBe("signature");
  });
  it("'expiry deadline has passed' -> simulation", () => {
    expect(diagnoseError({ code: -32000, message: "Invalid params: Frame transaction expiry deadline has passed" }, "public").rule).toBe("simulation");
  });
  it("alt 'validation frame 0: reverted' -> simulation", () => {
    expect(diagnoseError({ code: -32500, message: "validation frame 0: reverted" }, "alt").rule).toBe("simulation");
  });
  it("'atomic batch flag on last frame' -> structure", () => {
    expect(diagnoseError({ code: -32500, message: "atomic batch flag on last frame" }, "alt").rule).toBe("structure");
  });
});
