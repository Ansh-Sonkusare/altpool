// Browser port of packages/prover/src/tree.ts (createRequire there). Rebuilds the pool's 20-level MiMCSponge tree from
// Deposit logs and checks it against the chain. ponytail: pathFor duplicates the prover package's until it ships a browser entry.
import mimcsponge from "circomlib/src/mimcsponge.js";
import { parseAbi, parseAbiItem, toHex } from "viem";
import { DEVNET, type Address, type Hex, type Note } from "@altpool/core";
import type { MerklePath } from "@altpool/prover";
import { client } from "../altpool";

const LEVELS = DEVNET.treeLevels;
const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;
export const hashLeftRight = (l: bigint, r: bigint): bigint => BigInt(String(mimcsponge.multiHash([l, r])));

export const ZEROS: bigint[] = [ZERO_VALUE];
for (let i = 0; i < LEVELS; i++) ZEROS.push(hashLeftRight(ZEROS[i]!, ZEROS[i]!));

const pathFor = (leaves: bigint[], leafIndex: number): Omit<MerklePath, "rootIdx"> => {
  const pathElements: bigint[] = [];
  const pathIndices: (0 | 1)[] = [];
  let layer = leaves;
  for (let i = 0, idx = leafIndex; i < LEVELS; i++, idx >>= 1) {
    pathIndices.push((idx & 1) as 0 | 1);
    pathElements.push(layer[idx ^ 1] ?? ZEROS[i]!);
    layer = Array.from({ length: Math.ceil(layer.length / 2) }, (_, j) => hashLeftRight(layer[2 * j]!, layer[2 * j + 1] ?? ZEROS[i]!));
  }
  return { root: toHex(layer[0]!, { size: 32 }), leafIndex, pathElements, pathIndices };
};

const POOL_ABI = parseAbi([
  "function getLastRoot() view returns (bytes32)",
  "function currentRootIndex() view returns (uint32)",
  "function roots(uint256) view returns (bytes32)",
  "function isSpent(bytes32) view returns (bool)",
]);
const DEPOSIT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");

export interface TreeCheck extends MerklePath {
  leafCount: number;
  /** The pool's getLastRoot(), equal to path.root or the check throws. */
  chainRoot: Hex;
}

const read = async (note: Note, address: Address): Promise<TreeCheck> => {
  const pool = { address, abi: POOL_ABI } as const;
  const [logs, chainRoot, rootIdx] = await Promise.all([
    client.getLogs({ address, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" }),
    client.readContract({ ...pool, functionName: "getLastRoot" }),
    client.readContract({ ...pool, functionName: "currentRootIndex" }),
  ]);
  const deposits = logs.map((l) => l.args).sort((a, b) => a.leafIndex! - b.leafIndex!);
  deposits.forEach((d, i) => { if (d.leafIndex !== i) throw new Error(`deposit logs not contiguous at ${i} (got ${d.leafIndex})`); });
  const leaves = deposits.map((d) => BigInt(d.commitment!));
  const leafIndex = leaves.indexOf(BigInt(note.commitment));
  if (leafIndex < 0) throw new Error("note not deposited yet");
  const path = pathFor(leaves, leafIndex);
  if (BigInt(path.root) !== BigInt(chainRoot)) throw new Error(`tree mismatch: local ${path.root} chain ${chainRoot}`);
  // getLastRoot() is roots[currentRootIndex]: read it back so the index we prove against is checked, not assumed.
  const atIdx = await client.readContract({ ...pool, functionName: "roots", args: [BigInt(rootIdx)] });
  if (BigInt(atIdx) !== BigInt(chainRoot)) throw new Error(`roots(${rootIdx}) is not the last root`);
  if (await client.readContract({ ...pool, functionName: "isSpent", args: [note.nullifierHash] })) throw new Error("note already spent");
  return { ...path, rootIdx: Number(rootIdx), leafCount: leaves.length, chainRoot };
};

/** Retries for ~20 s. `pool` defaults to the ETH pool; the WETH pool has the same events and reads. */
export const rebuildTree = async (note: Note, tries = 10, pool: Address = DEVNET.pool): Promise<TreeCheck> => {
  for (let i = 1; ; i++) {
    try {
      return await read(note, pool);
    } catch (e) {
      // Everything but a spent note is worth another read: the logs lag, a deposit can land mid-read, a request can drop.
      if (i >= tries || (e instanceof Error && /already spent/.test(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};
