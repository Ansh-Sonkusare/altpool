// The crowd a note hides in, read live from a pool: every deposit (all Deposit logs, never a query by commitment),
// the withdrawals since a block, and the unspent notes. Withdrawals are counted from block receipts, not eth_getLogs:
// this ethrex leaves the logs of a frame transaction whose top-level status is 0 out of getLogs (r17 audit).
import { parseAbi, parseAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { DEVNET, type Note } from "@altpool/core";
import { WETH9, wethAbi } from "@altpool/contracts";
import { client } from "../altpool";

const DEPOSIT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");
const WITHDRAWAL = toEventSelector("Withdrawal(address,bytes32,address,uint256)");
const POOL_ABI = parseAbi(["function isSpent(bytes32) view returns (bool)"]);
const BATCH = 50;

export interface Deposit { commitment: Hex; leafIndex: number; block: bigint }

/** Every deposit in leaf order. Throws when the logs skip a leaf (they lag, or a request dropped). */
export const readDeposits = async (pool: Address): Promise<Deposit[]> => {
  const logs = await client.getLogs({ address: pool, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" });
  const deps = logs.map((l) => ({ commitment: l.args.commitment!, leafIndex: l.args.leafIndex!, block: l.blockNumber })).sort((a, b) => a.leafIndex - b.leafIndex);
  deps.forEach((d, i) => { if (d.leafIndex !== i) throw new Error(`deposit logs not contiguous at ${i} (got ${d.leafIndex})`); });
  return deps;
};

type Log = { address: string; topics: string[] };
type Receipt = { logs: Log[]; frameReceipts?: { logs: Log[] }[] };
/** Withdrawals per block, by `${pool}:${block}`. A block never changes once read, so each is fetched once per page. */
const perBlock = new Map<string, number>();

const countIn = (pool: Address, r: Receipt) =>
  (r.frameReceipts ? r.frameReceipts.flatMap((f) => f.logs) : r.logs)
    .filter((l) => l.address.toLowerCase() === pool.toLowerCase() && l.topics[0] === WITHDRAWAL).length;

/** Withdrawals from `pool` in the blocks after `block`, from eth_getBlockReceipts in JSON-RPC batches of 50.
 *  ponytail: one receipt read per block, cached; a note days old costs a few hundred batches on first look. */
export const withdrawalsAfter = async (pool: Address, block: bigint): Promise<number> => {
  const latest = await client.getBlockNumber();
  const todo: bigint[] = [];
  for (let b = block + 1n; b <= latest; b++) if (!perBlock.has(`${pool}:${b}`)) todo.push(b);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const res = await fetch(DEVNET.ethrexUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chunk.map((b, id) => ({ jsonrpc: "2.0", id, method: "eth_getBlockReceipts", params: [`0x${b.toString(16)}`] }))),
    });
    const body = (await res.json()) as { id: number; result?: Receipt[] | null; error?: { message: string } }[];
    for (const r of body) {
      if (!r.result) throw new Error(`eth_getBlockReceipts ${chunk[r.id]}: ${r.error?.message ?? "no result"}`);
      perBlock.set(`${pool}:${chunk[r.id]}`, r.result.reduce((t, rc) => t + countIn(pool, rc), 0));
    }
  }
  let total = 0;
  for (let b = block + 1n; b <= latest; b++) total += perBlock.get(`${pool}:${b}`) ?? 0;
  return total;
};

export interface Crowd {
  leafIndex: number;
  depositBlock: bigint;
  /** Deposits in the pool now. */
  leaves: number;
  /** Deposits that landed after this note's. */
  after: number;
  /** Withdrawals in the blocks after this note's deposit, failed frame transactions included. */
  withdrawals: number;
  /** Notes not yet withdrawn, from the pool's WETH balance over the denomination. */
  unspent: number;
  spent: boolean;
}

/** The WETH pool's crowd around one note. Throws when the note has no deposit in the pool. */
export const crowdOf = async (note: Note, pool: Address): Promise<Crowd> => {
  const [deps, bal, spent] = await Promise.all([
    readDeposits(pool),
    client.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [pool] }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "isSpent", args: [note.nullifierHash] }),
  ]);
  const mine = deps.find((d) => BigInt(d.commitment) === BigInt(note.commitment));
  if (!mine) throw new Error("this note has no deposit in the WETH pool");
  return {
    leafIndex: mine.leafIndex,
    depositBlock: mine.block,
    leaves: deps.length,
    after: deps.length - 1 - mine.leafIndex,
    withdrawals: await withdrawalsAfter(pool, mine.block),
    unspent: Number(bal / DEVNET.denomination),
    spent,
  };
};
