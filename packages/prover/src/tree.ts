// Rebuild the pool's 20-level MiMCSponge tree from Deposit events (Tornado MerkleTreeWithHistory insert algorithm).
import { createRequire } from "node:module";
import { createPublicClient, http, parseAbi, parseAbiItem, toHex } from "viem";
import { DEVNET, altDevnet, type Hex, type Note } from "@altpool/core";

const { mimcsponge } = createRequire(import.meta.url)("circomlib");

export interface MerklePath {
  root: Hex;
  rootIdx: number;
  leafIndex: number;
  pathElements: bigint[];
  pathIndices: (0 | 1)[];
}

const LEVELS = DEVNET.treeLevels;
const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;
export const hashLeftRight = (l: bigint, r: bigint): bigint => BigInt(mimcsponge.multiHash([l, r]));

/** zeros[i] = root of an empty subtree of height i; zeros[LEVELS] is the empty-tree root. */
export const ZEROS: bigint[] = [ZERO_VALUE];
for (let i = 0; i < LEVELS; i++) ZEROS.push(hashLeftRight(ZEROS[i], ZEROS[i]));

/** Path for leaves[leafIndex] in a tree holding exactly `leaves` (left-packed, zero-filled). */
export const pathFor = (leaves: bigint[], leafIndex: number): Omit<MerklePath, "rootIdx"> => {
  if (leafIndex < 0 || leafIndex >= leaves.length) throw new Error(`leaf ${leafIndex} out of range`);
  const pathElements: bigint[] = [];
  const pathIndices: (0 | 1)[] = [];
  let layer = leaves;
  for (let i = 0, idx = leafIndex; i < LEVELS; i++, idx >>= 1) {
    pathIndices.push((idx & 1) as 0 | 1);
    pathElements.push(layer[idx ^ 1] ?? ZEROS[i]);
    layer = Array.from({ length: Math.ceil(layer.length / 2) }, (_, j) => hashLeftRight(layer[2 * j], layer[2 * j + 1] ?? ZEROS[i]));
  }
  return { root: toHex(layer[0], { size: 32 }), leafIndex, pathElements, pathIndices };
};

const POOL_ABI = parseAbi([
  "function getLastRoot() view returns (bytes32)",
  "function roots(uint256) view returns (bytes32)",
  "function isSpent(bytes32) view returns (bool)",
]);
const DEPOSIT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");

/** Rebuild the on-chain tree, check it matches getLastRoot(), and return the note's path plus the root's history index. */
export const rootFor = async (note: Note): Promise<MerklePath> => {
  const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const pool = { address: DEVNET.pool, abi: POOL_ABI } as const;
  const [logs, chainRoot] = await Promise.all([
    client.getLogs({ address: DEVNET.pool, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" }),
    client.readContract({ ...pool, functionName: "getLastRoot" }),
  ]);
  const deposits = logs.map((l) => l.args).sort((a, b) => a.leafIndex! - b.leafIndex!);
  deposits.forEach((d, i) => { if (d.leafIndex !== i) throw new Error(`deposit logs not contiguous at ${i} (got ${d.leafIndex})`); });
  const leaves = deposits.map((d) => BigInt(d.commitment!));

  const local = leaves.length ? pathFor(leaves, 0).root : toHex(ZEROS[LEVELS], { size: 32 });
  if (BigInt(local) !== BigInt(chainRoot)) throw new Error(`tree mismatch: local ${local} chain ${chainRoot}`);

  const leafIndex = leaves.indexOf(BigInt(note.commitment));
  if (leafIndex < 0) throw new Error("note not deposited");
  const roots = await Promise.all(
    Array.from({ length: DEVNET.rootHistorySize }, (_, i) => client.readContract({ ...pool, functionName: "roots", args: [BigInt(i)] })),
  );
  const rootIdx = roots.findIndex((r) => BigInt(r) === BigInt(chainRoot));
  if (rootIdx < 0) throw new Error(`root ${chainRoot} not in roots(0..${DEVNET.rootHistorySize - 1})`);
  if (await client.readContract({ ...pool, functionName: "isSpent", args: [note.nullifierHash] })) throw new Error("note already spent");
  return { ...pathFor(leaves, leafIndex), rootIdx };
};
