import { fmt, cx, short } from "../ui";
import type { DoctorView, FrameState } from "../../live";

const STATE: Record<FrameState, { mark: string; word: string; tone: string }> = {
  ok: { mark: "✓", word: "ok", tone: "text-ok" },
  failed: { mark: "✗", word: "failed", tone: "text-bad" },
  skipped: { mark: "–", word: "not run", tone: "text-fg2" },
  unknown: { mark: "?", word: "no result", tone: "text-fg2" },
};

export const Frames = ({ frames }: { frames: NonNullable<DoctorView["frames"]> }) => (
  <div className="flex flex-col gap-3">
    <p className="m-0 font-mono text-[12px] text-fg2">per frame, from {frames.source}</p>
    <ol className="m-0 flex list-none flex-col divide-y divide-ln overflow-hidden rounded-xl border border-ln2 bg-s1 p-0">
      {frames.rows.map((r) => {
        const s = STATE[r.state];
        return (
          <li key={r.index} className={cx("grid grid-cols-[28px_70px_minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 font-mono text-[13px] max-[720px]:grid-cols-[28px_70px_1fr]", r.state === "failed" && "bg-bad/[.05]")}>
            <span className="text-fg2">{r.index}</span>
            <span className="text-fg1">{r.mode}</span>
            <span className="min-w-0 text-fg2 [overflow-wrap:anywhere]">
              {r.target ? short(r.target) : "sender"} · limit {fmt(r.limit)}{r.gasUsed !== undefined && ` · used ${fmt(r.gasUsed)}`}
            </span>
            <span className={cx(s.tone, "max-[720px]:col-start-2 max-[720px]:col-span-2")}><span aria-hidden="true">{s.mark} </span>{s.word}</span>
            {r.note && <span className="col-start-3 col-span-2 font-sans text-sm/[21px] text-fg1 max-[720px]:col-span-1 [overflow-wrap:anywhere]">{r.note}</span>}
          </li>
        );
      })}
    </ol>
  </div>
);
