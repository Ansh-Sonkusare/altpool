import { formatEther } from "viem";
import { deployments, EXIT_FEE } from "@altpool/contracts";
import { DEVNET, explorerTx } from "@altpool/core";
import { DEFAULT_NODES, type NodeRef } from "@altpool/monitor";

export const lc = (a: string) => a.toLowerCase();
export const isAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isHash = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(s);

/** Entities we deployed. fee = what the entity earns per tx, for the margin line (ExitRelay takes EXIT_FEE). */
export const KNOWN: Record<string, { label: string; fee?: bigint }> = {};
for (const [addr, label, fee] of [[deployments.payRelayWETH, "PayRelayWETH"], [deployments.exitRelay, "ExitRelay", EXIT_FEE], [deployments.exitRelayRR, "ExitRelayRR", EXIT_FEE], [deployments.exitRelayWETH, "ExitRelayToken"]] as const)
  if (addr) KNOWN[lc(addr)] = { label, fee };
export const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141";

export type NodeChoice = "both" | "gateway" | "miner";
export const nodesFor = (c: NodeChoice): NodeRef[] => (c === "both" ? DEFAULT_NODES : DEFAULT_NODES.filter((n) => n.name === c));

export const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
export const ethDp = (wei: bigint, dp = 4) => `${Number(formatEther(wei)).toFixed(dp)} ETH`;
export const num = (x: number | bigint) => x.toLocaleString("en-US");
export const ago = (ms: number) =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`;
export const clockAt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
export const secs = (ms?: number) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

/** Explorer link on a node that has the tx (the explorer defaults to the gateway's view). */
export const explorerUrl = (hash: string, on: string[] = []) => {
  const url = DEFAULT_NODES.find((n) => n.name === on[0])?.url;
  return !on.length || on.includes("gateway") || !url ? explorerTx(hash) : `${explorerTx(hash)}?node=${encodeURIComponent(url)}`;
};
export { DEVNET };
