// Side by side: one compact card per entity (?entity=a,b). Each card opens the full view.
import { useMemo } from "react";
import type { Address } from "@altpool/core";
import type { EntityReport } from "@altpool/monitor";
import { Card, cx } from "../components/ui";
import { DEVNET, ethDp, KNOWN, lc, nodesFor, num, short, type NodeChoice } from "./fmt";
import { useEntityLive } from "./hooks";
import { A, Heading, Square, TEXT, type Tone } from "./parts";

const Spark = ({ r }: { r: EntityReport }) => {
  const pts = r.inclusions.filter((i) => i.verifyGas !== undefined).sort((a, b) => a.block - b.block);
  if (pts.length < 2) return <div className="h-10 font-mono text-[12px] leading-10 text-dim">{pts.length ? `VERIFY ${num(pts[0]!.verifyGas!)}` : "no inclusions yet"}</div>;
  const max = Math.max(Number(DEVNET.verifyGasMax) * 1.12, ...pts.map((p) => Number(p.verifyGas) * 1.1));
  const y = (v: number) => 40 - (v / max) * 36;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(4 + (i * 292) / (pts.length - 1)).toFixed(1)},${y(Number(p.verifyGas)).toFixed(1)}`).join(" ");
  const cap = y(Number(DEVNET.publicVerifyGasCap));
  return (
    <svg viewBox="0 0 300 40" preserveAspectRatio="none" className="block h-10 w-full" role="img" aria-label={`VERIFY gas over the last ${pts.length} inclusions`}>
      <line x1="0" x2="300" y1={cap} y2={cap} className="stroke-warn" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" className="stroke-amber" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex justify-between gap-3 border-b border-ln py-2 last:border-b-0">
    <span className="font-mono text-[12px] text-fg2">{k}</span><span className="text-right font-mono text-[13px] tabular-nums">{children}</span>
  </div>
);

const EntityCard = ({ addr, choice, fee }: { addr: Address; choice: NodeChoice; fee?: bigint }) => {
  const known = KNOWN[lc(addr)];
  const { report: r, error } = useEntityLive(addr, choice, fee ?? known?.fee);
  const rep = r?.reputation;
  const repTone: Tone = !rep ? "muted" : rep.status === "ok" ? "ok" : rep.status === "throttled" ? "warn" : "bad";
  const up = r?.nodes.filter((n) => n.ok).length ?? 0;
  const latest = r?.inclusions[0];
  return (
    <Card className="overflow-hidden">
      <A to={{ kind: "entity", addr }} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ln px-4 py-3 hover:bg-white/[.02]">
        <span className="text-[18px] text-fg">{known?.label ?? "Entity"}</span><span className="font-mono text-[12px] text-fg2">{short(addr)} · open entity</span>
      </A>
      {!r ? (
        <p className="m-0 px-4 py-10 text-center text-[14px] text-fg2">{error ? <span className="text-bad">{error}. Retrying.</span> : "Reading the sidecars…"}</p>
      ) : (
        <>
          <div className="px-4 pt-3"><Spark r={r} /></div>
          <div className="px-4 pb-2 pt-1">
            <Row k="Stake"><Square tone={r.stake.isStaked ? "ok" : "bad"} /><span className={r.stake.isStaked ? "text-ok" : "text-bad"}>{r.stake.isStaked ? "staked" : "unstaked"}</span> {ethDp(r.stake.amount, 3)}</Row>
            <Row k="Reputation"><Square tone={repTone} /><span className={TEXT[repTone]}>{rep!.status}</span> {num(rep!.opsSeen)}/{num(rep!.opsIncluded)}</Row>
            <Row k="Headroom">{num(r.headroom.untilThrottled)} sends</Row>
            <Row k="Funds">{ethDp(r.funds.balance)}{r.funds.txsLeft !== undefined && ` · ${num(r.funds.txsLeft)} txs`}</Row>
            <Row k="Latest VERIFY">{latest?.verifyGas !== undefined ? <>{num(latest.verifyGas)} <span className="text-dim">block {num(latest.block)}</span></> : "n/a"}</Row>
            <Row k="Activity">{num(r.inclusions.length)} in · <span className={r.rejections.length ? "text-bad" : ""}>{num(r.rejections.length)} rejected</span> · <span className={cx(r.pending.some((p) => p.stuck) && "text-bad")}>{num(r.pending.length)} pending</span></Row>
            <Row k="Nodes"><span className={up === r.nodes.length ? "text-ok" : "text-bad"}>{up} of {r.nodes.length} up</span></Row>
          </div>
        </>
      )}
    </Card>
  );
};

export const Compare = ({ addrs, choice, fee }: { addrs: Address[]; choice: NodeChoice; fee?: bigint }) => {
  const names = useMemo(() => nodesFor(choice).map((n) => n.name).join(" + "), [choice]);
  return (
    <div className="flex flex-col gap-8">
      <Heading title="Compare" sub={`${addrs.length} entities · same nodes (${names}), same rules`} />
      <div className={cx("grid grid-cols-1 gap-5 min-[761px]:grid-cols-2", addrs.length >= 3 && "min-[1100px]:grid-cols-3")}>
        {addrs.map((a) => <EntityCard key={a} addr={a} choice={choice} fee={fee} />)}
      </div>
    </div>
  );
};
