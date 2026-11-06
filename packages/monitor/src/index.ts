// Owner: Dev C. watchEntity: one entity's stake, reputation + headroom, pending txs, inclusions (with VERIFY gas) and evictions.
// Polls the gateway (works in Node and the browser). Sources: skandha_explorer_listReputation (stake is in each item),
// skandha_explorer_listTransactions (filtered to the entity), skandha_explorer_getTransaction + eth_getTransactionReceipt
// for inclusions (cached). The explorer event stream carries no sender, so it only triggers an early poll (opts.wsUrl).
import { decodeAbiParameters, encodeFunctionData } from "viem";
import {
  DEVNET, gateway as gatewayClient,
  type Address, type EntityRole, type EntityStatus, type Hex, type ReputationStatus, type Stake, type TxStatus,
} from "@altpool/core";

export interface WatchOptions {
  onStatus: (s: EntityStatus) => void;
  onError?: (e: unknown) => void;
  /** Poll period (default 3000 ms). */
  intervalMs?: number;
  /** How many recent explorer txs to scan per poll (default 200). */
  txLimit?: number;
  gateway?: ReturnType<typeof gatewayClient>;
  /** Sidecar WebSocket URL; each explorer event triggers an immediate poll. */
  wsUrl?: string;
}

/** Sends left before throttle / ban: throttled when floor(seen/10) > included + 10, banned when > included + 50. */
export const headroom = (opsSeen: number, opsIncluded: number, r = DEVNET.reputation) => ({
  untilThrottled: Math.max(0, (opsIncluded + r.throttlingSlack + 1) * r.minInclusionDenominator - opsSeen),
  untilBanned: Math.max(0, (opsIncluded + r.banSlack + 1) * r.minInclusionDenominator - opsSeen),
});

const PENDING: TxStatus[] = ["New", "Pending", "Submitted"];
const INCLUDED: TxStatus[] = ["OnChain", "Finalized"];
const lc = (a: string) => a.toLowerCase();
const big = (v: unknown): bigint => (v === undefined || v === null || v === "" ? 0n : BigInt(v as string | number));

const depositInfoAbi = [{
  type: "function", name: "getDepositInfo", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
}] as const;

interface ExplorerTx { txHash: Hex; sender: Address; payer?: Address; status: TxStatus; lastUpdatedTime?: number }
interface Inclusion { hash: Hex; block: number; verifyGas?: bigint }

/** One snapshot of an entity. Exposed for one-shot use (frame-doctor, demo). `cache` keeps receipts between polls. */
export const entityStatus = async (
  entity: Address,
  gw = gatewayClient(),
  opts: { txLimit?: number; maxInclusions?: number; cache?: Map<string, Inclusion>; previous?: EntityStatus } = {},
): Promise<EntityStatus> => {
  const me = lc(entity);
  const cache = opts.cache ?? new Map<string, Inclusion>();

  const [rep, txs] = await Promise.all([
    gw.listReputation(1000).catch(() => ({ items: [] })),
    gw.call("skandha_explorer_listTransactions", [{ limit: opts.txLimit ?? 200 }]).catch(() => ({ items: [] })),
  ]);

  const item = (rep?.items ?? []).find((i: any) => lc(String(i.address)) === me);
  let stake: Stake;
  if (item) {
    stake = { amount: big(item.stake), unstakeDelaySec: Number(item.unstakeDelaySec ?? 0), withdrawTime: big(item.withdrawTime), isStaked: Boolean(item.isStaked) };
  } else {
    // Not in the reputation table yet (never seen): read the registry directly.
    const data = encodeFunctionData({ abi: depositInfoAbi, functionName: "getDepositInfo", args: [entity] });
    const out: Hex = await gw.call("eth_call", [{ to: DEVNET.stakingRegistry, data }, "latest"]);
    const [amount, delay, withdrawTime] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], out);
    stake = { amount, unstakeDelaySec: Number(delay), withdrawTime, isStaked: amount > DEVNET.minStakeWei && Number(delay) >= DEVNET.unstakeDelaySec && withdrawTime === 0n };
  }
  const opsSeen = Number(item?.opsSeen ?? 0);
  const opsIncluded = Number(item?.opsIncluded ?? 0);
  const reputation = {
    opsSeen, opsIncluded,
    status: (item?.status ?? "ok") as ReputationStatus,
    isWhitelisted: Boolean(item?.isWhitelisted), isBlacklisted: Boolean(item?.isBlacklisted),
  };

  const mine: (ExplorerTx & { role: EntityRole })[] = (txs?.items ?? [])
    .filter((t: ExplorerTx) => lc(t.sender) === me || (t.payer && lc(t.payer) === me))
    .map((t: ExplorerTx) => ({ ...t, role: lc(t.sender) === me ? "sender" : "payer" }));

  const pending = mine.filter((t) => PENDING.includes(t.status)).map((t) => ({ hash: t.txHash, status: t.status, role: t.role }));

  // Newest first; receipts only for the latest few (cached), fetched in parallel.
  const included = mine.filter((x) => INCLUDED.includes(x.status))
    .sort((a, b) => (b.lastUpdatedTime ?? 0) - (a.lastUpdatedTime ?? 0))
    .slice(0, opts.maxInclusions ?? 10);
  const inclusions = (await Promise.all(included.map(async (t): Promise<Inclusion | undefined> => {
    const hit = cache.get(t.txHash);
    if (hit) return hit;
    const [receipt, rec] = await Promise.all([gw.receipt(t.txHash).catch(() => undefined), gw.admission(t.txHash).catch(() => undefined)]);
    if (!receipt?.blockNumber) return undefined; // not mined yet as far as the node knows
    const frames: { mode: number | string }[] = rec?.admission?.frames ?? [];
    let n = 0;
    while (n < frames.length && Number(frames[n]!.mode) === 1) n++;
    const verifyGas = n && receipt.frameReceipts
      ? receipt.frameReceipts.slice(0, n).reduce((s: bigint, f: any) => s + big(typeof f.gasUsed === "object" ? f.gasUsed.execution : f.gasUsed), 0n)
      : undefined;
    const inc = { hash: t.txHash, block: Number(receipt.blockNumber), verifyGas };
    cache.set(t.txHash, inc);
    return inc;
  }))).filter((x): x is Inclusion => x !== undefined);
  inclusions.sort((a, b) => b.block - a.block);

  const evictions: EntityStatus["evictions"] = mine
    .filter((t) => t.status === "Cancelled" || t.status === "Reverted")
    .map((t) => (t.status === "Cancelled" ? { hash: t.txHash, kind: "Cancelled" as const } : { hash: t.txHash, kind: "dropped" as const, reason: "reverted on chain" }));
  // A tx that was pending last time and is now gone from the explorer list without a final status was dropped.
  const known = new Set(mine.map((t) => t.txHash));
  for (const p of opts.previous?.pending ?? []) if (!known.has(p.hash)) evictions.push({ hash: p.hash, kind: "dropped", reason: "left the mempool" });
  for (const e of opts.previous?.evictions ?? []) if (e.kind === "dropped" && e.reason === "left the mempool" && !evictions.some((x) => x.hash === e.hash)) evictions.push(e);

  return { address: entity, stake, reputation, headroom: headroom(opsSeen, opsIncluded), pending, inclusions, evictions };
};

const fingerprint = (s: EntityStatus) => JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v));

/** Calls onStatus with the first snapshot and then on every change. Returns an unsubscribe function. */
export const watchEntity = (entity: Address, opts: WatchOptions): (() => void) => {
  const gw = opts.gateway ?? gatewayClient();
  const cache = new Map<string, Inclusion>();
  let last: EntityStatus | undefined;
  let lastPrint = "";
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ws: WebSocket | undefined;

  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const s = await entityStatus(entity, gw, { txLimit: opts.txLimit, cache, previous: last });
      const f = fingerprint(s);
      if (f !== lastPrint) { lastPrint = f; opts.onStatus(s); }
      last = s;
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
      if (!stopped) { clearTimeout(timer); timer = setTimeout(poll, opts.intervalMs ?? 3000); }
    }
  };

  if (opts.wsUrl && typeof WebSocket !== "undefined") {
    ws = new WebSocket(opts.wsUrl);
    ws.onopen = () => ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_subscribe", params: ["explorerEvents", 0] }));
    ws.onmessage = () => { clearTimeout(timer); timer = setTimeout(poll, 250); };
    ws.onerror = (e) => opts.onError?.(e);
  }

  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
};
