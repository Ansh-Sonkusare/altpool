// Owner: Dev C. Vitest matchers, so a project can assert admission in its own tests (the brief's toBeAdmittedBy('alt')).
//
//   // vitest.setup.ts
//   import { expect } from "vitest";
//   import { altpoolMatchers } from "@altpool/simulator/vitest";
//   expect.extend(altpoolMatchers);
//
//   // in a test (async: they run checkAdmission against the devnet unless given a report or a checker)
//   await expect(tx).toBeAdmittedBy("alt");
//   await expect(tx).toBeAdmittedBy("alt", { verified: true });           // only a node's own answer counts
//   await expect(tx).not.toBeAdmittedBy("public");
//   await expect(tx).toBeRejectedFor("alt", "storage");
//   await expect(tx).toRouteTo("alt", "miner");
//   await expect(tx).toBeAdmittedBy("alt", { checker: replaySimulator(fixture(...), { staked: true }) }); // offline
//
// The received value may be a FrameTx, raw tx bytes, or an AdmissionReport you already have.
import type {} from "vitest"; // brings the module into the program so the augmentation below has something to extend
import type { AdmissionReport, FrameTx, Hex, Mempool, RuleId } from "@altpool/core";
import { checkAdmission } from "./check";
import { routeFromReport, type RouteOptions, type SidecarName } from "./route";

type Checker = { check: (tx: FrameTx | Hex) => Promise<AdmissionReport> };
export interface MatcherOptions { checker?: Checker }

const isReport = (x: unknown): x is AdmissionReport => typeof x === "object" && x !== null && "verdicts" in x;
const reportOf = async (received: unknown, o?: MatcherOptions): Promise<AdmissionReport> => {
  if (isReport(received)) return received;
  if (typeof received !== "string" && (typeof received !== "object" || received === null)) throw new TypeError("expected a FrameTx, raw tx bytes or an AdmissionReport");
  return (o?.checker ?? { check: checkAdmission }).check(received as FrameTx | Hex);
};
const verdictText = (r: AdmissionReport, m: Mempool) => {
  const v = r.verdicts[m];
  if (v.verdict === "admitted") return `admits it [${v.source === "model" ? "local model, unverified" : v.source}]`;
  return `rejects it: ${v.failed?.rule ?? "rejected"}${v.error?.message ? ` (${v.error.message})` : ""}${v.where ? ` at ${v.where}` : ""}${v.fix ? `\nFix: ${v.fix}` : ""}`;
};

export const altpoolMatchers = {
  async toBeAdmittedBy(received: unknown, mempool: Mempool, o: MatcherOptions & { verified?: boolean } = {}) {
    const r = await reportOf(received, o);
    const v = r.verdicts[mempool];
    const unverifiedOnly = v.verdict === "admitted" && o.verified && v.source === "model";
    const pass = v.verdict === "admitted" && !unverifiedOnly;
    return {
      pass,
      message: () => pass
        ? `expected the ${mempool} mempool not to admit the tx, but it ${verdictText(r, mempool)}`
        : unverifiedOnly
          ? `expected a node to admit the tx on ${mempool}, but only our local rule model says so (unverified)`
          : `expected the ${mempool} mempool to admit the tx, but it ${verdictText(r, mempool)}`,
      actual: v.verdict,
      expected: "admitted",
    };
  },

  async toBeRejectedFor(received: unknown, mempool: Mempool, rule: RuleId, o: MatcherOptions = {}) {
    const r = await reportOf(received, o);
    const v = r.verdicts[mempool];
    const pass = v.verdict === "rejected" && v.failed?.rule === rule;
    return {
      pass,
      message: () => pass
        ? `expected the ${mempool} mempool not to reject the tx for ${rule}, but it does`
        : `expected the ${mempool} mempool to reject the tx for ${rule}, but it ${verdictText(r, mempool)}`,
      actual: v.verdict === "rejected" ? v.failed?.rule : "admitted",
      expected: rule,
    };
  },

  async toRouteTo(received: unknown, target: "public" | "alt" | "none", node?: SidecarName, o: MatcherOptions & RouteOptions = {}) {
    const d = routeFromReport(await reportOf(received, o), o);
    const pass = d.target === target && (node === undefined || d.node === node);
    const want = `${target}${node ? ` via ${node}` : ""}`;
    const got = `${d.target}${d.node ? ` via ${d.node}` : ""}`;
    return {
      pass,
      message: () => pass ? `expected the tx not to route to ${want}, but it does: ${d.reason}` : `expected the tx to route to ${want}, but it routes to ${got}: ${d.reason}${d.fixes.length ? `\n${d.fixes.join("\n")}` : ""}`,
      actual: got,
      expected: want,
    };
  },
};

// Vitest 5: custom matchers extend Matchers<R, T> (Assertion and the asymmetric matchers both extend it). Await them.
declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toBeAdmittedBy(mempool: Mempool, o?: MatcherOptions & { verified?: boolean }): Promise<void>;
    toBeRejectedFor(mempool: Mempool, rule: RuleId, o?: MatcherOptions): Promise<void>;
    toRouteTo(target: "public" | "alt" | "none", node?: SidecarName, o?: MatcherOptions & RouteOptions): Promise<void>;
  }
}
