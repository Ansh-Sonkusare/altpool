import type { FrameRow } from "../../frames";
import { fmt, cx } from "../ui";
import { GROUPS, grouped, stateOf, stepName, STATE_TEXT, type FrameState } from "./model";

const STATE_CLS: Record<FrameState, string> = {
  success: "border-okln bg-okbg text-okt",
  "rolled back": "border-warnln bg-warnbg text-warn",
  reverted: "border-bad/40 bg-badbg text-bad",
  skipped: "border-ln2 bg-transparent text-fg2",
  pending: "border-dashed border-ln2 bg-transparent text-dim",
};

const STATE_GLYPH: Record<FrameState, string> = { success: "✓", "rolled back": "↺", reverted: "✕", skipped: "–", pending: "○" };

export const StatePill = ({ state }: { state: FrameState }) => (
  <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[12px]/normal", STATE_CLS[state])}><span aria-hidden="true">{STATE_GLYPH[state]}</span>{STATE_TEXT[state]}</span>
);

export const ModeChip = ({ mode }: { mode: FrameRow["mode"] }) => (
  <span className={cx("rounded-[4px] border px-2 py-[3px] font-mono text-[11px] tracking-[.06em] whitespace-nowrap", mode === "SENDER" ? "border-accln text-acc" : mode === "VERIFY" ? "border-kw/50 text-kw" : "border-ln2 text-fg2")}>{mode}</span>
);

/** exec blue, state violet, total on a square-root scale against the largest frame so a 10M-state deploy does not flatten the rest. */
const GasBar = ({ row, max }: { row: FrameRow; max: number }) => {
  const e = Number(row.used?.execution ?? 0), s = Number(row.used?.state ?? 0);
  const t = e + s;
  const w = t ? Math.max(1.5, (Math.sqrt(t) / Math.sqrt(max)) * 100) : 0;
  const pct = (n: number) => `${t ? (n / t) * w : 0}%`;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ln" aria-hidden="true">
        <i className="block h-full bg-acc" style={{ width: pct(e) }} />
        <i className="block h-full bg-kw" style={{ width: pct(s) }} />
      </div>
      <span className="w-[150px] flex-none text-right font-mono text-[11px] text-fg2 tabular-nums">{row.used ? `used ${fmt(row.used.execution)} + ${fmt(row.used.state)}` : row.gasLimit || row.stateLimit ? `limit ${fmt(row.gasLimit)} + ${fmt(row.stateLimit)}` : "no gas yet"}</span>
    </div>
  );
};

/**
 * The nine frames as a rail grouped into validation / outside / ATOMIC.
 * `states` overrides the state read from each row's receipt status (pass "pending" for a planned frame).
 * `done` marks frames below that index with a check once a walkthrough has passed them.
 */
export const FrameRail = ({ rows, states, selected, onSelect, done = 0 }: {
  rows: FrameRow[]; states?: FrameState[]; selected: number; onSelect: (index: number) => void; done?: number;
}) => {
  const max = Math.max(1, ...rows.map((r) => Number(r.used ? r.used.execution + r.used.state : 0)));
  const st = (r: FrameRow) => states?.[r.index] ?? stateOf(r);
  return (
    <div className="flex flex-col gap-4">
      {grouped(rows).map((g, gi) => {
        const atomic = g.key === "atomic";
        const failed = atomic && g.rows.some((r) => st(r) === "rolled back" || st(r) === "reverted");
        return (
          <div key={gi} className={cx("min-w-0 overflow-hidden rounded-lg border", atomic ? (failed ? "border-warnln" : "border-accln") : "border-ln")}>
            <div className={cx("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-2 font-mono text-[11px]", atomic ? "border-accln bg-accbg" : "border-ln bg-band")}>
              <span className={cx("tracking-[.12em]", atomic ? "text-acc" : "text-fg1")}>{atomic ? <>[ {GROUPS.atomic.title} ]</> : GROUPS[g.key].title}</span>
              <span className="text-fg2">{GROUPS[g.key].sub}{failed && <span className="text-warn">, and it failed</span>}</span>
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {g.rows.map((r) => {
                const s = st(r), on = r.index === selected;
                return (
                  <li key={r.index} className="border-b border-ln last:border-b-0">
                    <button type="button" onClick={() => onSelect(r.index)} aria-current={on ? "step" : undefined}
                      className={cx("flex min-h-11 w-full cursor-pointer flex-col gap-2.5 px-3 py-3 text-left motion-safe:transition-colors hover:bg-accbg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-acc", on && "bg-accbg", s === "skipped" && !on && "opacity-60")}>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className={cx("w-6 flex-none font-mono text-[12px] tabular-nums", on ? "text-acc" : "text-fg2")}>
                          {on ? "▸" : ""}{r.index}{r.index < done && <span className="text-ok"> ✓</span>}
                        </span>
                        <span className="min-w-0 flex-1 basis-40 text-[14px] text-fg">{stepName(r)}</span>
                        <ModeChip mode={r.mode} />
                        <StatePill state={s} />
                      </span>
                      <span className="pl-9"><GasBar row={r} max={max} /></span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
    </div>
  );
};
