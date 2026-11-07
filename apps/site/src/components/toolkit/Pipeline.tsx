import { cx, ExtLink, short } from "../ui";
import { exitUrl } from "../../altpool";
import { STAGE_WORD, type Pipeline as P, type Stage } from "./usePipeline";

export const StepDot = ({ stage }: { stage: Stage }) => (
  <span data-state={stage} className="relative inline-flex size-5 flex-none items-center justify-center" aria-hidden="true">
    {stage === "idle" && <span className="size-3.5 rounded-full border-2 border-dim" />}
    {stage === "running" && (
      <svg viewBox="0 0 20 20" className="size-5 animate-spin motion-reduce:animate-none">
        <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="2" className="text-amber" />
        <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber" />
      </svg>
    )}
    {stage === "done" && (
      <svg viewBox="0 0 20 20" className="size-5"><circle cx="10" cy="10" r="8" className="fill-ok" /><path d="m6 10.2 2.6 2.6L14 7.4" fill="none" stroke="#09090b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    )}
    {stage === "failed" && (
      <svg viewBox="0 0 20 20" className="size-5"><circle cx="10" cy="10" r="8" className="fill-bad" /><path d="m7 7 6 6m0-6-6 6" fill="none" stroke="#09090b" strokeWidth="2" strokeLinecap="round" /></svg>
    )}
  </span>
);

const NODES = [
  { id: "build", name: "Build", tool: "SDK", tab: "sdk" },
  { id: "check", name: "Check", tool: "checkAdmission", tab: "admission" },
  { id: "explain", name: "Explain", tool: "frame-doctor", href: "#doctor" },
  { id: "watch", name: "Watch", tool: "watchEntity", tab: "monitor" },
  { id: "ask", name: "Ask", tool: "MCP", tab: "mcp" },
] as const;

export const PipelineStrip = ({ p, tab, onTab }: { p: P; tab: string; onTab: (id: string) => void }) => {
  const t = p.target;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-ln2 bg-s1 p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[13px]/[20px] text-fg2">
        <span role="status">
          {t?.hash
            ? <>One transaction, five steps. Following {t.origin === "yours" ? "the run you sent" : "the newest Pledge Paid on chain"}: <ExtLink href={exitUrl(t.hash)} className="font-mono text-amber">{short(t.hash)}</ExtLink></>
            : t?.raw
              ? <>One transaction, five steps. Following the run you are building{t.preset ? ` (${t.preset})` : ""}. It has no hash until you send it.</>
              : t ? <>One transaction, five steps. Building the run you started.</> : <>One transaction, five steps. Waiting for the first Pledge Paid on chain.</>}
        </span>
        <a href="#pledge" className="font-mono text-[12px] text-amber hover:text-fg">Send one</a>
      </div>
      <ol className="m-0 grid list-none grid-cols-5 gap-2 p-0 max-[820px]:grid-cols-1">
        {NODES.map((n, i) => {
          const s = p.stages[n.id];
          const inner = (
            <>
              <span className="flex items-center gap-2.5">
                <StepDot stage={s.stage} />
                <span className="text-[15px] text-fg">{n.name}</span>
                <span className="ml-auto font-mono text-[11px] text-fg2">{STAGE_WORD[s.stage]}</span>
              </span>
              <span className="font-mono text-[12px] text-kw">{n.tool}</span>
              <span className="text-[12.5px]/[18px] text-fg2">{s.note}</span>
            </>
          );
          const cls = cx(
            "flex min-h-11 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left",
            "tab" in n && n.tab === tab ? "border-amberln bg-amberbg" : "border-ln hover:border-ln2",
            i < NODES.length - 1 && "min-[821px]:relative min-[821px]:after:absolute min-[821px]:after:-right-2 min-[821px]:after:top-5 min-[821px]:after:h-px min-[821px]:after:w-2 min-[821px]:after:bg-ln2 min-[821px]:after:content-['']",
          );
          return (
            <li key={n.id}>
              {"tab" in n
                ? <button type="button" className={cx(cls, "w-full")} onClick={() => onTab(n.tab)} aria-pressed={n.tab === tab}>{inner}</button>
                : <a href={n.href} className={cx(cls, "w-full")}>{inner}</a>}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
