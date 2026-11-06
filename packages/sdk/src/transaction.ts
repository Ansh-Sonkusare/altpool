// Transaction helpers around the hegota-support codec. No RLP or hashing here: encodeTx / sigHash / txHash / signTx
// all come from the codec. This file only arranges frames, gas and signatures.
import type { Hex } from "@altpool/core";
import { encodeTx, sigHash, signTx, txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { modeName, profileExtras, scopeName, type Profile } from "./profiles";
import type { FrameGasEstimate } from "./normalize";

export {
  approveScope, decodeTx, encodeRecentRootData, encodeTx, frame, frameMode, newTx, secp256k1Placeholder, sigHash, sigScheme, signTx, txHash,
  MAX_RECENT_ROOT_REFERENCES, type FeeParams, type Frame, type FrameInit, type FrameTx, type RecentRootReference, type SignatureEntry, type TxInit,
} from "@forshtat/hegota-support/tx";
export { toWire, explainRejection } from "@forshtat/hegota-support/rpc";

/**
 * Something that can sign a 32-byte digest with secp256k1.
 * - `{ privateKey }`: delegates to hegota-support `signTx`.
 * - a viem LocalAccount (anything with `sign({ hash })`): raw-digest signing, re-packed as `v || r || s`.
 * - `{ signFrame }`: fills signature entry `index` itself (e.g. `typedDataSigner` for a BridgeAccount, whose entry
 *   holds an EIP-712 signature checked by the account's own VERIFY code).
 * Note: `signMessage` (EIP-191) is NOT a raw-digest signature and will not verify.
 */
export type FrameSigner =
  | { privateKey: Hex }
  | { sign: (args: { hash: Hex }) => Promise<Hex> }
  | { signFrame: (args: { profile: Profile; tx: FrameTx; index: number }) => Promise<FrameTx> };

/** Number of leading frames that form the validation prefix: everything up to and including the last VERIFY frame. */
export function validationPrefixLength(profile: Profile, tx: Pick<FrameTx, "frames">): number {
  const verify = profile.frameModes.VERIFY;
  let last = -1;
  tx.frames.forEach((f, i) => { if (f.mode === verify) last = i; });
  return last + 1;
}

export async function signFrameTransaction(profile: Profile, tx: FrameTx, signer: FrameSigner, index = 0): Promise<FrameTx> {
  if ("privateKey" in signer) return signTx(profile, tx, signer.privateKey, index);
  if ("signFrame" in signer) return signer.signFrame({ profile, tx, index });
  if (!tx.signatures[index]) throw new Error(`The transaction has no signature entry ${index}`);
  const sig = await signer.sign({ hash: sigHash(profile, tx) });
  // viem serializes r || s || v with v = 27/28 (or 0/1); the codec stores v || r || s with v = 0/1.
  const body = sig.slice(2);
  if (body.length !== 130) throw new Error(`Expected a 65-byte signature, got ${body.length / 2} bytes`);
  const v = parseInt(body.slice(128, 130), 16);
  const yParity = v >= 27 ? v - 27 : v;
  if (yParity !== 0 && yParity !== 1) throw new Error(`Bad recovery id ${v}`);
  const packed = `0x${yParity.toString(16).padStart(2, "0")}${body.slice(0, 128)}` as Hex;
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === index ? { ...s, signature: packed } : s)) };
}

/**
 * The tx the sidecar's estimator actually checks: body-frame limits replaced by its placeholder. The estimator does
 * this rewrite itself before verifying signatures, so a signature only verifies if it was made over these limits.
 * WARNING: once signed this probe is a valid transaction (same calls, larger limits). Only send it to an estimator
 * you trust, and spend the nonce with the real tx right after.
 */
export function estimationProbe(profile: Profile, tx: FrameTx): FrameTx {
  const n = validationPrefixLength(profile, tx);
  const p = profileExtras(profile).estimatorPlaceholderLimit;
  return { ...tx, frames: tx.frames.map((f, i) => (i < n ? f : { ...f, limits: { execution: p, state: p } })) };
}

/**
 * `allowShrink: false` (default) never lowers a declared limit: the sidecar estimator under-reports body frames
 * (live: a value transfer creating an account measured 3,000 exec / 0 state but needed >16,000 exec plus state gas).
 */
export interface GasMargin { percent: bigint; min: bigint; allowShrink?: boolean }
export const DEFAULT_MARGIN: GasMargin = { percent: 20n, min: 10_000n, allowShrink: false };
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const pad = (v: bigint, m: GasMargin) => (v === 0n ? 0n : v + (v * m.percent / 100n > m.min ? v * m.percent / 100n : m.min));

export interface FrameGasRow {
  index: number;
  mode: string;
  inPrefix: boolean;
  declared: { execution: bigint; state: bigint };
  /** What the node measured. For prefix frames this is informational: the node keeps the declared limits. */
  measured: { execution: bigint; state: bigint };
  /** Limits to use. Prefix frames keep `declared`; body frames get max(declared, measured + margin) unless allowShrink. */
  suggested: { execution: bigint; state: bigint };
  /** false for prefix frames: their limits are not auto-estimated. */
  autoEstimated: boolean;
  /** For prefix frames, declared minus measured execution gas (negative means the declared limit is too low). */
  headroom?: bigint;
}

export interface FrameGasReport {
  frames: FrameGasRow[];
  cumulativeGasUsed: bigint;
  /** Fees the estimator suggested. */
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  margin: GasMargin;
  /** Sum of suggested limits. */
  totalLimit: bigint;
  estimate: FrameGasEstimate;
}

export function gasReport(profile: Profile, tx: FrameTx, est: FrameGasEstimate, margin: GasMargin = DEFAULT_MARGIN): FrameGasReport {
  const n = validationPrefixLength(profile, tx);
  const frames = tx.frames.map((f, index): FrameGasRow => {
    const measured = est.frames[index] ?? { execution: 0n, state: 0n };
    const inPrefix = index < n;
    const padded = { execution: pad(measured.execution, margin), state: pad(measured.state, margin) };
    const suggested = inPrefix ? f.limits : margin.allowShrink ? padded : { execution: max(f.limits.execution, padded.execution), state: max(f.limits.state, padded.state) };
    return {
      index, mode: modeName(profile, f.mode), inPrefix, declared: f.limits, measured, suggested, autoEstimated: !inPrefix,
      headroom: inPrefix ? f.limits.execution - measured.execution : undefined,
    };
  });
  return {
    frames,
    cumulativeGasUsed: est.cumulativeGasUsed,
    fees: { maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas },
    margin,
    totalLimit: frames.reduce((s, f) => s + f.suggested.execution + f.suggested.state, 0n),
    estimate: est,
  };
}

/** Apply suggested body-frame limits from a report. Does not touch fees or signatures (re-sign afterwards). */
export const applyGasReport = (tx: FrameTx, report: FrameGasReport): FrameTx => ({
  ...tx,
  frames: tx.frames.map((f, i) => ({ ...f, limits: report.frames[i]?.suggested ?? f.limits })),
});

/** Replacement fees: both fees bumped by the profile's minimum (10% on this devnet), rounded up. */
export function replacementFees(profile: Profile, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  const pct = 100n + profileExtras(profile).replacementBumpPercent;
  const up = (v: bigint) => (v * pct + 99n) / 100n;
  return { maxFeePerGas: up(fees.maxFeePerGas), maxPriorityFeePerGas: up(fees.maxPriorityFeePerGas) };
}

/** Upper bound on what the payer can be charged: sum of all limits times maxFeePerGas. */
export const maxGasCost = (tx: FrameTx): bigint =>
  tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n) * tx.fees.maxFeePerGas;

/** A human-readable view of the frames (for CLIs, monitors and UIs). */
export function describeFrames(profile: Profile, tx: FrameTx) {
  const n = validationPrefixLength(profile, tx);
  return tx.frames.map((f, index) => ({
    index,
    mode: modeName(profile, f.mode),
    scope: f.mode === profile.frameModes.VERIFY ? scopeName(profile, f.flags) : undefined,
    flags: Object.entries(profile.flagBits).filter(([, bit]) => (f.flags & bit) !== 0).map(([k]) => k),
    target: f.target ?? "sender",
    value: f.value,
    limits: f.limits,
    dataBytes: (f.data.length - 2) / 2,
    inPrefix: index < n,
  }));
}

export const frameTxHash = (profile: Profile, tx: FrameTx): Hex => txHash(profile, tx);
export const encodeFrameTx = (profile: Profile, tx: FrameTx): Hex => encodeTx(profile, tx);
