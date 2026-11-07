// Typed errors. Every error raised from an RPC reply keeps the method, endpoint, code, data and the raw body.
// Message parsing is pinned to strings captured from the live devnet (packages/core/fixtures).
import type { Address, AltpoolError, EntityRole, Hex, Mempool, RuleId } from "@altpool/core";

export interface RpcErrorInfo {
  method: string;
  url: string;
  /** JSON-RPC error code, absent for transport failures. */
  code?: number;
  message: string;
  data?: unknown;
  /** The full response body (or undefined if none was received). */
  raw?: unknown;
  params?: unknown[];
}

export class AltpoolSdkError extends Error {
  override name = "AltpoolSdkError";
  /** Present for errors that came from an RPC reply. */
  readonly rpc?: RpcErrorInfo;
  /** The normalized failure (the shared @altpool/core union). */
  readonly detail?: AltpoolError;
  /** One line telling the developer what to do next. */
  readonly fix?: string;
  constructor(message: string, opts: { rpc?: RpcErrorInfo; detail?: AltpoolError; fix?: string; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.rpc = opts.rpc;
    this.detail = opts.detail;
    this.fix = opts.fix;
  }
}

/** Any error reply from a node, or a transport failure talking to one. */
export class AltMempoolRpcError extends AltpoolSdkError { override name = "AltMempoolRpcError"; }
/** The node could not be reached, timed out, or answered without JSON. */
export class TransportError extends AltMempoolRpcError { override name = "TransportError"; }
/** A mempool rule rejected the transaction (storage, opcode, prefix, gas limit, reputation, decode). */
export class FrameAdmissionError extends AltMempoolRpcError { override name = "FrameAdmissionError"; }
/** A validation frame reverted while the node simulated it. */
export class FrameSimulationError extends AltMempoolRpcError { override name = "FrameSimulationError"; }
/** The node could not verify a signature entry. */
export class FrameSignatureError extends AltMempoolRpcError { override name = "FrameSignatureError"; }
/** Nonce key held by another pending tx, replacement underpriced, sequence mismatch, or bad key set. */
export class NonceConflictError extends AltMempoolRpcError { override name = "NonceConflictError"; }
/** A recent-root reference is not committed, too old, or not yet usable. */
export class RecentRootExpiredError extends AltMempoolRpcError { override name = "RecentRootExpiredError"; }
export class StakeConfigurationError extends AltpoolSdkError { override name = "StakeConfigurationError"; }
export class InsufficientStakeError extends AltpoolSdkError { override name = "InsufficientStakeError"; }
export class ProfileMismatchError extends AltpoolSdkError { override name = "ProfileMismatchError"; }
export class SubscriptionError extends AltpoolSdkError { override name = "SubscriptionError"; }
export class ReceiptTimeoutError extends AltpoolSdkError { override name = "ReceiptTimeoutError"; }
/** An action would have asked a person (a browser wallet) to sign a copy of the tx: an estimation probe or simulation copy. */
export class InteractiveSignerError extends AltpoolSdkError { override name = "InteractiveSignerError"; }
/** The wallet is not on the devnet: wrong chain id, or a different chain that shares the id (MetaMask's Localhost 8545 is also 1337). */
export class WrongNetworkError extends AltpoolSdkError { override name = "WrongNetworkError"; }

export class UnsupportedCapabilityError extends AltpoolSdkError {
  override name = "UnsupportedCapabilityError";
  constructor(readonly capability: string, message: string, opts: { rpc?: RpcErrorInfo } = {}) {
    super(message, opts);
  }
}

const ROLE = "(sender|payer|factory)";
const ADDR = "(0x[0-9a-fA-F]{40})";
const revertReason = (data?: string): string | undefined => {
  // Error(string): 0x08c379a0 | offset | length | bytes
  if (!data?.startsWith("0x08c379a0") || data.length < 10 + 64 * 3) return undefined;
  const len = parseInt(data.slice(10 + 64, 10 + 128), 16);
  const hex = data.slice(10 + 128, 10 + 128 + len * 2);
  try {
    return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16)));
  } catch {
    return undefined;
  }
};

/** The `mempool` an endpoint answers for: ethrex is the public mempool, the sidecar the alt mempool. */
export type EndpointKind = Mempool;

const FIX: Partial<Record<RuleId, string>> = {
  storage: "The entity reads storage it does not own. Stake that entity in the registry (from its own address) or avoid the read.",
  "OP-011": "Validation used a banned opcode (e.g. GAS, TIMESTAMP). Remove it from the VERIFY path.",
  prefix: "The leading frames do not form a recognized validation prefix. Start with VERIFY frames that APPROVE execution and payment.",
  "gas-limit": "Lower the frame limits: the total exceeds the node's per-transaction cap.",
  signature: "Re-sign after the last change to frames, fees or nonce: the signature hash covers all of them.",
  "recent-root": "Reference a root that is committed, at a slot before the current one and within the usable window.",
  "public-storage": "The public mempool only lets validation read the sender's storage. Send to the alt mempool with the entity staked.",
  "public-gas-cap": "The public mempool caps the validation prefix at 100,000 gas. Shrink VERIFY or use the alt mempool.",
  simulation: "A validation frame reverted. Decode the revert reason and fix the state or calldata it checks.",
};

/** Map one node error reply to a typed error. `kind` says which mempool's node produced it. */
export function decodeRpcError(info: RpcErrorInfo, kind: EndpointKind = "alt"): AltpoolSdkError {
  const { code, message } = info;
  const m = message ?? "";
  const data = (info.data ?? undefined) as Record<string, unknown> | undefined;
  const entityFromData = (): { role: EntityRole; address: Address } | undefined => {
    if (!data || typeof data !== "object") return undefined;
    for (const role of ["payer", "sender", "factory"] as const) if (typeof data[role] === "string") return { role, address: data[role] as Address };
    return undefined;
  };
  let r: RegExpMatchArray | null;

  if (code === undefined) return new TransportError(m, { rpc: info, detail: { kind: "rpc", code: -1, message: m } });
  if (code === -32601) return new UnsupportedCapabilityError(info.method, `${info.method} is not available on ${info.url}: ${m}`, { rpc: info });

  if (code === -32507) return new FrameSignatureError(m, { rpc: info, detail: { kind: "signature", message: m }, fix: FIX.signature });

  if ((r = m.match(new RegExp(`${ROLE} ${ADDR} is (throttled|banned)`, "i")))) {
    const role = r[1]!.toLowerCase() as EntityRole;
    const status = r[3]!.toLowerCase() as "throttled" | "banned";
    return new FrameAdmissionError(m, {
      rpc: info,
      detail: { kind: "reputation", status, role, address: r[2] as Address },
      fix: `The ${role} is ${status} by this node's (node-local) reputation. Wait for inclusions to catch up, or use a different ${role}.`,
    });
  }
  if (/already held by pending transaction/i.test(m)) {
    const key = m.match(/nonce key (0x[0-9a-fA-F]+)/i)?.[1];
    const pending = m.match(/pending transaction (0x[0-9a-fA-F]{64})/i)?.[1] as Hex | undefined;
    return new NonceConflictError(m, {
      rpc: info,
      detail: { kind: "nonceKeyHeld", key: key ? BigInt(key) : -1n, pendingHash: pending ?? "0x" },
      fix: "Another pending tx holds this nonce key. Use a fresh key, wait for it to land, or replace it with +10% on both fees.",
    });
  }
  if (/cannot be replaced: fee too low/i.test(m)) {
    return new NonceConflictError(m, { rpc: info, detail: { kind: "replacementUnderpriced", message: m }, fix: "Bump both maxFeePerGas and maxPriorityFeePerGas by at least 10% (see replacementFees())." });
  }
  if (/nonce mismatch|nonceKeys count|nonce key/i.test(m)) {
    return new NonceConflictError(m, { rpc: info, detail: { kind: "rpc", code, message: m }, fix: "Read the current sequence with getNonceSequence() and use 1-16 strictly increasing keys." });
  }
  if (/recent-root|EIP-8272/i.test(m)) {
    return new RecentRootExpiredError(m, { rpc: info, detail: { kind: "recentRoot", message: m }, fix: FIX["recent-root"] });
  }
  if ((r = m.match(/validation frame (\d+): (?:reverted(?: with data (0x[0-9a-fA-F]*))?|(.*))/i))) {
    return new FrameSimulationError(m, {
      rpc: info,
      detail: { kind: "validationReverted", frameIndex: Number(r[1]), revertReason: revertReason(r[2]), message: m },
      fix: FIX.simulation,
    });
  }
  if (/Error decoding field/i.test(m)) {
    return new FrameAdmissionError(m, { rpc: info, detail: { kind: "decode", mempool: kind, message: m }, fix: "The bytes do not match this node's layout. Encode with the node's hegota-support profile." });
  }
  const rule = ruleFromMessage(m, kind);
  if (rule) {
    return new FrameAdmissionError(m, {
      rpc: info,
      detail: { kind: "ruleViolation", mempool: kind, rule, entity: entityFromData(), message: m },
      fix: FIX[rule],
    });
  }
  return new AltMempoolRpcError(m, { rpc: info, detail: { kind: "rpc", code, message: m } });
}

/** Rule id for a rejection message, or undefined when the text matches no known rule. */
export function ruleFromMessage(m: string, kind: EndpointKind = "alt"): RuleId | undefined {
  if (/StorageReadNonSender/i.test(m)) return "public-storage";
  if (/prefix gas budget exceeded/i.test(m)) return "public-gas-cap";
  if (/accessed .*slot|storage/i.test(m)) return kind === "public" ? "public-storage" : "storage";
  if (/banned opcode/i.test(m)) return "OP-011";
  if (/validation prefix not recognized/i.test(m)) return "prefix";
  if (/exceeds the per-transaction gas cap|total gas limit/i.test(m)) return "gas-limit";
  if (/out of gas/i.test(m)) return "out-of-gas";
  return undefined;
}

export const isRpcError = (e: unknown): e is AltMempoolRpcError => e instanceof AltMempoolRpcError || (e instanceof AltpoolSdkError && !!e.rpc);
