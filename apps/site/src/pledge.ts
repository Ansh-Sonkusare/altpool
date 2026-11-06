// Pledge Paid runs, read live: PayRelayWETH's own report (useEntity polls it every 5 s) lists every 9-frame payment it
// paid for, and the page remembers the last one it sent itself. No hash is hard-coded.
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import type { EntityReport } from "@altpool/monitor";

export type PledgeRun = { hash: Hex; block?: number; outcome: "included" | "reverted" };

/** Newest first: inclusions, then txs the sidecar recorded as reverted on chain. */
export const recentRuns = (r: EntityReport | undefined): PledgeRun[] => [
  ...(r?.inclusions ?? []).map((i): PledgeRun => ({ hash: i.hash, block: i.block, outcome: "included" })),
  ...(r?.evictions ?? []).filter((e) => e.reason === "reverted on chain").map((e): PledgeRun => ({ hash: e.hash, outcome: "reverted" })),
];

let lastSent: Hex | undefined;
const subs = new Set<() => void>();
export const setLastSent = (h: Hex) => { lastSent = h; subs.forEach((f) => f()); };
export const useLastSent = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => lastSent);

/** The run the live sender is working on, shared so the Toolkit and frame-doctor can follow it. */
export type CurrentRun = {
  preset: string;
  /** True when the visitor picked a preset designed to revert. */
  expectRevert: boolean;
  /** The signed-free 9-frame tx, hex-encoded, once built (before send). */
  raw?: Hex;
  /** Set once the sidecar accepts it. */
  hash?: Hex;
};
let current: CurrentRun | undefined;
const runSubs = new Set<() => void>();
export const setCurrentRun = (r: CurrentRun | undefined) => { current = r; runSubs.forEach((f) => f()); };
export const useCurrentRun = () => useSyncExternalStore((f) => (runSubs.add(f), () => runSubs.delete(f)), () => current);
