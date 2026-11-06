// Shared types. Shapes come from captured devnet responses (research repo derisk/interfaces.md).
// Additive changes only after H1; tell the team.
import type { FrameTx, Frame } from "@forshtat/hegota-support/tx";
export type { FrameTx, Frame };

export type Hex = `0x${string}`;
export type Address = Hex;
/** public = ethrex canonical mempool (eth_sendRawTransaction); alt = sidecar gateway (eth_sendFrameTransaction). */
export type Mempool = "public" | "alt";
export type EntityRole = "sender" | "payer" | "factory";

/** Sidecar ExplorerRuleId, plus our ids for ethrex's public-mempool verdicts and QuietSend reverts. */
export type RuleId =
  | "gas-limit" | "recent-root" | "prefix" | "structure" | "signature" | "simulation" | "trace-alignment"
  | "OP-061" | "execution" | "out-of-gas" | "OP-011" | "create" | "storage" | "COD-010" | "entrypoint-access"
  | "mempool" | "admission"
  | "public-storage"   // ethrex canonicalMempoolViolation: StorageReadNonSender
  | "public-gas-cap"   // ethrex: "prefix gas budget exceeded: N > 100000"
  | "nullifier-spent"  // ExitRelay VERIFY reverted: note already withdrawn
  | "unknown";

export interface RuleCheck { rule: RuleId; frameIndex?: number; entity?: EntityRole; verdict: "pass" | "fail" | "skipped"; detail?: string }

export interface MempoolVerdict {
  mempool: Mempool;
  verdict: "admitted" | "rejected";
  /** How we know. Only "model" is unverified (our local rule model, no node said so). */
  source: "send" | "simulate" | "explorer" | "model";
  failed?: { rule: RuleId; ercRule?: string; entity?: { role: EntityRole; address: Address }; frameIndex?: number };
  error?: { code: number; message: string; revertReason?: string };
  checks?: RuleCheck[];
  fix?: string;
  /** Where it failed, from the trace: frame, the contract whose code ran, and what it touched (e.g. "frame 1: 0xab… reads 0xcd… slot 0x0"). */
  where?: string;
}

export interface AdmissionReport {
  txHash?: Hex;
  verdicts: Record<Mempool, MempoolVerdict>;
  verifyGas?: bigint;
  /** Can inclusion lists (FOCIL, EIP-8369) force it into a block? They draw only on the public mempool. */
  focil?: { eligible: boolean; reason: string };
}

/** The simulator implements this; the SDK accepts any implementation as `precheck`, so sdk never imports simulator. */
export interface AdmissionChecker { check(tx: FrameTx): Promise<AdmissionReport> }

export type ReputationStatus = "ok" | "throttled" | "banned";
export type TxStatus = "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";
export interface Stake { amount: bigint; unstakeDelaySec: number; withdrawTime: bigint; isStaked: boolean }

export interface EntityStatus {
  address: Address;
  stake: Stake;
  reputation: { opsSeen: number; opsIncluded: number; status: ReputationStatus; isWhitelisted: boolean; isBlacklisted: boolean };
  /** throttled when floor(seen/10) > included + 10, banned when > included + 50. */
  headroom: { untilThrottled: number; untilBanned: number };
  pending: { hash: Hex; status: TxStatus; role: EntityRole }[];
  inclusions: { hash: Hex; block: number; verifyGas?: bigint }[];
  evictions: { hash: Hex; kind: "dropped" | "replaced" | "Cancelled"; reason?: string }[];
}

/** One discriminated union for every send failure, mapped from code + message (pinned to captured strings). */
export type AltpoolError =
  | { kind: "decode"; mempool: Mempool; message: string }                                     // -32000 "Error decoding field"
  | { kind: "signature"; message: string }                                                    // -32507
  | { kind: "ruleViolation"; mempool: Mempool; rule: RuleId; entity?: { role: EntityRole; address: Address }; message: string } // -32502
  | { kind: "validationReverted"; frameIndex: number; revertReason?: string; message: string } // -32500
  | { kind: "reputation"; status: "throttled" | "banned"; role: EntityRole; address: Address }  // -32504
  | { kind: "nonceKeyHeld"; key: bigint; pendingHash: Hex }                                     // -32602 "already held by pending transaction"
  | { kind: "replacementUnderpriced"; message: string }                                        // -32602 "cannot be replaced: fee too low"
  | { kind: "recentRoot"; message: string }                                                    // -32500 "EIP-8272 recent-root reference ..."
  | { kind: "rpc"; code: number; message: string };

/** QuietSend: what the prover hands the client. Public inputs match the pool's withdraw(). */
export interface Note { secret: bigint; nullifier: bigint; commitment: Hex; nullifierHash: Hex }
export interface WithdrawProof {
  proof: Hex;
  root: Hex;
  nullifierHash: Hex;
  recipient: Address;
  relayer: Address;
  fee: bigint;
  refund: bigint;
}
