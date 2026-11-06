// The paste-a-hash view: one tx's path across the sidecars, its frames and gas, and why it failed.
import { useEffect, useState } from "react";
import { diagnoseAdmission } from "@altpool/simulator/rules";
import type { Hex } from "@altpool/core";
import type { TxNodeView, TxReport } from "@altpool/monitor";
import { PAY_RELAY } from "../live";
import { readFrameTx, type FrameTxView } from "../frames";
import { Card, CardBar } from "../components/ui";
import { FrameLegend } from "../components/frames/Legend";
import { FramePlayer } from "../components/frames/PledgeFrames";
import { ago, clockAt, DEVNET, EXPIRY_VERIFIER, ethDp, explorerUrl, KNOWN, lc, nodesFor, num, short, type NodeChoice } from "./fmt";
import { useBlockTimes, useEntityLive, useNow, useTxLive } from "./hooks";
import { CopyButton, Empty, EntityLink, ExtLink, Heading, Pulse, Skeleton, Stat, Stats, Table, Tag, Td, TxLink, Why, type Tone } from "./parts";

const MODE: Record<number, string> = { 0: "DEFAULT", 1: "VERIFY", 2: "SENDER" };
const STATUS_TONE: Record<string, Tone> = { OnChain: "ok", Finalized: "ok", New: "info", Pending: "info", Submitted: "info", Cancelled: "bad", Reverted: "bad" };
const EVENT_TEXT: Record<Tone, string> = { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-fg", muted: "text-fg2" };

const frameRole = (r: TxReport, i: number) => {
  const f = r.frames[i]!;
  if (f.target && lc(f.target) === EXPIRY_VERIFIER) return "deadline (expiry verifier)";
  if (f.mode === 1) {
    const who = f.target ?? r.sender;
    const label = who ? KNOWN[lc(who)]?.label : undefined;
    const scope = f.flags & 3;
    return `${label ?? "entity"} validation${scope === 3 ? ", approves execution + payment" : scope === 1 ? ", approves payment" : scope === 2 ? ", approves execution" : ""}`;
  }
  return f.mode === 2 ? "the call the tx exists for" : "";
};

/** One row per node: how it got the tx, then each lifecycle event, timed from the first node to see it. */
const PathRow = ({ r, n }: { r: TxReport; n: TxNodeView }) => {
  const t0 = r.firstSeen?.at ?? n.receivedAt ?? 0;
  const rel = (at: number) => `+${((at - t0) / 1000).toFixed(1)}s`;
  const row = (body: React.ReactNode) => (
    <li className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-b border-ln px-4 py-3 last:border-b-0 max-[480px]:grid-cols-1">
      <span className="font-mono text-[13px] font-semibold text-fg">{n.name}</span>{body}
    </li>
  );
  if (!n.ok) return row(<span><Tag tone="bad">unreachable</Tag> <span className="font-mono text-[12.5px] text-fg2">{n.error}</span></span>);
  if (!n.known) return row(<span><Tag off>never reached this node</Tag></span>);
  return row(
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[12.5px]">
      {n.source === "rpc" ? <Tag tone="info">sent here</Tag> : n.source?.startsWith("gossip") ? <Tag tone="info" title={n.source}>gossip</Tag> : n.source ? <Tag tone="info">{n.source}</Tag> : null}
      {n.receivedAt !== undefined && <span className="text-dim">{clockAt(n.receivedAt)} ({rel(n.receivedAt)})</span>}
      {n.events.map((e, i) => {
        const tone: Tone = e.kind === "included" ? "ok" : e.kind === "rejected" || e.kind === "dropped" ? "bad" : e.kind === "replaced" ? "warn" : "info";
        return <span key={i} className="whitespace-nowrap"><span className={EVENT_TEXT[tone]}>{e.kind}</span>{e.status && e.kind !== "included" && <span className="text-fg2"> {e.status}</span>} <span className="text-dim">{rel(e.at)}</span></span>;
      })}
      {n.outcome && !n.events.length && <span>{n.outcome}</span>}
    </div>,
  );
};

/** The nine frames of a Pledge Paid (or any frame tx) as the site's rail, read from the chain once the tx is mined. Falls back to a table while it is not. */
const Frames = ({ r }: { r: TxReport }) => {
  const mined = !!r.receipt;
  const [v, setV] = useState<{ view?: FrameTxView; error?: string }>({});
  useEffect(() => {
    if (!mined) { setV({}); return; }
    let alive = true;
    readFrameTx(r.hash).then((view) => alive && setV({ view }), (e) => alive && setV({ error: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, [r.hash, mined]);
  const pledge = v.view?.frames.length === 9;
  return (
    <Card className="overflow-hidden">
      <CardBar><span className="text-fg">{pledge ? "Pledge Paid, 9 frames" : `Frames · ${r.frames.length}`}</span><span>{r.prefixCount} validation</span></CardBar>
      {v.view ? (
        <div className="flex flex-col gap-5 p-4">
          <FramePlayer rows={v.view.frames} />
          <details className="group">
            <summary className="min-h-9 w-fit cursor-pointer list-none rounded-md font-mono text-[12.5px] text-amber focus-visible:outline-2">What the chips mean</summary>
            <div className="pt-4"><FrameLegend /></div>
          </details>
        </div>
      ) : (
        <>
          {mined && !v.error && <p className="m-0 border-b border-ln p-4 font-mono text-[12.5px] text-fg2">Reading the receipt to draw the frames…</p>}
          {v.error && <p className="m-0 border-b border-ln p-4 font-mono text-[12.5px] text-fg2">Could not decode the frames from the chain ({v.error}). Showing the raw list.</p>}
          {!mined && <p className="m-0 border-b border-ln p-4 text-[13px]/[20px] text-fg2">Not mined yet. The rail with per-frame results appears once the tx is in a block.</p>}
          <FrameTable r={r} />
        </>
      )}
    </Card>
  );
};

const FrameTable = ({ r }: { r: TxReport }) => (
  <Table head={["#", "Mode", "Target", "Limit", "Used", "Status"]} right={[3, 4]}>
    {r.frames.map((f) => {
      const out = r.receipt?.frames[f.index];
      return (
        <tr key={f.index}>
          <Td>{f.index}</Td>
          <Td>{MODE[f.mode] ?? f.mode}<div className="font-sans text-[12px] text-fg2">{frameRole(r, f.index)}</div></Td>
          <Td>{f.target ? (lc(f.target) === EXPIRY_VERIFIER ? <span className="text-fg2">0x…8141</span> : <EntityLink addr={f.target} />) : <span className="text-fg2">sender</span>}</Td>
          <Td right>{num(f.executionLimit)}{f.stateLimit > 0n && <div className="text-[12px] text-fg2">+ {num(f.stateLimit)} state</div>}</Td>
          <Td right>{out ? <>{num(out.gasUsed)}{out.stateGasUsed > 0n && <div className="text-[12px] text-fg2">+ {num(out.stateGasUsed)} state</div>}</> : "n/a"}</Td>
          <Td>{out ? <Tag tone={out.status === "ok" ? "ok" : "bad"}>{out.status === "ok" ? "ok" : "failed"}</Tag> : <span className="text-fg2">n/a</span>}</Td>
        </tr>
      );
    })}
  </Table>
);

const Report = ({ r, choice }: { r: TxReport; choice: NodeChoice }) => {
  const watched = nodesFor(choice);
  const rejectedOn = r.nodes.filter((n) => n.outcome === "rejected");
  // A tx refused at admission never gets a mempool status: call it what it is.
  const st = r.status ?? (rejectedOn.length ? "Rejected" : undefined);
  const tone: Tone = st === "Rejected" ? "bad" : st ? STATUS_TONE[st] ?? "muted" : "muted";
  const failedCheck = rejectedOn[0]?.checks.find((c) => c.verdict === "fail");
  const diag = rejectedOn.length ? diagnoseAdmission({ outcome: "rejected", checks: rejectedOn[0]!.checks }) : undefined;
  const knownOn = r.nodes.filter((n) => n.known).map((n) => n.name);
  const verifyLimit = r.frames.slice(0, r.prefixCount).reduce((s, f) => s + f.executionLimit, 0n);
  const over = r.verifyGas !== undefined && r.verifyGas > DEVNET.publicVerifyGasCap;
  const checks = r.nodes.find((n) => n.checks.length)?.checks ?? [];
  const key = r.nonceKeys?.find((k) => k !== 0n);

  if (!knownOn.length && !r.receipt)
    return <Card><Empty>Neither {watched.map((n) => n.name).join(" nor ")} nor the chain knows this hash. Explorers keep recent history only. For a tx you have not sent yet, run frame-doctor on the raw tx.</Empty></Card>;

  return (
    <>
      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Summary</span><ExtLink href={explorerUrl(r.hash, knownOn)} className="text-amber">explorer</ExtLink></CardBar>
        <Stats cols={4}>
          <Stat label="Status" tone={tone} big={st ?? "unknown"} sub={r.receipt ? `block ${num(r.receipt.block)}` : rejectedOn.length ? `rejected on ${rejectedOn.map((n) => n.name).join(" + ")}` : "not mined"} />
          <Stat label="VERIFY gas" tone={over ? "warn" : "info"} big={r.verifyGas !== undefined ? num(r.verifyGas) : "n/a"}
            sub={<>limit {num(verifyLimit)} · public cap {num(DEVNET.publicVerifyGasCap)}{over && <><br /><span className="text-warn">over the public cap: alt mempool only</span></>}</>} />
          <Stat label="Cost" tone="info" big={r.receipt?.cost !== undefined ? ethDp(r.receipt.cost, 5) : "n/a"} sub={r.receipt ? `${num(r.receipt.gasUsed)} gas` : ""} />
          <Stat label="Sender" tone="info" big={r.sender ? <span className="text-[22px]"><EntityLink addr={r.sender} /></span> : "n/a"}
            sub={[r.payer && r.sender && lc(r.payer) !== lc(r.sender) ? <>paid by <EntityLink addr={r.payer} /></> : r.payer ? "pays for itself" : "",
              key !== undefined ? `nonce key ${short("0x" + key.toString(16))}` : r.nonce !== undefined ? `nonce ${num(r.nonce)}` : ""].filter(Boolean).map((x, i) => <span key={i}>{i > 0 && " · "}{x}</span>)} />
        </Stats>
      </Card>

      {rejectedOn.length > 0 && (
        <Card className="overflow-hidden border-bad/40">
          <CardBar><span className="text-bad">Rejected on {rejectedOn.map((n) => n.name).join(" + ")}</span><span>{rejectedOn[0]!.errorCode !== undefined ? `code ${rejectedOn[0]!.errorCode}` : ""}</span></CardBar>
          <div className="p-4"><Why d={diag} detail={failedCheck?.detail ?? ""} fallback={failedCheck?.rule ?? "rejected"} /></div>
        </Card>
      )}

      {r.frames.length > 0 && <Frames r={r} />}

      <Card className="overflow-hidden">
        <CardBar><span className="text-fg">Path across nodes</span><span className="text-amber">{r.lag.length ? r.lag.map((l) => `${l.node} +${(l.ms / 1000).toFixed(1)}s`).join(" · ") : r.firstSeen ? `first seen on ${r.firstSeen.node}` : ""}</span></CardBar>
        <ul className="m-0 list-none p-0">{r.nodes.map((n) => <PathRow key={n.name} r={r} n={n} />)}</ul>
      </Card>

      {checks.length > 0 && (
        <Card className="overflow-hidden">
          <CardBar><span>Admission checks</span><span>{checks.filter((c) => c.verdict === "pass").length} pass · {checks.filter((c) => c.verdict === "fail").length} fail · {checks.filter((c) => c.verdict === "skipped").length} skipped</span></CardBar>
          <div className="flex flex-wrap gap-1.5 p-4">
            {checks.map((c, i) => (
              <Tag key={i} tone={c.verdict === "pass" ? "ok" : c.verdict === "fail" ? "bad" : "muted"} off={c.verdict === "skipped"} title={c.detail ?? c.verdict}>
                {c.verdict} {c.rule}{c.frameIndex !== undefined ? ` #${c.frameIndex}` : ""}
              </Tag>
            ))}
          </div>
        </Card>
      )}
      <p className="m-0 font-mono text-[12px] text-fg2">updated {clockAt(r.updatedAt)}{r.firstSeen && ` · first seen ${ago(r.updatedAt - r.firstSeen.at)} ago`}</p>
    </>
  );
};

const Recent = ({ choice }: { choice: NodeChoice }) => {
  const { report: r, error } = useEntityLive(PAY_RELAY, choice, undefined);
  const list = (r?.inclusions ?? []).slice(0, 8);
  const times = useBlockTimes(list.map((i) => i.block));
  const now = useNow(5000);
  return (
    <Card className="overflow-hidden">
      <CardBar><span className="text-fg">Latest inclusions through PayRelayWETH</span><span>open one to see its frames</span></CardBar>
      {!r ? (
        <div className="flex flex-col gap-3 p-4"><p className="m-0 text-[14px] text-fg2">{error ? <span className="text-bad">{error}</span> : "Reading PayRelayWETH's recent inclusions…"}</p><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
      ) : !list.length ? <Empty>PayRelayWETH has no inclusions in the explorers' recent history. Send a Pledge Paid on the home page, or paste a hash above.</Empty> : (
        <ul className="m-0 list-none p-0">
          {list.map((i) => (
            <li key={i.hash} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-ln px-4 py-3 last:border-b-0">
              <TxLink hash={i.hash} />
              <span className="font-mono text-[12.5px] text-fg2">block {num(i.block)}{times(i.block) && <> · {ago(now - times(i.block)!)} ago</>}{i.verifyGas !== undefined && <> · VERIFY {num(i.verifyGas)}</>}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

export const Tx = ({ hash, choice }: { hash?: Hex; choice: NodeChoice }) => {
  if (!hash) return (
    <div className="flex flex-col gap-6">
      <Heading title="Transaction" sub="follow one transaction across the gateway and the miner's sidecar" />
      <p className="m-0 max-w-[62ch] text-[14px]/[22px] text-fg2">Paste a transaction hash in the box above. The view follows it every 3 s until it is mined, cancelled or rejected, draws its frames, and shows how long each sidecar took to hear about it.</p>
      <Recent choice={choice} />
    </div>
  );
  return <TxFollow hash={hash} choice={choice} />;
};

const TxFollow = ({ hash, choice }: { hash: Hex; choice: NodeChoice }) => {
  const t = useTxLive(hash, choice);
  return (
    <div className="flex flex-col gap-6">
      <Heading title="Transaction" sub={<span className="flex flex-wrap items-center gap-2"><span className="break-all">{hash}</span><CopyButton text={hash} label="Copy hash" /><ExtLink href={explorerUrl(hash)} className="text-amber">explorer</ExtLink></span>}
        aside={<Pulse state={t.error ? "err" : t.value && !t.final ? "live" : undefined} word={t.error ? "Lookup failed, retrying." : !t.value ? "Reading." : t.final ? "Final." : "Following."}>
          {t.error ?? (!t.value ? "Asking the nodes for this hash…" : t.final ? `Checked ${clockAt(t.at!)}; it will not change.` : `Checked ${clockAt(t.at!)}; again in 3 s.`)}
        </Pulse>} />
      {t.value ? <Report r={t.value} choice={choice} /> : <Card><Empty>{t.error ? <span className="text-bad">{t.error}</span> : `Reading ${short(hash)} from ${nodesFor(choice).map((n) => n.name).join(" and ")}…`}</Empty></Card>}
    </div>
  );
};
