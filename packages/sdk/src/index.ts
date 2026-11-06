// altpool: a viem extension for the EIP-8141 frame-transaction alternative mempool (ERC-8421 sidecar).
//
//   import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
//   const sidecar = createAltMempoolClient({ httpUrl, webSocketUrl, profile });
//   const client = createPublicClient({ chain, transport: http(EXECUTION_RPC) }).extend(altpoolActions({ sidecar }));
//   await client.altpool.getMempoolInfo();
export { altpoolActions, type AltpoolActions, type AltpoolActionsOptions, type Capabilities, type MempoolTarget } from "./actions";
export { createAltMempoolClient, SUBSCRIPTION_KINDS, type AltMempoolClient, type AltMempoolClientConfig, type SubmitResult, type SubscriptionKind } from "./sidecar";
export * from "./errors";
export * from "./normalize";
export * from "./transaction";
export * from "./staking";
export * from "./nonces";
export * from "./recentRoots";
export * from "./admission";
export * from "./watch";
export { httpRpc, wsRpc, type RpcRequester, type RpcTraceEntry, type WsRpc, type WsStatus, type WsSubscription, type WebSocketCtor } from "./transport";
export { assertProfile, profileExtras, predeploy, supportedProfileIds, modeName, scopeName, type Profile, type ProfileExtras, type RecentRootLayout } from "./profiles";

export { altDevnet, DEVNET, explorerTx } from "@altpool/core";
export type { AdmissionChecker, AdmissionReport, AltpoolError, EntityRole, EntityStatus, Mempool, RuleId, TxStatus } from "@altpool/core";
