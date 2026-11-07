// What the crowd-and-proof card reads from the chain: the pool's deposits, and one included Pledge Paid's proof facts.
// Nothing is hard-coded: leaf counts, roots, invoices and addresses all come from logs, storage or the transaction itself.
import { deployments, erc20PoolAbi, invoiceBookAbi, settlerFactoryAbi, wethAbi } from "@altpool/contracts";
import { decodeFunctionData, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { client } from "../altpool";

const DEPOSIT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");
const BOOK = deployments.invoiceBook as Address;
/** Tornado keeps the last 30 roots; roots(i) is the root after the deposit that moved currentRootIndex to i. */
const ROOT_HISTORY = 30;
const poolAbi = parseAbi([
  "function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable",
  "function roots(uint256) view returns (bytes32)",
  "function currentRootIndex() view returns (uint32)",
  "function nextIndex() view returns (uint32)",
]);

export interface Dep { leaf: number; block: number; hash: Hex }
export interface PoolView { head: number; deps: Dep[]; withdrawals: number; unspent: number }

let denomination: { token: Address | null; amount: bigint } | undefined;

export async function readPool(pool: Address): Promise<PoolView> {
  denomination ??= {
    amount: await client.readContract({ address: pool, abi: erc20PoolAbi, functionName: "denomination" }),
    token: await client.readContract({ address: pool, abi: erc20PoolAbi, functionName: "token" }).catch(() => null),
  };
  const [head, logs, held] = await Promise.all([
    client.getBlockNumber({ cacheTime: 0 }).then(Number),
    client.getLogs({ address: pool, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" }),
    denomination.token
      ? client.readContract({ address: denomination.token, abi: wethAbi, functionName: "balanceOf", args: [pool] })
      : client.getBalance({ address: pool }),
  ]);
  const deps = logs.map((l) => ({ leaf: Number(l.args.leafIndex), block: Number(l.blockNumber), hash: l.transactionHash })).sort((a, b) => a.leaf - b.leaf);
  // Every deposit put one denomination in, every withdrawal took one out: the balance gives the count, not which leaves.
  const unspent = Number(held / denomination.amount);
  return { head, deps, unspent, withdrawals: Math.max(deps.length - unspent, 0) };
}

const froms = new Map<Hex, Address>();
/** The account that sent a transaction, cached. */
export async function fromOf(hash: Hex): Promise<Address> {
  const hit = froms.get(hash);
  if (hit) return hit;
  const from = (await client.getTransaction({ hash })).from;
  froms.set(hash, from);
  return from;
}

/** The leaf count whose Merkle root equals `root`: insert the pool's commitments one at a time and compare after each. */
async function leavesForRoot(root: Hex, pool: Address): Promise<number | undefined> {
  const [{ hashLeftRight, ZEROS }, logs] = await Promise.all([
    import("../liveExit/tree"),
    client.getLogs({ address: pool, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const leaves = logs.sort((a, b) => Number(a.args.leafIndex) - Number(b.args.leafIndex)).map((l) => BigInt(l.args.commitment!));
  const filled = ZEROS.slice();
  const want = BigInt(root);
  for (let n = 0; n < leaves.length; n++) {
    let cur = leaves[n]!;
    for (let i = 0, idx = n; i < ZEROS.length - 1; i++, idx >>= 1) {
      if (idx % 2 === 0) { filled[i] = cur; cur = hashLeftRight(cur, ZEROS[i]!); } else cur = hashLeftRight(filled[i]!, cur);
    }
    if (cur === want) return n + 1;
  }
  return undefined;
}

export interface ProofView {
  hash: Hex;
  block: number;
  root: Hex;
  /** Leaves the root covers (0 to leaves-1), or undefined once the root has left the pool's 30-root history. */
  leaves?: number;
  settler: Address;
  invoiceId?: bigint;
  created?: { block: number; hash: Hex; by: Address };
  paidTx?: Hex;
}

interface WireTx { frames?: { data: Hex }[] }

export async function readProof(hash: Hex, pool: Address): Promise<ProofView> {
  const [tx, receipt] = await Promise.all([
    (client as unknown as { request(a: { method: string; params: unknown[] }): Promise<WireTx | null> }).request({ method: "eth_getTransactionByHash", params: [hash] }),
    client.altpool.getFrameTransactionReceipt({ hash }),
  ]);
  if (!tx?.frames || !receipt?.blockNumber) throw new Error(`${hash} is not an included frame transaction on this devnet`);
  let withdraw: readonly [Hex, Hex, Hex, Address] | undefined;
  let invoiceId: bigint | undefined;
  for (const f of tx.frames) {
    try {
      const d = decodeFunctionData({ abi: poolAbi, data: f.data });
      if (d.functionName === "withdraw") { const a = d.args as readonly unknown[]; withdraw = [a[0] as Hex, a[1] as Hex, a[2] as Hex, a[3] as Address]; }
    } catch { /* not the withdraw frame */ }
    try {
      const d = decodeFunctionData({ abi: settlerFactoryAbi, data: f.data });
      if (d.functionName === "deploy") invoiceId = (d.args[0] as { invoiceId: bigint }).invoiceId;
    } catch { /* not the deploy frame */ }
  }
  if (!withdraw) throw new Error("no pool withdraw frame in that transaction");
  const [, root, , settler] = withdraw;

  const [next, cur, ring] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "nextIndex" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "currentRootIndex" }),
    Promise.all(Array.from({ length: ROOT_HISTORY }, (_, i) => client.readContract({ address: pool, abi: poolAbi, functionName: "roots", args: [BigInt(i)] }))),
  ]);
  const i = ring.findIndex((r) => BigInt(r) === BigInt(root));
  // Inside the 30-root history the ring gives the leaf count; older roots are found by rebuilding the tree leaf by leaf.
  const leaves = i < 0 ? await leavesForRoot(root, pool) : Number(next) - ((Number(cur) - i + ROOT_HISTORY) % ROOT_HISTORY);

  let created: ProofView["created"];
  let paidTx: Hex | undefined;
  if (invoiceId !== undefined) {
    const [c, p] = await Promise.all([
      client.getLogs({ address: BOOK, event: invoiceBookAbi.find((x) => x.type === "event" && x.name === "Created")!, args: { id: invoiceId }, fromBlock: 0n, toBlock: "latest" }),
      client.getLogs({ address: BOOK, event: invoiceBookAbi.find((x) => x.type === "event" && x.name === "Paid")!, args: { id: invoiceId }, fromBlock: 0n, toBlock: "latest" }),
    ]);
    if (c[0]) created = { block: Number(c[0].blockNumber), hash: c[0].transactionHash, by: await fromOf(c[0].transactionHash) };
    paidTx = p[0]?.transactionHash;
  }
  return { hash, block: Number(receipt.blockNumber), root, leaves, settler, invoiceId, created, paidTx };
}
