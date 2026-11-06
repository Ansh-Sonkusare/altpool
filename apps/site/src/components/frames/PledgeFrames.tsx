/**
 * Props
 *   PledgeFrames({ hash })            reads one included frame tx from the chain and draws the rail, a Play walkthrough and the detail panel.
 *   FrameRail({ rows, states?, selected, onSelect, done? })
 *                                     the grouped rail alone. rows = FrameRow[] (from readFrameTx, or a planned list with no `status`/`used`).
 *                                     states = optional per-index FrameState override ("pending" | "success" | "rolled back" | "reverted" | "skipped"),
 *                                     so a live send can fill the nine frames in without a receipt. done = frames below this index get a check.
 *   FrameDetail({ row, rows, state? }) the panel for one frame. Pair it with FrameRail for a custom flow.
 *   FramePlayer({ rows, states? })     rail + Play + detail from rows you already hold (what PledgeFrames renders once the tx is read).
 * Types and helpers (FrameState, stateOf, stepName) live in ./model.
 */
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { addrUrl, exitUrl } from "../../altpool";
import { readFrameTx, type FrameRow, type FrameTxView } from "../../frames";
import type { Live } from "../../live";
import { clock, Dot, dotFor, ExtLink, fmt, Pill, short } from "../ui";
import { FrameDetail } from "./FrameDetail";
import { FrameRail } from "./FrameRail";
import type { FrameState } from "./model";

export { FrameDetail, FrameRail };
export type { FrameState };

const STEP_MS = 1400;

export const FramePlayer = ({ rows, states }: { rows: FrameRow[]; states?: FrameState[] }) => {
  const [sel, setSel] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [touched, setTouched] = useState(false);
  const last = rows.length - 1;
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setTimeout(() => {
      if (sel >= last) setPlaying(false); else setSel(sel + 1);
    }, STEP_MS);
    return () => window.clearTimeout(timer.current);
  }, [playing, sel, last]);

  const go = (i: number) => { setPlaying(false); setTouched(true); setSel(Math.min(last, Math.max(0, i))); };
  const play = () => { if (playing) return setPlaying(false); setTouched(true); if (sel >= last) setSel(0); setPlaying(true); };
  const btn = "cursor-pointer rounded-md border border-ln2 px-3 py-1.5 font-mono text-[12px] text-fg1 hover:border-amberln hover:text-amber focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber disabled:cursor-default disabled:opacity-40 disabled:hover:border-ln2 disabled:hover:text-fg1";
  const row = rows[sel]!;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={play} className={`${btn} border-amberln text-amber`}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} disabled={sel === 0} onClick={() => go(sel - 1)}>Prev</button>
          <span className="font-mono text-[12px] text-fg2 tabular-nums">{sel + 1} / {rows.length}</span>
          <button type="button" className={btn} disabled={sel === last} onClick={() => go(sel + 1)}>Next</button>
        </div>
      </div>
      <FrameRail rows={rows} states={states} selected={sel} onSelect={go} done={touched ? sel : 0} />
      <FrameDetail row={row} rows={rows} state={states?.[row.index]} />
    </div>
  );
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const useFrameTx = (hash: Hex): Live<FrameTxView> => {
  const [s, setS] = useState<Live<FrameTxView>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setS({ status: "loading" });
    readFrameTx(hash).then(
      (value) => alive && setS({ status: "live", value, at: new Date() }),
      (e) => alive && setS({ status: "error", error: msg(e) }),
    );
    return () => { alive = false; };
  }, [hash]);
  return s;
};

export const PledgeFrames = ({ hash }: { hash: Hex }) => {
  const s = useFrameTx(hash);
  const v = s.status === "live" ? s.value : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[12px] text-fg2">
        <span className="flex items-center gap-2"><Dot state={dotFor(s)} size="sm" />{s.status === "live" ? `read from the chain ${clock(s.at)}` : s.status === "error" ? "devnet did not answer" : "reading the chain…"}</span>
        <ExtLink href={exitUrl(hash)} className="text-amber">{short(hash)}</ExtLink>
      </div>
      {s.status === "error" && <p className="text-[14px] text-bad">{s.error}</p>}
      {s.status === "loading" && <p className="font-mono text-[13px] text-fg2">reading the transaction and its receipt…</p>}
      {v && (
        <>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-3 font-mono text-[12px]">
            <div><dt className="text-[11px] tracking-[.12em] text-fg2 uppercase">Block</dt><dd className="mt-1 text-fg">{fmt(v.block)}</dd></div>
            <div><dt className="text-[11px] tracking-[.12em] text-fg2 uppercase">Sender</dt><dd className="mt-1"><ExtLink href={addrUrl(v.sender)} className="text-amber">{short(v.sender)}</ExtLink></dd></div>
            <div><dt className="text-[11px] tracking-[.12em] text-fg2 uppercase">Transaction status</dt><dd className="mt-1"><Pill kind={v.status === "success" ? "v" : "u"}>{v.status}</Pill></dd></div>
          </dl>
          <FramePlayer rows={v.frames} />
        </>
      )}
    </div>
  );
};
