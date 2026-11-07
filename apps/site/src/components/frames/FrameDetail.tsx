import { addrUrl } from "../../altpool";
import type { FrameRow } from "../../frames";
import { cx, ExtLink, fmt, short } from "../ui";
import { doesOf, explain, stateOf, stepName, type FrameState } from "./model";
import { ModeChip, StatePill } from "./FrameRail";

const KV = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="min-w-0"><dt className="font-mono text-[11px] tracking-[.12em] text-fg2 uppercase">{k}</dt><dd className="mt-1 font-mono text-[12px] break-words text-fg">{children}</dd></div>
);

/** Detail for the selected frame. The wrapper is a polite live region so a screen reader hears it change while Play steps. */
export const FrameDetail = ({ row, rows, state }: { row: FrameRow; rows: FrameRow[]; state?: FrameState }) => {
  const st = state ?? stateOf(row);
  const u = row.used;
  const does = doesOf(row);
  return (
    <div aria-live="polite" className="flex flex-col gap-4 rounded-lg border border-ln2 bg-s1 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-[12px] text-amber">frame {row.index}</span>
        <span className="text-[15px] text-fg">{stepName(row)}</span>
        <ModeChip mode={row.mode} /><StatePill state={st} />
      </div>
      {does && <p className="text-[14px]/[22px] text-fg1">{does.what} <span className="text-fg2">{does.why}</span></p>}
      <p className={cx("text-[14px]/[22px]", st === "success" || st === "pending" ? "text-fg2" : "text-fg1")}>{explain(row, st, rows)}</p>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-4">
        <KV k="Target">
          <ExtLink href={addrUrl(row.target)} className="text-amber">{row.targetName ?? short(row.target)}</ExtLink>
          {row.targetName && row.targetName !== "sender" && <span className="block text-[11px] text-fg2">{short(row.target)}</span>}
        </KV>
        <KV k="Call">{row.call}</KV>
        {row.approves && <KV k="Approves">{row.approves}</KV>}
        <KV k="Batch">{row.batch}</KV>
        <KV k="Gas limit (exec / state)">{row.gasLimit || row.stateLimit ? `${fmt(row.gasLimit)} / ${fmt(row.stateLimit)}` : "set when the frames are built"}</KV>
        <KV k="Gas used (exec / state)">{u ? `${fmt(u.execution)} / ${fmt(u.state)}` : "none yet"}</KV>
      </dl>
    </div>
  );
};
