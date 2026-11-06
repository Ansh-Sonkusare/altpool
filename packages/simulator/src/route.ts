// Owner: Dev C. Where should this tx go? The brief's `mempool: 'auto'`, built on checkAdmission so the SDK needn't change.
//   1. public, when the public mempool admits it (widest reach; inclusion lists can force it in);
//   2. otherwise alt, when the alt mempool admits it, on the sidecar that will carry it: the miner's own sidecar when
//      validation is over the 100k public cap (the gateway's revalidation drops those, packages/sdk/README.md; our 460k
//      exits only landed via the miner), else the gateway, the public front door;
//   3. otherwise nowhere, with every reason and fix.
// Use with the SDK: altpoolActions({ sidecar: gateway, mempools: { gateway, miner } }), then
// submitFrameTransaction({ transaction, mempool: decision.target === "public" ? "public" : decision.node }).
import { DEVNET, type AdmissionReport, type FrameTx, type Hex, type MempoolVerdict } from "@altpool/core";
import { checkAdmission } from "./check";

export type SidecarName = "gateway" | "miner";

export interface RouteDecision {
  target: "public" | "alt" | "none";
  /** For alt: which sidecar to submit to. */
  node?: SidecarName;
  /** Where to send: ethrex for public, the sidecar's /rpc for alt. */
  url?: string;
  /** The other sidecar, if the first is unreachable. */
  fallback?: { node: SidecarName; url: string };
  /** One line, e.g. "public rejects public-gas-cap (prefix gas budget exceeded: 450000 > 100000); alt admits; miner: VERIFY 460,000 > 100,000". */
  reason: string;
  /** False when the verdict that decided it came from our local rule model rather than a node. */
  verified: boolean;
  /** For none: what to change, per mempool. */
  fixes: string[];
  report: AdmissionReport;
}

export interface RouteOptions {
  /** "alt" sends to the alt mempool even when the public one would take it. */
  prefer?: "public" | "alt";
  /** VERIFY gas above which only the miner's sidecar is trusted to carry the tx (default: the 100k public cap). */
  heavyVerifyAt?: bigint;
  gatewayUrl?: string;
  minerUrl?: string;
  ethrexUrl?: string;
}

const why = (v: MempoolVerdict) => {
  const msg = v.error?.revertReason ?? v.error?.message;
  return `${v.failed?.rule ?? "rejected"}${msg ? ` (${msg.length > 90 ? `${msg.slice(0, 90)}…` : msg})` : ""}`;
};
const verified = (v: MempoolVerdict) => v.source !== "model";

/** The decision for a report you already have (from checkAdmission or frame-doctor). Pure: no network. */
export const routeFromReport = (report: AdmissionReport, o: RouteOptions = {}): RouteDecision => {
  const pub = report.verdicts.public, alt = report.verdicts.alt;
  const urls = { gateway: o.gatewayUrl ?? DEVNET.gatewayUrl, miner: o.minerUrl ?? DEVNET.minerSidecarUrl };
  const heavyAt = o.heavyVerifyAt ?? DEVNET.publicVerifyGasCap;
  const pubOk = pub.verdict === "admitted";
  // The model could not run (no trace from ethrex): not a rejection we can stand behind. Sending is the test.
  const altUnknown = alt.verdict === "rejected" && alt.failed?.rule === "unknown";
  const altOk = alt.verdict === "admitted" || altUnknown;

  if (pubOk && (o.prefer !== "alt" || !altOk)) {
    return {
      target: "public", url: o.ethrexUrl ?? DEVNET.ethrexUrl, verified: verified(pub), fixes: [], report,
      reason: `public admits${o.prefer === "alt" ? " (alt would reject it)" : ""}`,
    };
  }
  if (altOk) {
    const heavy = report.verifyGas !== undefined && report.verifyGas > heavyAt;
    const node: SidecarName = heavy ? "miner" : "gateway";
    const other: SidecarName = heavy ? "gateway" : "miner";
    const reasons = [
      pubOk ? "public admits too, but alt preferred" : `public rejects ${why(pub)}`,
      altUnknown ? "alt rules could not be modelled (no trace), so sending is the test" : `alt admits${verified(alt) ? "" : " (local model, unverified)"}`,
      heavy ? `miner: VERIFY ${report.verifyGas!.toLocaleString("en-US")} > ${heavyAt.toLocaleString("en-US")}, which the gateway drops` : "gateway: VERIFY within the public cap",
    ];
    return {
      target: "alt", node, url: urls[node],
      // A heavy tx sent to the gateway can be dropped, so it has no fallback.
      fallback: heavy ? undefined : { node: other, url: urls[other] },
      verified: verified(alt) && !altUnknown, fixes: [], report, reason: reasons.join("; "),
    };
  }
  return {
    target: "none", verified: verified(pub) && verified(alt), report,
    reason: `public rejects ${why(pub)}; alt rejects ${why(alt)}`,
    // Same cause on both (a used nonce, a revert): say it once.
    fixes: pub.fix && pub.fix === alt.fix ? [`both: ${pub.fix}`]
      : [pub.fix && `public: ${pub.fix}`, alt.fix && `alt: ${alt.fix}`].filter((x): x is string => Boolean(x)),
  };
};

/** Check the tx against both mempools, then decide where it goes. The tx must be final (gas filled, signed). */
export const routeTransaction = async (
  tx: FrameTx | Hex,
  o: RouteOptions & { simulator?: { check: (tx: FrameTx | Hex) => Promise<AdmissionReport> } } = {},
): Promise<RouteDecision> => routeFromReport(await (o.simulator ? o.simulator.check(tx) : checkAdmission(tx)), o);

/** The SDK mempool name for a decision: "public", "gateway" or "miner" (register both sidecars under those names). */
export const sdkMempool = (d: RouteDecision): "public" | SidecarName => {
  if (d.target === "none") throw new Error(`no mempool admits this tx: ${d.reason}`);
  return d.target === "public" ? "public" : d.node!;
};
