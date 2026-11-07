import { fmt, cx, InkPanel, short } from "../ui";
import type { DoctorView, FrameState } from "../../live";

const STATE: Record<FrameState, { mark: string; word: string; tone: string }> = {
  ok: { mark: "✓", word: "ok", tone: "text-[color-mix(in_srgb,var(--color-ok)_45%,white)]" },
  failed: { mark: "✗", word: "failed", tone: "font-medium text-[color-mix(in_srgb,var(--color-bad)_45%,white)]" },
  skipped: { mark: "–", word: "not run", tone: "text-inkdim" },
  unknown: { mark: "?", word: "no result", tone: "text-inkdim" },
};

export const Frames = ({ frames }: { frames: NonNullable<DoctorView["frames"]> }) => (
  <div className="flex flex-col gap-3">
    <InkPanel title={`per frame, from ${frames.source}`}>
    <ol className="m-0 flex list-none flex-col divide-y divide-inkln p-0">
      {frames.rows.map((r) => {
        const s = STATE[r.state];
        return (
          <li key={r.index} className={cx("grid grid-cols-[28px_70px_minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 font-mono text-[13px] max-[720px]:grid-cols-[28px_70px_1fr]", r.state === "failed" && "bg-bad/20")}>
            <span className="text-inkdim">{r.index}</span>
            <span className="text-inkfg">{r.mode}</span>
            <span className="min-w-0 text-inkdim [overflow-wrap:anywhere]">
              {r.target ? short(r.target) : "sender"} · limit {fmt(r.limit)}{r.gasUsed !== undefined && ` · used ${fmt(r.gasUsed)}`}
            </span>
            <span className={cx(s.tone, "max-[720px]:col-start-2 max-[720px]:col-span-2")}><span aria-hidden="true">{s.mark} </span>{s.word}</span>
            {r.note && <span className="col-start-3 col-span-2 font-sans text-sm/[21px] text-inkfg max-[720px]:col-span-1 [overflow-wrap:anywhere]">{r.note}</span>}
          </li>
        );
      })}
    </ol>
    </InkPanel>
  </div>
);
