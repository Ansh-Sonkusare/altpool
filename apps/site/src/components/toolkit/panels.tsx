import { useEffect, useState } from "react";
import type { MempoolVerdict } from "@altpool/core";
import { DEVNET } from "@altpool/core";
import type { EntityReport } from "@altpool/monitor";
import { decodeTx } from "@forshtat/hegota-support/tx";
import type { Hex } from "viem";
import { addrUrl, client, exitUrl, profile } from "../../altpool";
import { PAY_RELAY, runRawTx, type DoctorResult, type Live } from "../../live";
import { Card, CardBar, clock, cx, Dot, dotFor, eth, ExtLink, fmt, Pill, short, valueOf } from "../ui";
import { StepDot } from "./Pipeline";
import { useCheck, type Async, type FeedEvent, type Pipeline, type Stage } from "./usePipeline";

const Hash = ({ h }: { h: string }) => <ExtLink href={exitUrl(h)} className="font-mono text-amber">{short(h)}</ExtLink>;
const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="m-0 p-5 text-[14px]/[22px] text-fg2">{children} <a href="#pledge" className="text-amber">Send one</a>.</p>
);

// ---------------------------------------------------------------- SDK

const useLife = (hash: Hex | undefined) => {
  const [s, setS] = useState<{ hash?: Hex; status?: string; block?: bigint; ok?: number; total?: number; gas?: bigint; at?: Date }>({});
  useEffect(() => {
    if (!hash) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const [st, rc] = await Promise.all([
        client.altpool.getTransactionStatus({ hash }).catch(() => null),
        client.altpool.getFrameTransactionReceipt({ hash }).catch(() => null),
      ]);
      if (!alive) return;
      setS({ hash, status: st?.status, block: rc?.blockNumber, ok: rc?.frames.filter((f) => f.status === "success").length, total: rc?.frames.length, gas: rc?.gasUsed, at: new Date() });
      if (!rc?.blockNumber) t = setTimeout(tick, 3000);
    };
    void tick();
    return () => { alive = false; clearTimeout(t); };
  }, [hash]);
  return s.hash === hash ? s : {};
};

export const SdkPanel = ({ p }: { p: Pipeline }) => {
  const t = p.target;
  const life = useLife(t?.hash);
  if (!t) return <Empty>No run yet.</Empty>;
  let built = t.origin === "chain" ? "sent earlier; the sidecar holds its frames" : "waiting for the sender";
  if (t.raw) {
    try { built = `${decodeTx(profile, t.raw).frames.length} frames, ${(t.raw.length - 2) / 2} bytes`; } catch { built = "built, could not decode"; }
  }
  const v = p.check.status === "done" ? p.check.value.view : undefined;
  const verdict = (m?: MempoolVerdict) => (m ? `${m.mempool} ${m.verdict}` : undefined);
  const rows: { name: string; call: string; stage: Stage; text: React.ReactNode }[] = [
    { name: "Built", call: "newTx() + frame()", stage: t.raw || t.origin === "chain" ? "done" : "running", text: built },
    {
      name: "Simulated", call: "preflightFrameTransaction",
      stage: p.check.status === "done" ? "done" : p.check.status === "error" ? "failed" : "running",
      text: v ? [verdict(v.public), verdict(v.alt)].filter(Boolean).join(", ") || "no verdicts" : p.check.status === "error" ? p.check.error : "asking the node",
    },
    { name: "Submitted", call: "sendFrameTransaction", stage: t.hash ? "done" : "idle", text: t.hash ? <Hash h={t.hash} /> : "not sent yet" },
    { name: "Status", call: "getTransactionStatus", stage: !t.hash ? "idle" : life.status === "OnChain" || life.status === "Finalized" ? "done" : life.status === "Reverted" || life.status === "Cancelled" ? "failed" : "running", text: life.status ?? (t.hash ? "asking the sidecar" : "—") },
    {
      name: "Receipt", call: "waitForFrameTransactionReceipt", stage: !t.hash ? "idle" : life.block ? ((life.ok ?? 0) === life.total ? "done" : "failed") : "running",
      text: life.block ? `block ${fmt(life.block)}, ${life.ok} of ${life.total} frames succeeded${life.gas ? `, ${fmt(life.gas)} gas` : ""}` : t.hash ? "not in a block yet" : "—",
    },
  ];
  return (
    <div>
      <CardBar><span>{t.origin === "yours" ? "your run" : "newest on chain"}</span><span>{life.at ? `polled ${clock(life.at)}` : "live"}</span></CardBar>
      <ol className="m-0 flex list-none flex-col p-0">
        {rows.map((r) => (
          <li key={r.name} className="grid grid-cols-[20px_1fr] gap-x-3 border-b border-ln px-4 py-3 last:border-b-0">
            <StepDot stage={r.stage} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2"><span className="text-[14px] text-fg">{r.name}</span><span className="font-mono text-[11.5px] text-kw">{r.call}</span></span>
              <span className="break-words font-mono text-[12.5px]/[19px] text-fg1">{r.text}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-between gap-3 border-t border-ln px-4 py-3 text-[13px] text-fg2">
        <span>{t.origin === "yours" ? "Each row fills as the sidecar reports it." : "Showing the newest run the entity report lists."}</span>
        <a href="#pledge" className="font-mono text-amber">Send one</a>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- checkAdmission

const VerdictCell = ({ v, label, note }: { v?: MempoolVerdict; label: string; note?: string }) => {
  const ok = v?.verdict === "admitted";
  const checks = v?.checks ?? [];
  return (
    <div className={cx("flex min-w-0 flex-col gap-2 p-4 [overflow-wrap:anywhere]", v && !ok && "bg-bad/5")}>
      <span className="font-mono text-[12px] text-fg2">{label}</span>
      {v ? (
        <>
          <span className={cx("font-serif text-[34px]/[1.1]", ok ? "text-ok" : "text-bad")}>{ok ? "Admitted" : "Rejected"}</span>
          <span><Pill kind={v.source === "model" ? "u" : "v"}>{v.source === "model" ? "local model, unverified" : v.source === "simulate" ? "node simulation" : v.source === "explorer" ? "sidecar record" : "sent"}</Pill></span>
          {v.failed && <span className="font-mono text-[12.5px]/[19px] text-fg1">{v.failed.rule}{v.failed.ercRule ? ` (${v.failed.ercRule})` : ""}{v.failed.frameIndex !== undefined ? `, frame ${v.failed.frameIndex}` : ""}</span>}
          {(v.error?.revertReason || v.error?.message) && !ok && <span className="break-words font-mono text-[12px]/[18px] text-fg2">{v.error.revertReason ? `reverted: ${v.error.revertReason}` : v.error.message}</span>}
          {v.fix && <span className="text-[13px]/[20px] text-warn">Fix: {v.fix}</span>}
          {checks.filter((c) => c.verdict === "warn").map((w, i) => <span key={i} className="text-[13px]/[20px] text-warn">Warning: {w.detail}</span>)}
          {checks.length > 0 && <span className="font-mono text-[11.5px] text-fg2">{checks.filter((c) => c.verdict === "pass").length} checks pass, {checks.filter((c) => c.verdict === "fail").length} fail</span>}
        </>
      ) : <span className="text-[13px]/[20px] text-fg2">{note ?? "not checked"}</span>}
    </div>
  );
};

export const AdmissionPanel = ({ p }: { p: Pipeline }) => {
  const [custom, setCustom] = useState("");
  const [fresh, setFresh] = useState<string>();
  const freshCheck = useCheck(fresh && `raw:${fresh}`, () => runRawTx(fresh as Hex));
  const bad = custom.trim() !== "" && !/^0x(?:[0-9a-fA-F]{2})+$/.test(custom.trim());
  const useFresh = fresh !== undefined;
  const state: Async<DoctorResult> = useFresh ? freshCheck : p.check;
  const gap = useFresh ? undefined : p.gap;
  const view = state.status === "done" ? state.value.view : undefined;
  return (
    <div>
      <CardBar>
        <span>{useFresh ? "your pasted input" : p.target ? (p.target.origin === "yours" ? "your run" : "newest on chain") : "no run"}</span>
        <span>{state.status === "running" ? "checking…" : view ? "checkAdmission, live" : ""}</span>
      </CardBar>
      {state.status === "error" ? <p className="m-0 p-4 font-mono text-[13px] text-bad">{state.error}</p>
        : !useFresh && !p.target ? <Empty>No run to check yet.</Empty>
        : state.status !== "done" ? <p className="m-0 p-4 font-mono text-[13px] text-fg2">Asking ethrex and the local rule model…</p>
        : (
          <div className="grid grid-cols-2 divide-x divide-ln max-[560px]:grid-cols-1 max-[560px]:divide-x-0 max-[560px]:divide-y">
            <VerdictCell v={view?.public} label="Public mempool" note={view?.notes.public} />
            <VerdictCell v={view?.alt} label="Alt mempool" note={view?.notes.alt} />
          </div>
        )}
      {gap && (
        <div className="flex flex-col gap-2 border-t border-ln bg-warnbg px-4 py-3 text-[13.5px]/[21px]">
          <span className="text-fg">
            {p.target?.expectRevert ? "This preset is built to revert. " : ""}The alt model admits it, but the node simulation reverts{gap.frame !== undefined ? ` at frame ${gap.frame}` : ""}: <span className="font-mono text-[12.5px] text-fg1">{gap.why}</span>
          </span>
          <a href="#doctor" className="font-mono text-[12px] text-amber">Explain in frame-doctor</a>
        </div>
      )}
      {!gap && view?.alt?.verdict === "rejected" && <div className="border-t border-ln px-4 py-3"><a href="#doctor" className="font-mono text-[12px] text-amber">Explain in frame-doctor</a></div>}
      <form
        className="flex flex-col gap-2 border-t border-ln px-4 py-3"
        onSubmit={(e) => { e.preventDefault(); if (custom.trim() && !bad) setFresh(custom.trim()); }}
      >
        <label htmlFor="raw-in" className="text-[13px] text-fg2">Or check a raw frame transaction of your own</label>
        <div className="flex gap-2 max-[560px]:flex-col">
          <input id="raw-in" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0x…" spellCheck={false} aria-invalid={bad}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-ln2 bg-bg px-3 font-mono text-[12.5px] text-fg placeholder:text-dim" />
          <button type="submit" disabled={!custom.trim() || bad} className="min-h-11 rounded-lg border border-amberln px-4 font-mono text-[12.5px] text-amber disabled:opacity-40">Check</button>
          {useFresh && <button type="button" onClick={() => { setFresh(undefined); setCustom(""); }} className="min-h-11 rounded-lg border border-ln2 px-4 font-mono text-[12.5px] text-fg1">Back to the run</button>}
        </div>
        {bad && <span className="font-mono text-[12px] text-bad">Paste even-length hex that starts with 0x.</span>}
      </form>
    </div>
  );
};

// ---------------------------------------------------------------- watchEntity

const KIND: Record<FeedEvent["kind"], { label: string; tone: string }> = {
  inclusion: { label: "new inclusion", tone: "text-ok" },
  eviction: { label: "eviction", tone: "text-warn" },
  rejection: { label: "rejection", tone: "text-bad" },
  pending: { label: "pending", tone: "text-fg1" },
};

/** A compact summary. The full dashboard, alerts and the other views live on the monitor page. */
export const WatchPanel = ({ entity, p }: { entity: Live<EntityReport>; p: Pipeline }) => {
  const s = valueOf(entity);
  const mine = p.target?.hash?.toLowerCase();
  const r = DEVNET.reputation;
  const span = s ? (s.reputation.opsIncluded + r.throttlingSlack + 1) * r.minInclusionDenominator : 0;
  const left = s ? Math.min(1, s.headroom.untilThrottled / span) : 0;
  const at = entity.status === "live" ? clock(entity.at) : undefined;
  return (
    <div>
      <CardBar>
        <span className="text-fg">PayRelayWETH <ExtLink href={addrUrl(PAY_RELAY)} className="text-fg2">{short(PAY_RELAY)}</ExtLink></span>
        <span className="flex items-center gap-2"><Dot state={dotFor(entity)} /><span>{at ? `polling every 5 s, last change ${at}` : entity.status === "error" ? `poll failed, retrying` : "connecting…"}</span></span>
      </CardBar>
      <div className="grid grid-cols-3 border-b border-ln max-[720px]:grid-cols-1 max-[720px]:divide-y max-[720px]:divide-ln min-[721px]:divide-x min-[721px]:divide-ln">
        <div className="flex flex-col gap-1 p-4"><span className="font-mono text-[12px] text-fg2">Stake</span>
          <span className="text-[26px]/[1.2] font-light tabular-nums">{s ? (s.stake.isStaked ? eth(s.stake.amount) : "unstaked") : "—"}</span>
          <span className="font-mono text-[11.5px] text-fg2">{s ? `${s.stake.unstakeDelaySec / 3600} h unstake delay` : ""}</span></div>
        <div className="flex flex-col gap-1 p-4"><span className="font-mono text-[12px] text-fg2">Reputation</span>
          <span className={cx("text-[26px]/[1.2] font-light", s?.reputation.status === "ok" ? "text-ok" : s?.reputation.status === "throttled" ? "text-warn" : s ? "text-bad" : "")}>{s?.reputation.status ?? "—"}</span>
          <span className="font-mono text-[11.5px] text-fg2">{s ? `${fmt(s.reputation.opsSeen)} seen, ${fmt(s.reputation.opsIncluded)} included` : ""}</span></div>
        <div className="flex flex-col gap-1 p-4"><span className="font-mono text-[12px] text-fg2">Headroom</span>
          <span className="text-[26px]/[1.2] font-light tabular-nums">{s ? fmt(s.headroom.untilThrottled) : "—"}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-ln2" role="meter" aria-valuemin={0} aria-valuemax={span} aria-valuenow={s?.headroom.untilThrottled ?? 0} aria-label="Sends left before throttling">
            <div className={cx("h-full rounded-full", left > .25 ? "bg-ok" : left > .1 ? "bg-warn" : "bg-bad")} style={{ width: `${left * 100}%` }} />
          </div>
          <span className="font-mono text-[11.5px] text-fg2">{s ? `of ${fmt(span)} sends before throttling` : ""}</span></div>
      </div>
      <div className="flex min-w-0 flex-col gap-2 p-4">
        <span className="font-mono text-[12px] text-fg2" id="feed-h">Latest events</span>
        <ul aria-labelledby="feed-h" aria-live="polite" className="m-0 flex list-none flex-col p-0">
          {p.feed.length === 0 && <li className="py-1 text-[13px]/[20px] text-fg2">{s ? "Nothing new since you opened the page. A new inclusion, eviction or rejection appears here within 5 seconds." : "Connecting…"}</li>}
          {p.feed.slice(0, 3).map((e) => (
            <li key={e.id} className={cx("flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-ln py-2 text-[12.5px]/[19px] last:border-b-0", e.earlier && "opacity-60", e.hash.toLowerCase() === mine && "bg-amberbg")}>
              <span className="font-mono text-[11.5px] text-fg2">{e.at ? clock(e.at) : "earlier"}</span>
              <span className={cx("font-mono", KIND[e.kind].tone)}>{e.earlier ? "inclusion" : KIND[e.kind].label}</span>
              <Hash h={e.hash} />
              {e.hash.toLowerCase() === mine && <Pill kind="u">{p.target?.origin === "yours" ? "your tx" : "followed tx"}</Pill>}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ln px-4 py-3 text-[13px] text-fg2">
        <span>The full dashboard, VERIFY gas chart, tx lookup, network view and alerts are on the monitor page.</span>
        <a href={`/monitor?entity=${PAY_RELAY}`} className="font-mono text-amber">Open the monitor →</a>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- MCP

export const McpPanel = ({ p }: { p: Pipeline }) => (
  <div>
    <CardBar><span>agent transcript</span><span>results are live</span></CardBar>
    {!p.target ? <Empty>No run to ask about yet.</Empty> : (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11.5px] text-fg2">agent prompt (example wording)</span>
          <p className="m-0 text-[14px]/[22px] text-fg">Will this Pledge Paid transaction land, and is PayRelayWETH healthy?</p>
        </div>
        {p.mcp.map((c) => (
          <div key={c.tool} className="flex min-w-0 flex-col gap-2">
            <span className="break-words font-mono text-[12.5px]/[19px]"><span className="text-kw">{c.tool}</span> <span className="text-fg2">{c.args}</span></span>
            <div className="min-w-0 rounded-lg border border-ln bg-bg">
              <div className="flex items-center justify-between gap-2 border-b border-ln px-3 py-1.5 font-mono text-[11px] text-fg2">
                <span>what the MCP tool returns</span>
                <span className={c.status.status === "error" ? "text-bad" : c.status.status === "done" ? "text-ok" : ""}>{c.status.status === "done" ? "ok" : c.status.status === "error" ? "isError" : "calling…"}</span>
              </div>
              {c.status.status === "done" ? (
                <>
                  <pre className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px]/[18px] text-fg1">{c.status.value.text}</pre>
                  <details className="border-t border-ln px-3 py-2 font-mono text-[11.5px] text-fg2">
                    <summary className="cursor-pointer">structured JSON</summary>
                    <pre className="mt-2 max-h-[200px] overflow-auto text-[11.5px]/[17px] text-fg1">{c.status.value.json}</pre>
                  </details>
                </>
              ) : <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[12px]/[18px] text-fg2">{c.status.status === "error" ? c.status.error : "…"}</pre>}
            </div>
          </div>
        ))}
        <p className="m-0 text-[12.5px]/[19px] text-fg2">The tools return this text from checkAdmission, getAdmissionReport and entityStatus. This page calls the same functions in your browser, so no MCP server is involved. entity_status reads the report the watchEntity tab uses.</p>
      </div>
    )}
  </div>
);
