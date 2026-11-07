// The entity view: an operator console. Header with live state, five KPI tiles, the VERIFY gas chart, the nodes, and the activity timeline.
import { useMemo } from "react";
import { formatEther } from "viem";
import type { Address } from "@altpool/core";
import type { EntityReport, NodeRef } from "@altpool/monitor";
import { deployments } from "@altpool/contracts";
import { addrUrl } from "../altpool";
import { Card, CardBar, cx } from "../components/ui";
import { Activity } from "./Activity";
import { ago, clockAt, DEVNET, ethDp, KNOWN, lc, nodesFor, num, type NodeChoice } from "./fmt";
import { GasChart } from "./GasChart";
import { useBlockTimes, useEntityLive, useNow, type AlertCfg } from "./hooks";
import { A, CopyButton, CountUp, ExtLink, Meter, Pulse, Skeleton, Stat, Stats, Tag, type Tone } from "./parts";

/** Each of our relays pins its own VERIFY limit; other entities get no pin line. */
const PINS: [string | undefined, bigint][] = [
  [deployments.payRelayWETH, 600_000n], // PayChecks.PAY_VERIFY_GAS_MAX
  [deployments.exitRelay, DEVNET.verifyGasMax],
  [deployments.exitRelayWETH, DEVNET.verifyGasMax],
  [deployments.exitRelayRR, DEVNET.verifyGasMax],
];
const pinOf = (a: Address) => PINS.find(([x]) => x && lc(x) === lc(a))?.[1];
const WARN_AT = 20;
const eth = (n: number, dp = 4) => `${n.toFixed(dp)} ETH`;

const NodesRow = ({ r }: { r: EntityReport }) => (
  <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-px bg-ln p-0">
    {r.nodes.map((n) => (
      <li key={n.name} className="flex min-w-0 flex-col gap-1 bg-s1 px-4 py-3 font-mono text-[12.5px]/[19px]">
        <span className="flex items-center gap-2 text-fg">{n.name} {n.ok ? <Tag tone="ok">up {n.latencyMs !== undefined && `${num(n.latencyMs)} ms`}</Tag> : <Tag tone="bad">down</Tag>}</span>
        <span className="text-fg2">{n.ok ? (n.reputation ? `counts ${num(n.reputation.opsSeen)} seen, ${num(n.reputation.opsIncluded)} included` : "has not seen this entity") : n.error}</span>
      </li>
    ))}
  </ul>
);

export const Entity = ({ addr, choice, fee, alerts }: { addr: Address; choice: NodeChoice; fee?: bigint; alerts: AlertCfg }) => {
  const known = KNOWN[lc(addr)];
  const live = useEntityLive(addr, choice, fee ?? known?.fee, alerts);
  const watched: NodeRef[] = useMemo(() => nodesFor(choice), [choice]);
  const now = useNow(1000);
  const r = live.report;
  const blockTime = useBlockTimes((r?.inclusions ?? []).map((i) => i.block));
  const pin = pinOf(addr);

  const up = r?.nodes.filter((n) => n.ok).length ?? 0;
  const rep = r?.reputation, h = r?.headroom, f = r?.funds;
  const repTone: Tone = !rep ? "muted" : rep.status === "ok" ? "ok" : rep.status === "throttled" ? "warn" : "bad";
  const throttleAt = rep ? (rep.opsIncluded + DEVNET.reputation.throttlingSlack + 1) * DEVNET.reputation.minInclusionDenominator : 1;
  const hTone: Tone = !rep ? "muted" : rep.status !== "ok" ? "bad" : h!.untilThrottled <= WARN_AT ? "warn" : "ok";
  const lowFunds = f?.txsLeft !== undefined && f.txsLeft <= 5;
  const withGas = (r?.inclusions ?? []).filter((i) => i.verifyGas !== undefined).sort((a, b) => b.block - a.block);
  const latest = withGas[0]?.verifyGas;
  const cap = Number(DEVNET.publicVerifyGasCap);
  const gasMax = Math.max(cap, Number(pin ?? 0n), Number(latest ?? 0n)) * 1.15;
  const stakeTone: Tone = !r ? "muted" : r.stake.withdrawTime ? "warn" : r.stake.isStaked ? "ok" : "bad";
  const p = live.poll;
  const pollLine = p && ` Last poll ${ago(now - p.at)} ago${p.ok ? "" : " (failed)"}, ${p.nextAt - now >= 500 ? `next in ${ago(p.nextAt - now)}` : "polling now"}.`;
  const stakeWord = r ?(r.stake.withdrawTime ? "Unlocking" : r.stake.isStaked ? "Staked" : "Unstaked") : "";

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Entity" className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="m-0 text-[clamp(22px,3vw,28px)]/[1.15] font-medium tracking-[-.025em]">{known?.label ?? "Entity"}</h2>
            {r && <Tag tone={stakeTone}>{stakeWord.toLowerCase()}</Tag>}
            {rep && <Tag tone={repTone}>reputation {rep.status}</Tag>}
            {r && up < r.nodes.length && <Tag tone="bad">{up} of {r.nodes.length} nodes up</Tag>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[12.5px] text-fg2">
            <span className="break-all">{addr}</span>
            <CopyButton text={addr} label="Copy address" />
            <ExtLink href={addrUrl(addr)} className="text-acc">explorer</ExtLink>
          </div>
        </div>
        <Pulse state={live.error ? "err" : r ? "live" : undefined} word={live.error ? "Poll failed, retrying." : r ? "Live." : "Connecting."}>
          {live.error ? <>{live.error}{pollLine}</> : r
            ? <span title="A report is emitted when anything changed; the watcher checks every 10 s and on explorer events.">Last change {ago(now - r.updatedAt)} ago ({clockAt(r.updatedAt)}).{pollLine} From {watched.map((n) => n.name).join(" + ")}, and on explorer events.</span>
            : `Reading ${watched.map((n) => n.name).join(" and ")}…`}
        </Pulse>
      </section>

      <section aria-label="Sends left" className="flex flex-col gap-1 border-y border-ln2 py-4">
        <span className="font-mono text-[12px] uppercase tracking-[.08em] text-fg2">Sends left</span>
        {h ? (
          <>
            <span className={cx("num text-[40px]/[1.1] font-medium", hTone === "ok" ? "text-okt" : hTone === "warn" ? "text-warn" : hTone === "bad" ? "text-bad" : "text-fg")}>{num(h.untilThrottled)}</span>
            <span className="text-[14px]/[22px] text-fg2">before throttling; throttle threshold is {num(throttleAt)} sends at {num(rep!.opsIncluded)} included, warns at {WARN_AT}. {num(h.untilBanned)} until banned.</span>
          </>
        ) : <Skeleton className="my-2 h-10 w-32" />}
      </section>

      <Card className="overflow-hidden">
        <Stats cols={5}>
          <Stat label="Stake" tone={stakeTone} big={r ? stakeWord : <Skeleton className="my-2 h-7 w-28" />}
            sub={r ? <><CountUp value={Number(formatEther(r.stake.amount))} format={(n) => eth(n, 3)} /> · {num(Math.round(r.stake.unstakeDelaySec / 3600))} h unstake delay</> : <Skeleton className="h-3 w-32" />} />
          <Stat label="Reputation" tone={repTone} big={rep?.status ?? <Skeleton className="my-2 h-7 w-20" />}
            sub={rep ? <>seen {num(rep.opsSeen)} · included {num(rep.opsIncluded)}{r!.nodes.some((n) => n.reputation) && <><br />{r!.nodes.filter((n) => n.reputation).map((n) => `${n.name} ${n.reputation!.opsSeen}/${n.reputation!.opsIncluded}`).join(" · ")}</>}</> : <Skeleton className="h-3 w-32" />} />
          <Stat label="Headroom" tone={hTone} big={h ? <><CountUp value={h.untilThrottled} /> <span className="text-[14px] font-normal text-fg2">sends</span></> : <Skeleton className="my-2 h-7 w-24" />}
            sub={h ? <>left before throttling; warns at {WARN_AT} · {num(h.untilBanned)} until banned{r?.throttleEta?.minutes !== undefined && <><br /><span className="text-warn">throttled in ~{num(Math.round(r.throttleEta.minutes))} min at this rate</span></>}</> : <Skeleton className="h-3 w-32" />}>
            {h && <Meter value={h.untilThrottled} max={throttleAt} tone={hTone} label="Sends left before throttling" ticks={WARN_AT < throttleAt ? [{ at: WARN_AT, label: `warn at ${WARN_AT} sends`, className: "bg-warn" }] : []} />}
          </Stat>
          <Stat label="Funds" tone={lowFunds ? "warn" : "info"} big={f ? <CountUp value={Number(formatEther(f.balance))} format={eth} /> : <Skeleton className="my-2 h-7 w-28" />}
            sub={f ? <>{f.txsLeft !== undefined ? <span className={lowFunds ? "text-warn" : ""}>{num(f.txsLeft)} txs left</span> : "no receipts yet"}{f.avgCost !== undefined && <> · ~{ethDp(f.avgCost)} per tx</>}{f.marginPerTx !== undefined && <> · margin <span className={f.marginPerTx >= 0n ? "text-ok" : "text-bad"}>{ethDp(f.marginPerTx)}</span></>}</> : <Skeleton className="h-3 w-32" />} />
          <Stat label="VERIFY gas" tone="info" big={!r ? <Skeleton className="my-2 h-7 w-24" /> : latest !== undefined ? <CountUp value={Number(latest)} /> : "n/a"}
            sub={!r ? <Skeleton className="h-3 w-32" /> : latest !== undefined
              ? <>latest · public cap {num(cap)}{pin !== undefined && <> · pin {num(pin)}</>}{Number(latest) > cap && <><br /><span className="text-warn">{(Number(latest) / cap).toFixed(1)}× the public cap, alt mempool only</span></>}</>
              : "no inclusion with a reading yet"}>
            {latest !== undefined && <Meter value={Number(latest)} max={gasMax} tone="info" label="Latest VERIFY gas against the public cap and the pin"
              ticks={[{ at: cap, label: `public cap ${num(cap)}`, className: "bg-warn" }, ...(pin !== undefined ? [{ at: Number(pin), label: `pin ${num(pin)}`, className: "bg-fg" }] : [])]} />}
          </Stat>
        </Stats>
        {r && <NodesRow r={r} />}
      </Card>

      <Card className="overflow-hidden">
        <CardBar>
          <span className="text-fg">VERIFY gas per inclusion</span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span><i className="mr-1.5 inline-block h-0.5 w-4 bg-acc align-middle" />gas used</span>
            <span className="text-warn"><i className="mr-1.5 inline-block w-4 border-t border-dashed border-warn align-middle" />public cap</span>
            {pin !== undefined && <span><i className="mr-1.5 inline-block w-4 border-t border-dashed border-fg2 align-middle" />our pin</span>}
          </span>
        </CardBar>
        <div className="px-4 pb-3 pt-6">
          {r ? <GasChart r={r} pin={pin} blockTime={blockTime} /> : <div className="flex h-[206px] flex-col justify-center gap-3"><p className="m-0 text-center text-[14px] text-fg2">{live.error ? <span className="text-bad">{live.error}</span> : "Reading inclusions and their receipts…"}</p></div>}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardBar>
          <span className="text-fg">Activity</span>
          <span className={cx(r && "text-fg2")}>{r ? "newest first · recent history, 200 txs per node" : ""}</span>
        </CardBar>
        <Activity r={r} watched={watched} events={live.events} firstSeen={live.firstSeen} now={now} blockTime={blockTime} loading={!live.error} error={live.error} />
      </Card>

      <p className="m-0 font-mono text-[12px]/[19px] text-fg2">
        Chain {DEVNET.chainId}. Reputation moves from ok to throttled to banned as sends outnumber inclusions.{" "}
        <A to={{ kind: "alerts", addr }} className="text-acc hover:underline">Set alerts for this entity</A> or see <A to={{ kind: "network" }} className="text-acc hover:underline">every entity on the network</A>.
      </p>
    </div>
  );
};
