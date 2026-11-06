// Every devnet read in the site goes through these clients, built once.
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { gateway } from "@altpool/core";
import { createSimulator } from "@altpool/simulator";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, explorerTx } from "altpool";

export { profile };

const miner = createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, profile, name: "miner" });
const gatewaySidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile, name: "gateway" });

export const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(
  altpoolActions({ sidecar: miner, mempools: { gateway: gatewaySidecar }, explorerUrl: DEVNET.explorerUrl }),
);

/** The sidecars frame-doctor asks about a sent hash, miner first. */
export const MEMPOOLS = [
  { name: "miner", url: DEVNET.minerSidecarUrl },
  { name: "gateway", url: DEVNET.gatewayUrl },
] as const;

export const simulator = createSimulator({ explorer: false });

/** watchEntity takes core's untyped gateway, not an SDK client. */
export const minerGateway = gateway(DEVNET.minerSidecarUrl);

/** Exits went to the miner's sidecar; the explorer's default view (the gateway) never saw them. */
export const exitUrl = (h: string) => `${explorerTx(h)}?node=${encodeURIComponent(DEVNET.minerSidecarUrl)}`;
export const addrUrl = (a: string) => `${DEVNET.explorerUrl}/address/${a}`;
