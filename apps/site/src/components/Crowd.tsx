// The pool's crowd, and one run's proof. Live: pool counts and one bar per leaf come from the WETH pool's Deposit logs and
// token balance (polled); the proof facts come from the included Pledge Paid's own transaction. `mine` (the leaf this tab
// just deposited) marks the depositor's leaf. A run read off the chain cannot name it: the proof hides which leaf paid.
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { formatEther } from "viem";
import { DEVNET } from "@altpool/core";
import { addrUrl, exitUrl } from "../altpool";
import { fromOf, readPool, readProof, type Dep, type PoolView, type ProofView } from "../crowd/chain";
import { Card, CardBar, cx, Dot, ExtLink, Fact, Facts, fmt, Kvl, short } from "./ui";

const POLL_MS = 8000;
const SHOWN_CROWD = 5;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function usePool(pool: Address) {
  const [snap, setSnap] = useState<PoolView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    let id: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      readPool(pool)
        .then((s) => alive && (setSnap(s), setError(undefined)))
        .catch((e) => alive && setError(msg(e)))
        .finally(() => { if (alive) id = setTimeout(tick, POLL_MS); });
    void tick();
    return () => { alive = false; clearTimeout(id); };
  }, [pool]);
  return { snap, error };
}

function useProof(hash: Hex | undefined, pool: Address) {
  const [state, setState] = useState<{ hash: Hex; proof?: ProofView; error?: string }>();
  useEffect(() => {
    if (!hash) return;
    let alive = true;
    readProof(hash, pool).then((proof) => alive && setState({ hash, proof }), (e) => alive && setState({ hash, error: msg(e) }));
    return () => { alive = false; };
  }, [hash, pool]);
  return hash && state?.hash === hash ? state : undefined;
}

/** Accounts that sent the given deposit transactions, filled in as they are read. */
function useFroms(hashes: Hex[]) {
  const [map, setMap] = useState<Record<string, Address>>({});
  const key = hashes.join();
  useEffect(() => {
    let alive = true;
    for (const h of hashes) fromOf(h).then((a) => alive && setMap((m) => (m[h] === a ? m : { ...m, [h]: a })), () => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

type Kind = "you" | "crowd" | "in" | "after";
const BAR = { you: "bg-amber", crowd: "bg-ok", in: "bg-okt/35", after: "bg-ln2" } as const;
const WHAT = {
  you: "the depositor's leaf",
  crowd: "a crowd deposit after yours, in the proof's root",
  in: "in the proof's root",
  after: "landed after the proof's root",
} as const;

const Tx = ({ hash, label }: { hash: Hex; label: string }) => <ExtLink href={exitUrl(hash)} className="text-amber underline decoration-amberln underline-offset-4">{label}</ExtLink>;
const Addr = ({ a }: { a?: Address }) => (a ? <ExtLink href={addrUrl(a)} className="text-amber underline decoration-amberln underline-offset-4">{short(a)}</ExtLink> : <>…</>);

export function Crowd({ pool, mine, runHash }: { pool: Address; mine?: number; runHash?: Hex }) {
  const { snap, error } = usePool(pool);
  const p = useProof(runHash, pool);
  const proof = p?.proof;
  const leaves = proof?.leaves;
  const deps = snap?.deps ?? [];
  const dep = (leaf: number): Dep | undefined => deps.find((d) => d.leaf === leaf);

  // Leaves the key/value list names: the depositor's, the crowd's after it inside the root, the root's newest, the first after it.
  const crowd = leaves !== undefined && mine !== undefined ? deps.filter((d) => d.leaf > mine && d.leaf < leaves) : [];
  const named = [
    mine !== undefined ? dep(mine) : undefined,
    ...crowd.slice(0, SHOWN_CROWD),
    mine === undefined && leaves ? dep(leaves - 1) : undefined,
    leaves !== undefined ? dep(leaves) : undefined,
  ].filter((d): d is Dep => !!d);
  const froms = useFroms(named.map((d) => d.hash));

  const kind = (i: number): Kind =>
    i === mine ? "you" : leaves === undefined ? "in" : i >= leaves ? "after" : mine !== undefined && i > mine ? "crowd" : "in";

  const rows: [string, React.ReactNode][] = [];
  const depRow = (d: Dep, label: string) => rows.push([label, <>block {fmt(d.block)}, <Tx hash={d.hash} label={`deposit ${short(d.hash)}`} /> from <Addr a={froms[d.hash]} /></>]);
  const me = mine !== undefined ? dep(mine) : undefined;
  if (proof) {
    if (me) depRow(me, `depositor leaf ${me.leaf}`);
    else rows.push(["depositor leaf", "not on the chain: the proof hides which leaf paid"]);
    crowd.slice(0, SHOWN_CROWD).forEach((d) => depRow(d, `crowd leaf ${d.leaf}`));
    if (crowd.length > SHOWN_CROWD) rows.push(["more crowd leaves", `${crowd.length - SHOWN_CROWD} more after leaf ${crowd[SHOWN_CROWD - 1]!.leaf}`]);
    if (mine === undefined && leaves) { const d = dep(leaves - 1); if (d) depRow(d, `newest leaf in the root (${d.leaf})`); }
    const next = leaves !== undefined ? dep(leaves) : undefined;
    if (next) rows.push(["first leaf after the root", <>leaf {next.leaf} landed in block {fmt(next.block)}, after the root, so the proof does not cover it</>]);
    rows.push(["proof root", <><span className="break-all">{proof.root}</span><br /><span className="text-fg2">{leaves === undefined
      ? "no longer among the pool's last 30 roots, so the leaf count cannot be read back"
      : `checked against the pool (its root history, or its tree rebuilt from the Deposit logs): the root of leaves 0 to ${leaves - 1}`}</span></>]);
    rows.push(["paid in block", <>{fmt(proof.block)}{me ? `, ${fmt(proof.block - me.block)} blocks after the deposit` : ""}, <Tx hash={proof.hash} label={short(proof.hash)} /></>]);
    if (proof.invoiceId !== undefined) {
      const c = proof.created;
      rows.push([`invoice #${proof.invoiceId}`, <>
        {c ? <>created in block {fmt(c.block)} by <Addr a={c.by} /> in <Tx hash={c.hash} label={short(c.hash)} />{me ? ", not by the depositor" : ""}</> : "creation not found"}
        {proof.paidTx && <>. Paid by <Tx hash={proof.paidTx} label={short(proof.paidTx)} /></>}.</>]);
    }
  }

  const live = snap ? "live" : error ? "err" : undefined;
  return (
    <Card>
      <CardBar>
        <span>the pool's crowd, and this run's proof</span>
        <span className="inline-flex items-center gap-2">
          <Dot state={live} size="sm" />
          WETH pool · {formatEther(DEVNET.denomination)} WETH notes · {snap ? `live, block ${fmt(snap.head)}` : error ? "could not read" : "connecting"}
        </span>
      </CardBar>
      <div className="flex flex-col gap-5 p-5 max-[560px]:p-4">
        {!snap ? (
          <p className="m-0 text-[13px] text-fg2">{error ? `Could not read the pool: ${error}` : "Reading the pool's deposits…"}</p>
        ) : (
          <>
            <Facts>
              <Fact k="Deposits">{fmt(snap.deps.length)}</Fact>
              <Fact k="Withdrawals">{fmt(snap.withdrawals)}</Fact>
              <Fact k="Unspent notes">{fmt(snap.unspent)}</Fact>
              {leaves !== undefined && <Fact k="Leaves in this proof's root">{fmt(leaves)}</Fact>}
            </Facts>
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-[3px]" role="list" aria-label="Pool leaves">
                {snap.deps.map((d) => {
                  const k = kind(d.leaf);
                  const label = `leaf ${d.leaf}${k === "you" || leaves !== undefined ? `, ${WHAT[k]}` : ""}`;
                  return <i key={d.leaf} role="listitem" tabIndex={0} title={label} aria-label={label} className={cx("h-[18px] w-2.5 rounded-sm", BAR[k], k === "you" && "outline-1 outline-amber")} />;
                })}
              </div>
              <p className="m-0 text-[12.5px]/[1.6] text-fg2">
                Leaves 0 to {fmt(snap.deps.length - 1)} now.
                {mine !== undefined && <> <span className="text-amber">Amber</span> is the depositor's leaf {mine}.</>}
                {leaves !== undefined
                  ? <>{mine !== undefined && <> <span className="text-ok">Green</span> are the crowd deposits after it.</>} Dim green are the other leaves in the proof's root (0 to {leaves - 1}), grey landed after the root.</>
                  : <> Run one to mark the root it proves against.</>}
                {" "}Which leaves are spent is not marked: the pool's balance gives only the count ({fmt(snap.deps.length)} deposits minus {fmt(snap.unspent)} unspent = {fmt(snap.withdrawals)}).
              </p>
            </div>
          </>
        )}
        {runHash && !p && <p className="m-0 font-mono text-[12.5px] text-fg2">Reading the run's proof from the chain…</p>}
        {p?.error && <p className="m-0 font-mono text-[12.5px] text-bad">Could not read the run's proof: {p.error}</p>}
        {rows.length > 0 && <Kvl rows={rows} />}
        <p className="m-0 text-[13px]/[21px] text-fg2">
          The proof hides a note only among the deposits in the root it proves against. The pool keeps taking deposits, so these numbers move.
        </p>
      </div>
    </Card>
  );
}
