// EIP-8250 keyed nonces. Reads go straight to the NONCE_MANAGER predeploy's storage (its code is `revert`, so there is
// no call interface). There is deliberately no global nonce manager: the SDK reads chain + node state and hands you
// a key set; coordinating concurrent senders is the caller's job.
import type { Address, Hex } from "@altpool/core";
import { concat, keccak256, numberToHex, pad, type BlockTag, type Client } from "viem";
import { getStorageAt, getTransactionCount } from "viem/actions";
import { NonceConflictError } from "./errors";
import { assertAddress, type CheckStatus, type MempoolEntry, type Page } from "./normalize";
import { predeploy, profileExtras, type Profile } from "./profiles";

export const MAX_NONCE_SEQ = 2n ** 64n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** keccak256(left_pad_32(sender) || uint256_be(key)): the NONCE_MANAGER storage slot of (sender, key). */
export const nonceSlot = (sender: Address, key: bigint): Hex => keccak256(concat([pad(sender, { size: 32 }), numberToHex(key, { size: 32 })]));

export interface KeyedNonce {
  sender: Address;
  key: bigint;
  /** The nonceSeq the next tx on this key must carry. */
  seq: bigint;
  /** Never used before (first use pays extra gas at APPROVE). */
  fresh: boolean;
  /** Consumed as a single-use key (stored MAX_NONCE_SEQ). */
  exhausted: boolean;
  source: "accountNonce" | "nonceManager";
}

/** Current sequence for one key. On this profile key 0 is the account nonce (eth_getTransactionCount). */
export async function getKeyedNonce(client: Client, profile: Profile, args: { sender: Address; key: bigint; blockTag?: BlockTag }): Promise<KeyedNonce> {
  assertAddress(args.sender, "sender");
  if (args.key < 0n || args.key > MAX_UINT256) throw new NonceConflictError(`Nonce key ${args.key} is not a uint256.`);
  if (args.key === 0n && profileExtras(profile).zeroKeyIsAccountNonce) {
    const n = BigInt(await getTransactionCount(client, { address: args.sender, blockTag: args.blockTag ?? "latest" }));
    return { sender: args.sender, key: 0n, seq: n, fresh: n === 0n, exhausted: false, source: "accountNonce" };
  }
  const raw = await getStorageAt(client, { address: predeploy(profile, "NONCE_MANAGER"), slot: nonceSlot(args.sender, args.key), blockTag: args.blockTag ?? "latest" });
  const stored = raw ? BigInt(raw) : 0n;
  return { sender: args.sender, key: args.key, seq: stored === MAX_NONCE_SEQ ? MAX_NONCE_SEQ : stored, fresh: stored === 0n, exhausted: stored === MAX_NONCE_SEQ, source: "nonceManager" };
}

export interface NonceSequence {
  keys: KeyedNonce[];
  /** The shared nonceSeq, when every key agrees (one seq covers all selected keys). */
  nonceSeq?: bigint;
  consistent: boolean;
}

/** Sequences for a key set. A multi-key tx needs every key at the same seq. */
export async function getNonceSequence(client: Client, profile: Profile, args: { sender: Address; keys: bigint[]; blockTag?: BlockTag }): Promise<NonceSequence> {
  const keys = await Promise.all(args.keys.map((key) => getKeyedNonce(client, profile, { sender: args.sender, key, blockTag: args.blockTag })));
  const seqs = new Set(keys.map((k) => k.seq));
  const consistent = seqs.size === 1 && !keys.some((k) => k.exhausted);
  return { keys, consistent, nonceSeq: consistent ? keys[0]!.seq : undefined };
}

export interface NonceCheck { rule: string; status: CheckStatus; message: string }

/** Local structural checks for a nonceKeys list (no RPC). */
export function validateNonceKeys(profile: Profile, keys: readonly bigint[]): NonceCheck[] {
  const x = profileExtras(profile);
  const out: NonceCheck[] = [];
  const count = keys.length >= x.nonceKeyCount.min && keys.length <= x.nonceKeyCount.max;
  out.push({ rule: "nonce-key-count", status: count ? "pass" : "fail", message: `${keys.length} keys; this devnet needs ${x.nonceKeyCount.min}-${x.nonceKeyCount.max}` });
  const range = keys.every((k) => k >= 0n && k <= MAX_UINT256);
  out.push({ rule: "nonce-key-range", status: range ? "pass" : "fail", message: range ? "all keys are uint256" : "a key is outside uint256" });
  const increasing = keys.every((k, i) => i === 0 || k > keys[i - 1]!);
  out.push({ rule: "nonce-key-order", status: increasing ? "pass" : "fail", message: increasing ? "strictly increasing" : "keys must be strictly increasing (EIP-8250), which also forbids duplicates" });
  if (keys.includes(0n) && keys.length > 1) {
    out.push({ rule: "nonce-key-zero-mixed", status: "unknown", message: "key 0 is this devnet's account nonce; mixing it with other keys is untested" });
  }
  return out;
}

/** A random 192-bit key: collision-free in practice without any shared state. */
export function randomNonceKey(): bigint {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  return BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`) || 1n;
}

export interface PendingLookup { listTransactions(q: { cursor?: string; limit?: number }): Promise<Page<MempoolEntry>> }

export interface PreparedNonceKeys {
  nonceKeys: bigint[];
  nonceSeq: bigint;
  sequence: NonceSequence;
  /** Pending txs on this node from the same sender sharing a key (node-local view). */
  conflicts: { hash: Hex; keys: bigint[]; nonceSeq: bigint; status: string }[];
  checks: NonceCheck[];
}

/**
 * Pick (or check) a key set for `sender`: sorts it, validates it, reads the shared seq and looks for pending txs on
 * the sidecar that hold any of the keys. With no `keys`, picks one fresh random key.
 * Throws NonceConflictError on an inconsistent seq; returns conflicts so the caller decides (replace or re-key).
 */
export async function prepareNonceKeys(client: Client, profile: Profile, args: { sender: Address; keys?: bigint[]; pending?: PendingLookup; maxPendingPages?: number }): Promise<PreparedNonceKeys> {
  const nonceKeys = [...(args.keys ?? [randomNonceKey()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const checks = validateNonceKeys(profile, nonceKeys);
  const bad = checks.find((c) => c.status === "fail");
  if (bad) throw new NonceConflictError(`Invalid nonce keys: ${bad.message}`);
  const sequence = await getNonceSequence(client, profile, { sender: args.sender, keys: nonceKeys });
  if (!sequence.consistent) {
    throw new NonceConflictError(`Keys are at different sequences (${sequence.keys.map((k) => `${k.key}:${k.seq}`).join(", ")}); one nonceSeq must match all of them.`);
  }
  const conflicts: PreparedNonceKeys["conflicts"] = [];
  if (args.pending) {
    let cursor: string | undefined;
    for (let page = 0; page < (args.maxPendingPages ?? 4); page++) {
      const r = await args.pending.listTransactions({ cursor, limit: 200 });
      for (const e of r.items) {
        if (e.sender.toLowerCase() !== args.sender.toLowerCase()) continue;
        if (!["New", "Pending", "Submitted"].includes(e.status)) continue;
        const shared = e.nonceKeys.filter((k) => nonceKeys.includes(k));
        if (shared.length) conflicts.push({ hash: e.hash, keys: shared, nonceSeq: e.nonceSeq, status: e.status });
      }
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
  }
  checks.push({
    rule: "nonce-key-pending",
    status: args.pending ? (conflicts.length ? "fail" : "pass") : "unknown",
    message: args.pending ? (conflicts.length ? `held by ${conflicts.map((c) => c.hash).join(", ")}` : "no pending tx on this node holds these keys") : "pending txs not checked",
  });
  return { nonceKeys, nonceSeq: sequence.nonceSeq!, sequence, conflicts, checks };
}
