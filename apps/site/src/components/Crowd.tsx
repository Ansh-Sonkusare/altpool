// Live view of who else is in a Tornado pool: deposits, withdrawals, and what that means for a proof's anonymity set.
// Everything is read from the chain. Withdrawals come from Withdrawal logs, from a receipt scan of recent blocks (eth_getLogs
// omits logs of frame transactions that fail at the top level, r17), and from the pool's token balance as the total.
import { useEffect, useState } from "react";
import { parseAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { DEVNET } from "@altpool/core";
import { erc20PoolAbi, wethAbi } from "@altpool/contracts";
import { client } from "../altpool";
import { Card, CardBar, Dot, cx, fmt } from "./ui";

const DEPOSIT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");
const WITHDRAWAL = parseAbiItem("event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)");
const WITHDRAWAL_TOPIC = toEventSelector(WITHDRAWAL);
const BLOCK_SEC = 6;
const POLL_MS = 6000;
const SCAN_MAX = 1500; // blocks of receipts to read per pool
const SCAN_BATCH = 100;
const DEFAULT_WINDOW = 300;

interface Dep { leaf: number; block: number; time: number }
interface Wd { block: number; nullifier: Hex }
interface Snap { head: number; deps: Dep[]; wds: Wd[]; totalW: number; scanFrom: number }

interface PoolCache { scanned: number; scanFrom: number; wds: Map<Hex, Wd>; token?: Address | null; denomination?: bigint }
const caches = new Map<Address, PoolCache>();

interface Receipt { blockNumber: string; logs?: Log[]; frameReceipts?: { logs?: Log[] }[] }
interface Log { address: string; topics: string[]; data: string }

async function rpcBatch<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
  const body = calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }));
  const res = await fetch(DEVNET.ethrexUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json()) as { id: number; result?: T; error?: { message: string } }[];
  return out.sort((a, b) => a.id - b.id).map((r) => {
    if (r.error) throw new Error(r.error.message);
    return r.result as T;
  });
}

/** Withdrawal logs of `pool` in one receipt, whichever of the receipt's log lists carries them. */
function withdrawalsIn(r: Receipt, pool: Address): Wd[] {
  const logs = r.frameReceipts?.length ? r.frameReceipts.flatMap((f) => f.logs ?? []) : (r.logs ?? []);
  return logs
    .filter((l) => l.address.toLowerCase() === pool.toLowerCase() && l.topics[0] === WITHDRAWAL_TOPIC)
    .map((l) => ({ block: Number.parseInt(r.blockNumber, 16), nullifier: `0x${l.data.slice(2 + 64, 2 + 128)}` as Hex }));
}

async function load(pool: Address, myLeafIndex?: number): Promise<Snap> {
  const cache = caches.get(pool) ?? { scanned: -1, scanFrom: -1, wds: new Map<Hex, Wd>() };
  caches.set(pool, cache);
  const [head, depLogs, wdLogs] = await Promise.all([
    client.getBlockNumber({ cacheTime: 0 }).then(Number),
    client.getLogs({ address: pool, event: DEPOSIT, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: pool, event: WITHDRAWAL, fromBlock: 0n, toBlock: "latest" }),
  ]);
  const deps: Dep[] = depLogs
    .map((l) => ({ leaf: Number(l.args.leafIndex), block: Number(l.blockNumber), time: Number(l.args.timestamp) }))
    .sort((a, b) => a.leaf - b.leaf);
  for (const l of wdLogs) cache.wds.set(l.args.nullifierHash!, { block: Number(l.blockNumber), nullifier: l.args.nullifierHash! });

  // Receipt scan: from the player's deposit block (or the last few hundred blocks) up to head, resuming where it stopped.
  const mine = myLeafIndex === undefined ? undefined : deps.find((d) => d.leaf === myLeafIndex);
  const want = Math.max(mine ? mine.block - 1 : head - DEFAULT_WINDOW, head - SCAN_MAX, 0);
  if (cache.scanned < 0 || want < cache.scanFrom) {
    cache.scanFrom = want;
    cache.scanned = want - 1;
  }
  while (cache.scanned < head) {
    const from = cache.scanned + 1;
    const to = Math.min(head, from + SCAN_BATCH - 1);
    const calls = Array.from({ length: to - from + 1 }, (_, i) => ({ method: "eth_getBlockReceipts", params: [`0x${(from + i).toString(16)}`] }));
    const blocks = await rpcBatch<Receipt[] | null>(calls);
    for (const r of blocks.flat()) if (r) for (const w of withdrawalsIn(r, pool)) cache.wds.set(w.nullifier, w);
    cache.scanned = to;
  }

  // Authoritative total: every deposit put one denomination in the pool, every withdrawal took one out.
  if (cache.token === undefined) {
    cache.denomination = await client.readContract({ address: pool, abi: erc20PoolAbi, functionName: "denomination" });
    cache.token = await client.readContract({ address: pool, abi: erc20PoolAbi, functionName: "token" }).catch(() => null);
  }
  const held = cache.token
    ? await client.readContract({ address: cache.token, abi: wethAbi, functionName: "balanceOf", args: [pool] })
    : await client.getBalance({ address: pool });
  const unspent = Number(held / cache.denomination!);
  const wds = [...cache.wds.values()].sort((a, b) => a.block - b.block);
  return { head, deps, wds, totalW: Math.max(deps.length - unspent, wds.length), scanFrom: cache.scanFrom };
}

function useCrowd(pool: Address, myLeafIndex?: number) {
  const [snap, setSnap] = useState<Snap>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    let id: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      load(pool, myLeafIndex)
        .then((s) => alive && (setSnap(s), setError(undefined)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => { if (alive) id = setTimeout(tick, POLL_MS); });
    void tick();
    return () => { alive = false; clearTimeout(id); };
  }, [pool, myLeafIndex]);
  return { snap, error };
}

const ago = (blocks: number) => {
  const s = blocks * BLOCK_SEC;
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

/** Deposits above the baseline, withdrawals below, the player's deposit ringed. */
function Timeline({ snap, mine }: { snap: Snap; mine?: Dep }) {
  const start = Math.max(0, mine ? mine.block - 12 : snap.head - DEFAULT_WINDOW);
  const span = Math.max(snap.head - start, 1);
  const x = (b: number) => 8 + ((b - start) / span) * 584;
  const deps = snap.deps.filter((d) => d.block >= start);
  const wds = snap.wds.filter((w) => w.block >= start);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <svg viewBox="0 0 600 76" className="block h-auto w-full" role="img" aria-label={`${deps.length} deposits and ${wds.length} withdrawals in the last ${ago(span)}`}>
        <line x1="8" x2="592" y1="38" y2="38" className="stroke-ln2" />
        {deps.map((d) => (
          <line key={d.leaf} x1={x(d.block)} x2={x(d.block)} y1={d.leaf === mine?.leaf ? 4 : 16} y2="34" strokeWidth={d.leaf === mine?.leaf ? 3 : 2} className={d.leaf === mine?.leaf ? "stroke-amber" : "stroke-ok"} />
        ))}
        {wds.map((w) => (
          <line key={w.nullifier} x1={x(w.block)} x2={x(w.block)} y1="42" y2="60" strokeWidth="2" className="stroke-warn" />
        ))}
        {mine && <circle cx={x(mine.block)} cy="8" r="5" fill="none" strokeWidth="1.5" className="stroke-amber" />}
      </svg>
      <figcaption className="flex justify-between font-mono text-[11px]/normal text-fg2">
        <span>{ago(span)} ago</span>
        <span>now, block {fmt(snap.head)}</span>
      </figcaption>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-[12px]/normal text-fg2">
        <span className="inline-flex items-center gap-1.5"><i className="h-3 w-0.5 bg-ok" />deposit</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-3 w-0.5 bg-warn" />withdrawal</span>
        {mine && <span className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-full border-[1.5px] border-amber" />your deposit</span>}
      </p>
    </figure>
  );
}

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "amber" }) => (
  <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-ln bg-bg px-3 py-2.5">
    <span className={cx("font-mono text-[20px]/none tabular-nums", tone === "amber" ? "text-amber" : "text-fg")}>{value}</span>
    <span className="text-[12px]/snug text-fg2">{label}</span>
  </div>
);

const Verdict = ({ title, set, children }: { title: string; set: string; children: string }) => (
  <div className="flex flex-col gap-1 border-t border-ln pt-3">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px]/snug text-fg1">{title}</span>
      <span className="flex-none font-mono text-[14px]/none text-amber tabular-nums">{set}</span>
    </div>
    <p className="m-0 text-[12px]/snug text-fg2">{children}</p>
  </div>
);

export function Crowd({ pool, myLeafIndex }: { pool: Address; myLeafIndex?: number }) {
  const { snap, error } = useCrowd(pool, myLeafIndex);
  const mine = snap && myLeafIndex !== undefined ? snap.deps.find((d) => d.leaf === myLeafIndex) : undefined;

  let body;
  if (!snap) {
    body = <p className="m-0 text-[13px] text-fg2">{error ? `Could not read the pool: ${error}` : "Reading the pool's deposits and withdrawals…"}</p>;
  } else {
    const { deps, wds, totalW, head, scanFrom } = snap;
    const inPool = deps.length - totalW;
    const hidden = totalW - wds.length;
    const since = mine ? wds.filter((w) => w.block >= mine.block).length : 0;
    const after = mine ? deps.filter((d) => d.leaf > mine.leaf).length : 0;
    // Reference deposit for the older-root row: the player's, else the fifth newest.
    const ref = mine ?? deps[Math.max(0, deps.length - 5)];
    const olderUnspent = ref ? ref.leaf + 1 - (totalW - wds.filter((w) => w.block >= ref.block).length) : 0;
    body = (
      <>
        <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-3">
          <Stat label="deposits" value={fmt(deps.length)} />
          <Stat label="withdrawals" value={fmt(totalW)} />
          <Stat label="unspent in the pool" value={fmt(inPool)} />
          {mine && <Stat label="deposits after yours" value={fmt(after)} tone="amber" />}
          {mine && <Stat label="withdrawals since yours" value={fmt(since)} tone="amber" />}
        </div>
        {myLeafIndex !== undefined && !mine && (
          <p className="m-0 text-[12px]/snug text-fg2">Leaf {myLeafIndex} is not in the pool's deposit logs yet.</p>
        )}
        <Timeline snap={snap} mine={mine} />
        {ref && (
          <div className="flex flex-col gap-3">
            <Verdict title="Prove against the latest root" set={mine && after === 0 ? "1 likely" : `${fmt(Math.max(inPool, 1))} possible`}>
              {mine
                ? `Your note and ${fmt(Math.max(inPool - 1, 0))} others are unspent inside this root. ${after === 0 ? "Its newest leaf is yours, so an observer guesses you until someone else deposits." : "Its newest leaf is not yours."}`
                : `${fmt(inPool)} unspent notes sit inside this root. Whoever pays could be any of them.`}
            </Verdict>
            <Verdict title={mine ? "Prove against the root right after your deposit" : `Prove against the root from leaf ${ref.leaf}`} set={mine ? "1 likely" : `${fmt(Math.max(olderUnspent, 1))} possible`}>
              {mine
                ? `${fmt(Math.max(olderUnspent, 1))} unspent notes are inside that root, but your leaf is its newest, so an observer who reads the root guesses you.`
                : `${fmt(Math.max(olderUnspent, 1))} unspent notes were inside that older root. An older root hides the payer among fewer notes.`}
            </Verdict>
          </div>
        )}
        <p className="m-0 text-[12px]/snug text-fg2">
          These are other accounts depositing and withdrawing during this demo, run by us. They show the mechanism, not real-world privacy.
          {hidden > 0 && ` ${fmt(hidden)} withdrawal${hidden === 1 ? "" : "s"} counted from the pool balance have no block: they failed at the top level, so eth_getLogs omits them, and they are older than block ${fmt(scanFrom)}, where the receipt scan starts.`}
          {scanFrom > 0 && hidden === 0 && ` Receipts scanned from block ${fmt(scanFrom)} to ${fmt(head)}.`}
        </p>
      </>
    );
  }

  return (
    <Card>
      <CardBar>
        <span>Crowd in this pool</span>
        <span className="inline-flex items-center gap-2"><Dot state={error ? "err" : snap ? "live" : undefined} size="sm" />{snap ? `block ${fmt(snap.head)}` : "connecting"}</span>
      </CardBar>
      <div className="flex flex-col gap-4 p-4">{body}</div>
    </Card>
  );
}
