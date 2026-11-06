// Profile handling. The codec profile (@forshtat/hegota-support) describes the wire format; ProfileExtras holds
// the devnet facts the SDK needs on top of it. Every value here is pinned to a live check (see docs/RESEARCH.md).
import type { Profile } from "@forshtat/hegota-support/profiles";
import type { Hex } from "@altpool/core";
import { UnsupportedCapabilityError } from "./errors";

export type { Profile };

export interface RecentRootLayout {
  /** Ring buffer length per source (`slot mod ringLength` is the ring index). */
  ringLength: number;
  /** References are valid for ages 1..usableWindow slots. */
  usableWindow: bigint;
  /** keccak256(entryDomain || source_id || uint64_be(slot) || root) is the stored value. */
  entryDomain: Hex;
  /** keccak256(storageDomain || source_id || uint64_be(slot mod ringLength)) is the storage key. */
  storageDomain: Hex;
  /** How the tx carries references: the early 8272 payload field, or a VERIFY frame to RECENT_ROOT_ADDRESS. */
  carrier: "payloadField" | "verifierFrame";
}

export interface ProfileExtras {
  /** Inclusive bounds on `nonceKeys.length`. */
  nonceKeyCount: { min: number; max: number };
  /** On this profile `nonceKeys: [0n]` selects the sender's account nonce (eth_getTransactionCount). */
  zeroKeyIsAccountNonce: boolean;
  /** The sidecar estimator rewrites body-frame limits to this before checking signatures. */
  estimatorPlaceholderLimit: bigint;
  /** Replacement needs both fees bumped by at least this percent. */
  replacementBumpPercent: bigint;
  recentRoots?: RecentRootLayout;
}

const EXTRAS: Record<string, ProfileExtras> = {
  "ethrex-eip8141-tracer": {
    // live: `nonceKeys: []` -> -32602 "nonceKeys count must be between 1 and 16"
    nonceKeyCount: { min: 1, max: 16 },
    // hegota-support newTx docs + admitted txs with nonceKeys ["0x0"] and nonce == account nonce
    zeroKeyIsAccountNonce: true,
    // sidecar executor eth.ts:408-423; live probe signed at 10e6/10e6 estimates, any other limit gives -32507
    estimatorPlaceholderLimit: 10_000_000n,
    // fixtures local/r6-nonces 08 (+9% rejected) and 09 (+10% admitted)
    replacementBumpPercent: 10n,
    // decoded from the runtime code at 0x...8272 on chain 1337
    recentRoots: {
      ringLength: 8192,
      usableWindow: 8191n,
      entryDomain: "0x8f42481679c8e6fefa040974b3c905e0ce3f2e464ba93acdb074a41181617efc",
      storageDomain: "0xbdc897da2177d260ff5f4be5d4b2aad43f89c3347a305b584fa5a2546d053daa",
      carrier: "payloadField",
    },
  },
};

/** Throws unless `profile` looks like a hegota-support profile. There is no default profile. */
export function assertProfile(profile: unknown): asserts profile is Profile {
  const p = profile as Partial<Profile> | undefined;
  if (!p || typeof p.id !== "string" || !Array.isArray(p.envelope) || typeof p.frameModes !== "object") {
    throw new UnsupportedCapabilityError("profile", "Pass an explicit hegota-support profile, e.g. `import { profile } from \"@forshtat/hegota-support/profiles/ethrex-eip8141-tracer\"`.");
  }
}

/** SDK-side facts for a profile. Throws UnsupportedCapabilityError for a profile the SDK has not been checked against. */
export function profileExtras(profile: Profile): ProfileExtras {
  const x = EXTRAS[profile.id];
  if (!x) throw new UnsupportedCapabilityError(`profile:${profile.id}`, `Altpool has no verified devnet facts for profile "${profile.id}". Known: ${Object.keys(EXTRAS).join(", ")}.`);
  return x;
}

export const supportedProfileIds = (): string[] => Object.keys(EXTRAS);

export function predeploy(profile: Profile, name: "NONCE_MANAGER" | "RECENT_ROOT_ADDRESS"): Hex {
  const a = profile.predeploys[name];
  if (!a) throw new UnsupportedCapabilityError(name, `Profile "${profile.id}" does not know the ${name} predeploy address.`);
  return a;
}

export const modeName = (profile: Profile, mode: number): string =>
  Object.entries(profile.frameModes).find(([, v]) => v === mode)?.[0] ?? `MODE_${mode}`;

export const scopeName = (profile: Profile, flags: number): string =>
  Object.entries(profile.approveScopes).find(([, v]) => v === (flags & 0x3))?.[0] ?? `SCOPE_${flags & 0x3}`;
