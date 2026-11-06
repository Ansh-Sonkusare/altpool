// Thin JSON-RPC clients. Methods and param shapes match captured fixtures.
import { rpc } from "@forshtat/hegota-support/rpc";
import { DEVNET } from "./devnet";
import type { Address, Hex } from "./types";

export type Call = (method: string, params?: unknown[]) => Promise<any>;
export { RpcError, toWire, explainRejection } from "@forshtat/hegota-support/rpc";

/** The ERC-8421 sidecar (alt mempool). */
export const gateway = (url: string = DEVNET.gatewayUrl) => {
  const call: Call = (m, p = []) => rpc(url, m, p);
  return {
    url,
    call,
    sendFrameTransaction: (wire: unknown): Promise<Hex> => call("eth_sendFrameTransaction", [wire]),
    estimateFrameTransactionGas: (wire: unknown) => call("eth_estimateFrameTransactionGas", [wire]),
    faucet: (address: Address) => call("skandha_explorer_faucet", [address]),
    txStatus: (hash: Hex) => call("skandha_frameTransactionStatus", [hash]),
    admission: (hash: Hex) => call("skandha_explorer_getTransaction", [hash]),
    listReputation: (limit = 100) => call("skandha_explorer_listReputation", [{ limit }]),
    explorerInfo: () => call("skandha_explorer_info"),
    receipt: (hash: Hex) => call("eth_getTransactionReceipt", [hash]),
  };
};

export interface EthrexSimulation { canonicalMempoolValid: boolean; canonicalMempoolViolation?: string; erc7562Trace?: unknown[] }

/** ethrex: the public mempool, eth_call, and the public-mempool simulator. */
export const ethrex = (url: string = DEVNET.ethrexUrl) => {
  const call: Call = (m, p = []) => rpc(url, m, p);
  return {
    url,
    call,
    simulateFrameTransaction: (raw: Hex, trace = false): Promise<EthrexSimulation> =>
      call("ethrex_simulateFrameTransaction", [raw, "latest", { trace }]),
    sendRawTransaction: (raw: Hex): Promise<Hex> => call("eth_sendRawTransaction", [raw]),
  };
};
