// EIP-8272 recent roots, as deployed on the devnet. The predeploy is write-only (64-byte calldata: salt || root);
// the protocol checks references against its storage. Layout decoded from the devnet runtime code and checked with
// verifyRecentRootPredeploy() before use.
import type { Address, Hex } from "@altpool/core";
import { MAX_RECENT_ROOT_REFERENCES, type FrameTx, type RecentRootReference } from "@forshtat/hegota-support/tx";
import { concat, keccak256, numberToHex, type Client } from "viem";
import { getBlock, getCode, getStorageAt } from "viem/actions";
import { RecentRootExpiredError, UnsupportedCapabilityError } from "./errors";
import { assertAddress, type CheckStatus } from "./normalize";
import { predeploy, profileExtras, type Profile, type RecentRootLayout } from "./profiles";

const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

function layout(profile: Profile): RecentRootLayout {
  const l = profileExtras(profile).recentRoots;
  if (!l) throw new UnsupportedCapabilityError("recent-roots", `Profile "${profile.id}" has no verified recent-root layout.`);
  return l;
}

/** source_id = keccak256(source_address || salt): the writer's address and a 32-byte salt it chose. */
export const recentRootSourceId = (source: Address, salt: Hex): Hex => {
  assertAddress(source, "source");
  if (!isBytes32(salt)) throw new TypeError("salt must be 32 bytes");
  return keccak256(concat([source, salt]));
};

export const recentRootEntryHash = (profile: Profile, ref: RecentRootReference): Hex =>
  keccak256(concat([layout(profile).entryDomain, ref.sourceId, numberToHex(ref.slot, { size: 8 }), ref.root]));

export const recentRootStorageKey = (profile: Profile, sourceId: Hex, slot: bigint): Hex => {
  const l = layout(profile);
  return keccak256(concat([l.storageDomain, sourceId, numberToHex(slot % BigInt(l.ringLength), { size: 8 })]));
};

/** Calldata for writing a root (send it in any call to RECENT_ROOT_ADDRESS, value 0). The source is msg.sender. */
export const encodeRecentRootWrite = (salt: Hex, root: Hex): Hex => {
  if (!isBytes32(salt) || !isBytes32(root)) throw new TypeError("salt and root must be 32 bytes each");
  return concat([salt, root]);
};

/** Checks that the deployed predeploy matches the layout the SDK computes with (both domain constants present). */
export async function verifyRecentRootPredeploy(client: Client, profile: Profile): Promise<{ address: Address; ok: boolean; codeHash?: Hex }> {
  const address = predeploy(profile, "RECENT_ROOT_ADDRESS");
  const l = layout(profile);
  const code = (await getCode(client, { address })) ?? "0x";
  const ok = code.includes(l.entryDomain.slice(2)) && code.includes(l.storageDomain.slice(2)) && code.toLowerCase().includes("611fff");
  return { address, ok, codeHash: code === "0x" ? undefined : keccak256(code) };
}

/** The slot a reference is checked against: latest header's slotNumber + 1 (public-mempool rule). */
export async function getCurrentSlot(client: Client): Promise<{ currentSlot: bigint; headSlot: bigint; blockNumber: bigint }> {
  const b: any = await getBlock(client, { blockTag: "latest" });
  const head = b.slotNumber !== undefined ? BigInt(b.slotNumber) : undefined;
  if (head === undefined) throw new UnsupportedCapabilityError("slotNumber", "The execution client's blocks carry no slotNumber (EIP-7843); recent roots cannot be checked.");
  return { currentSlot: head + 1n, headSlot: head, blockNumber: b.number };
}

export interface RecentRootLookup {
  ref: RecentRootReference;
  storageKey: Hex;
  /** What the predeploy stores at the ring index. */
  stored: Hex;
  expected: Hex;
  /** The predeploy holds exactly this (source, slot, root). */
  committed: boolean;
  /** The ring index is empty. */
  empty: boolean;
}

/** Read one (source, slot) entry and compare it to `root`. */
export async function getRecentRoot(client: Client, profile: Profile, ref: RecentRootReference): Promise<RecentRootLookup> {
  if (!isBytes32(ref.sourceId) || !isBytes32(ref.root)) throw new TypeError("sourceId and root must be 32 bytes");
  const storageKey = recentRootStorageKey(profile, ref.sourceId, ref.slot);
  const stored = ((await getStorageAt(client, { address: predeploy(profile, "RECENT_ROOT_ADDRESS"), slot: storageKey })) ?? "0x") as Hex;
  const expected = recentRootEntryHash(profile, ref);
  const norm = stored === "0x" ? `0x${"0".repeat(64)}` : stored;
  return { ref, storageKey, stored: norm as Hex, expected, committed: norm.toLowerCase() === expected.toLowerCase(), empty: /^0x0*$/.test(norm) };
}

export interface RecentRootCheck { index?: number; rule: string; status: CheckStatus; message: string; age?: bigint }

/** Structural and on-chain checks for a reference list (count, slot < current, age within window, committed). */
export async function validateRecentRootReferences(client: Client, profile: Profile, refs: readonly RecentRootReference[], opts: { currentSlot?: bigint } = {}): Promise<{ ok: boolean; currentSlot: bigint; checks: RecentRootCheck[] }> {
  const l = layout(profile);
  const checks: RecentRootCheck[] = [];
  if (!profile.envelope.includes("recentRootReferences") && l.carrier === "payloadField") {
    checks.push({ rule: "recent-root-carrier", status: "fail", message: `Profile "${profile.id}" has no recentRootReferences payload field.` });
  }
  checks.push({ rule: "recent-root-count", status: refs.length <= MAX_RECENT_ROOT_REFERENCES ? "pass" : "fail", message: `${refs.length} of max ${MAX_RECENT_ROOT_REFERENCES}` });
  const currentSlot = opts.currentSlot ?? (await getCurrentSlot(client)).currentSlot;
  const pre = await verifyRecentRootPredeploy(client, profile);
  checks.push({ rule: "recent-root-predeploy", status: pre.ok ? "pass" : "fail", message: pre.ok ? `layout matches code at ${pre.address}` : `code at ${pre.address} does not match the SDK's layout` });
  await Promise.all(refs.map(async (ref, index) => {
    if (!isBytes32(ref.sourceId) || !isBytes32(ref.root)) return checks.push({ index, rule: "recent-root-shape", status: "fail", message: "sourceId and root must be 32 bytes" });
    const age = currentSlot - ref.slot;
    if (ref.slot >= currentSlot) return checks.push({ index, rule: "recent-root-slot", status: "fail", message: `slot ${ref.slot} is not before the current slot ${currentSlot}; it becomes usable at slot ${ref.slot + 1n}`, age });
    if (age > l.usableWindow) return checks.push({ index, rule: "recent-root-window", status: "fail", message: `age ${age} slots exceeds the usable window ${l.usableWindow}`, age });
    if (!pre.ok) return checks.push({ index, rule: "recent-root-committed", status: "unknown", message: "predeploy layout unverified", age });
    const r = await getRecentRoot(client, profile, ref);
    checks.push({ index, rule: "recent-root-committed", status: r.committed ? "pass" : "fail", message: r.committed ? `committed (age ${age})` : r.empty ? "nothing committed at this ring index" : "ring index holds a different (source, slot, root)", age });
  }));
  checks.sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  return { ok: !checks.some((c) => c.status !== "pass"), currentSlot, checks };
}

/** Validate refs and attach them to the tx (payload field on this profile). Throws RecentRootExpiredError on any failed check. */
export async function prepareRecentRootReferences(client: Client, profile: Profile, tx: FrameTx, refs: readonly RecentRootReference[]): Promise<FrameTx> {
  const v = await validateRecentRootReferences(client, profile, refs);
  const bad = v.checks.filter((c) => c.status !== "pass");
  if (bad.length) throw new RecentRootExpiredError(`Recent-root references rejected: ${bad.map((c) => `${c.index ?? "-"} ${c.rule}: ${c.message}`).join("; ")}`);
  if (layout(profile).carrier !== "payloadField") throw new UnsupportedCapabilityError("recent-root-verifier-frame", "Verifier-frame carriage is not implemented for this profile.");
  return { ...tx, recentRootReferences: [...refs] };
}
