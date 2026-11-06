import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderReport, replaySimulator } from "../src";

// Live ethrex_simulateFrameTransaction (Nov 7, not sent): [VERIFY, Uniswap swap with ATOMIC_BATCH, fgUSD transfer of
// more than the sender holds]. canonicalMempoolValid true, executionStatus "reverted", frame 2 fails after 858 gas.
const captured = JSON.parse(readFileSync(new URL("./fixtures/atomic-batch-revert.json", import.meta.url), "utf8"));

it("an admitted tx that ethrex predicts will revert carries an execution warning naming the frame", async () => {
  const sim = replaySimulator(captured);
  const r = await sim.check(sim.raw);
  for (const v of [r.verdicts.public, r.verdicts.alt]) {
    expect(v.verdict).toBe("admitted");
    expect(v.checks?.find((c) => c.verdict === "warn")).toMatchObject({ rule: "execution", frameIndex: 2, detail: expect.stringMatching(/^frame 2 reverts in execution after 858 gas/) });
  }
  expect(renderReport(r)).toMatch(/warn execution: frame 2 reverts/);
});

it("no warning when the simulation succeeds", async () => {
  const ok = { ...captured, response: { result: { ...captured.response.result, executionStatus: "success", frames: [] } } };
  const sim = replaySimulator(ok);
  const r = await sim.check(sim.raw);
  expect(r.verdicts.alt.checks?.some((c) => c.verdict === "warn")).toBe(false);
  expect(r.verdicts.public.checks).toBeUndefined();
});
