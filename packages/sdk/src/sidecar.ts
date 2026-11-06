// The alt-mempool sidecar client: one node, one HTTP endpoint, an optional WebSocket endpoint, one explicit profile.
import type { Address, Hex } from "@altpool/core";
import { toWire } from "@forshtat/hegota-support/rpc";
import { txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { AltMempoolRpcError, UnsupportedCapabilityError, type AltpoolSdkError } from "./errors";
import {
  assertAddress, assertHash, parseAdmission, parseConfig, parseEntry, parseEstimate, parseExplorerInfo, parseExplorerTx,
  parseGasPrice, parseReceipt, parseReputation, parseStatus,
  type AdmissionOutcome, type AdmissionRecord, type ExplorerInfo, type ExplorerTransaction, type FrameGasEstimate, type FrameReceipt,
  type FrameTxStatus, type GasPrice, type MempoolEntry, type NodeIdentity, type Page, type ReputationEntry, type SidecarConfig,
} from "./normalize";
import { assertProfile, type Profile } from "./profiles";
import { httpRpc, wsRpc, type HttpRpcOptions, type RpcRequester, type WebSocketCtor, type WsRpc, type WsRpcOptions, type WsSubscription } from "./transport";
import type { TxStatus } from "@altpool/core";

export interface AltMempoolClientConfig {
  /** Sidecar JSON-RPC over HTTP, e.g. https://altmempoolgateway.forshtat.com/rpc */
  httpUrl: string;
  /** Sidecar JSON-RPC over WebSocket (same path, ws/wss). Needed for subscriptions. */
  webSocketUrl?: string;
  /** Explicit codec profile. There is no default. */
  profile: Profile;
  /** A name for this node; carried on every node-local answer. Defaults to the URL host. */
  name?: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  timeoutMs?: number;
  trace?: HttpRpcOptions["trace"];
  ws?: Omit<WsRpcOptions, "WebSocket" | "kind">;
}

/** Raw subscription kinds the sidecar accepts. They keep their ERC-4337 names; the SDK exposes frame-tx names. */
export const SUBSCRIPTION_KINDS = {
  pending: "pendingUserOps",
  submitted: "submittedUserOps",
  onChain: "onChainUserOps",
  explorer: "explorerEvents",
} as const;
export type SubscriptionKind = keyof typeof SUBSCRIPTION_KINDS;

export interface SubmitResult {
  /** Hash the node returned. */
  hash: Hex;
  /** txHash(profile, tx) computed locally with the codec. */
  localHash: Hex;
  /** false means the node and the codec disagree about the bytes: check the profile. */
  hashMatches: boolean;
  /** Name of the mempool / node it went to. */
  mempool: string;
  node: NodeIdentity;
}

export type AltMempoolClient = ReturnType<typeof createAltMempoolClient>;

const notFound = (e: unknown) => e instanceof AltMempoolRpcError && /not found/i.test(e.rpc?.message ?? "");

export function createAltMempoolClient(cfg: AltMempoolClientConfig) {
  assertProfile(cfg.profile);
  const profile = cfg.profile;
  const http: RpcRequester = httpRpc(cfg.httpUrl, { fetch: cfg.fetch, timeoutMs: cfg.timeoutMs, trace: cfg.trace, kind: "alt" });
  let ws: WsRpc | undefined;
  const node: NodeIdentity = { name: cfg.name ?? safeHost(cfg.httpUrl), url: cfg.httpUrl };

  const socket = (): WsRpc => {
    if (!cfg.webSocketUrl) throw new UnsupportedCapabilityError("websocket", `No webSocketUrl configured for sidecar "${node.name}"; subscriptions need one.`);
    ws ??= wsRpc(cfg.webSocketUrl, { ...cfg.ws, WebSocket: cfg.WebSocket, kind: "alt" });
    return ws;
  };
  const request = <T = any>(method: string, params: unknown[] = []) => http.request<T>(method, params);
  const explorer = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    try {
      return await request<T>(method, params);
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) throw new UnsupportedCapabilityError("explorer", `The explorer API is disabled on "${node.name}" (needs --explorer.enable).`, { rpc: e.rpc });
      throw e;
    }
  };
  const wire = (tx: FrameTx | Record<string, unknown>) => ("frames" in tx && Array.isArray(tx.frames) && typeof (tx as FrameTx).chainId === "bigint" ? toWire(tx as FrameTx) : tx);

  return {
    profile,
    node,
    httpUrl: cfg.httpUrl,
    webSocketUrl: cfg.webSocketUrl,
    /** Escape hatch: any method, raw result. Errors are still typed. */
    request,

    // ---- node configuration
    getConfig: async (): Promise<SidecarConfig> => parseConfig(await request("skandha_config")),
    getExplorerInfo: async (): Promise<ExplorerInfo> => {
      const info = parseExplorerInfo(await explorer("skandha_explorer_info"));
      node.version = info.version;
      node.bootId = info.bootId;
      node.chainId = info.chainId;
      return info;
    },
    getChainId: async (): Promise<number> => Number(await request<Hex>("eth_chainId")),
    getClientVersion: (): Promise<string> => request("web3_clientVersion"),
    getGasPrice: async (): Promise<GasPrice> => parseGasPrice(await request("skandha_getGasPrice")),
    getConnectedPeers: (): Promise<unknown[]> => request<unknown[]>("skandha_connectedPeers").then((r) => r ?? []),
    getExplorerPeers: (): Promise<unknown[]> => explorer<unknown[]>("skandha_explorer_peers").then((r) => r ?? []),

    // ---- frame transactions
    /** `eth_estimateFrameTransactionGas`. Takes a FrameTx or an already-wire partial tx. See estimateFrameTransactionGas() in actions for the signing recipe. */
    estimateFrameTransactionGas: async (tx: FrameTx | Record<string, unknown>): Promise<FrameGasEstimate> =>
      parseEstimate(await request("eth_estimateFrameTransactionGas", [wire(tx)])),
    /** `eth_sendFrameTransaction` with the full signed tx. Never retried. */
    sendFrameTransaction: async (tx: FrameTx): Promise<SubmitResult> => {
      const localHash = txHash(profile, tx);
      const hash = await request<Hex>("eth_sendFrameTransaction", [toWire(tx)]);
      return { hash, localHash, hashMatches: hash?.toLowerCase() === localHash.toLowerCase(), mempool: node.name, node };
    },
    /** The node's mempool entry, or null when this node does not hold it. */
    getFrameTransaction: async (hash: Hex): Promise<MempoolEntry | null> => {
      assertHash(hash);
      const r = await request("eth_getFrameTransactionByHash", [hash]).catch((e) => (notFound(e) ? null : Promise.reject(e)));
      return r ? parseEntry({ txHash: hash, ...r, nonce: r.tx?.nonceSeq ?? r.nonce, sender: r.sender ?? r.tx?.sender }) : null;
    },
    /** Sidecar frame receipt, or null while not mined. */
    getFrameTransactionReceipt: async (hash: Hex): Promise<FrameReceipt | null> => {
      assertHash(hash);
      try {
        const r = await request("eth_getFrameTransactionReceipt", [hash]);
        return r ? parseReceipt(hash, r, "sidecar") : null;
      } catch (e) {
        if (e instanceof AltMempoolRpcError && /not found|not mined|not yet|pending/i.test(e.rpc?.message ?? "")) return null;
        throw e;
      }
    },
    /** `skandha_frameTransactionStatus` (request/response, not a push). Null for a hash this node never saw. */
    getTransactionStatus: async (hash: Hex): Promise<FrameTxStatus | null> => {
      assertHash(hash);
      try {
        return parseStatus(hash, await request("skandha_frameTransactionStatus", [hash]), node);
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },

    // ---- explorer (node-local history; in-memory on the public devnet)
    listTransactions: async (q: { status?: TxStatus; cursor?: string; limit?: number } = {}): Promise<Page<MempoolEntry>> => {
      const r = await explorer<any>("skandha_explorer_listTransactions", [q]);
      return { items: (r?.items ?? []).map(parseEntry), nextCursor: r?.nextCursor ?? undefined };
    },
    listAdmissions: async (q: { outcome?: AdmissionOutcome; cursor?: string; limit?: number } = {}): Promise<Page<AdmissionRecord>> => {
      const r = await explorer<any>("skandha_explorer_listAdmissions", [q]);
      return { items: (r?.items ?? []).map(parseAdmission), nextCursor: r?.nextCursor ?? undefined };
    },
    /** Entry + admission record + retained lifecycle events. Null for an unknown hash. */
    getExplorerTransaction: async (hash: Hex): Promise<ExplorerTransaction | null> => {
      assertHash(hash);
      try {
        return parseExplorerTx(await explorer("skandha_explorer_getTransaction", [hash]), node);
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    listReputation: async (q: { cursor?: string; limit?: number } = {}): Promise<Page<ReputationEntry>> => {
      const r = await explorer<any>("skandha_explorer_listReputation", [q]);
      return { items: (r?.items ?? []).map((x: any) => parseReputation(x, node)), nextCursor: r?.nextCursor ?? undefined };
    },
    /** Devnet faucet (if the node has it enabled). */
    faucet: (address: Address): Promise<{ txHash: Hex; amount: string }> => {
      assertAddress(address);
      return explorer("skandha_explorer_faucet", [address]);
    },
    /** The node's own stake verdict for an entity (`debug_bundler_getStakeStatus`, an admin method; may be disabled). */
    getNodeStakeStatus: async (address: Address, registry: Address): Promise<{ isStaked: boolean; stake: bigint; unstakeDelaySec: number; withdrawTime: bigint; raw: unknown }> => {
      const r = await request<any>("debug_bundler_getStakeStatus", [address, registry]);
      return { isStaked: !!r.isStaked, stake: BigInt(r.stakeInfo?.stake ?? 0), unstakeDelaySec: Number(r.stakeInfo?.unstakeDelaySec ?? 0), withdrawTime: BigInt(r.stakeInfo?.withdrawTime ?? 0), raw: r };
    },

    // ---- subscriptions
    /** Low-level `skandha_subscribe`. `params` is re-evaluated on every reconnect. Prefer the watch* helpers. */
    subscribe: (kind: SubscriptionKind, params: () => unknown[], onEvent: (r: unknown) => void, onError?: (e: AltpoolSdkError) => void): Promise<WsSubscription> =>
      socket().subscribe(() => [SUBSCRIPTION_KINDS[kind], ...params()], onEvent, onError),
    get socketStatus() { return ws?.status ?? "idle"; },
    hasWebSocket: (): boolean => !!cfg.webSocketUrl,
    close: () => { ws?.close(); ws = undefined; },
  };
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
