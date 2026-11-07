import type { EntityReport } from "@altpool/monitor";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { useDoctor } from "../hooks";
import { jobForInput, presetsFor, type Live } from "../live";
import { recentRuns, useCurrentRun, useLastSent } from "../pledge";
import { Frames } from "./doctor/Frames";
import { onOpenInDoctor } from "./doctor/follow";
import { gapOf } from "./doctor/gapOf";
import { GapStory } from "./doctor/Gap";
import { Panes } from "./doctor/Panes";
import { RuleGrid } from "./doctor/RuleGrid";
import { Terminal } from "./doctor/Terminal";
import { UseIt } from "./doctor/UseIt";
import { Card, CardBar, cx, Dot, Section, valueOf } from "./ui";

export interface DoctorProps {
  doctor: ReturnType<typeof useDoctor>;
  /** PayRelayWETH's live report (the same state Monitor shows): the source of the Pledge Paid presets. */
  entity: Live<EntityReport>;
}

const H3 = ({ children }: { children: string }) => <h3 className="m-0 text-xl font-normal tracking-[-.01em] text-fg">{children}</h3>;

export const Doctor = ({ doctor: { current, run, invalid }, entity }: DoctorProps) => {
  const [input, setInput] = useState("");
  const report = valueOf(entity);
  const mine = useLastSent();
  const cur = useCurrentRun();
  const presets = useMemo(() => presetsFor(recentRuns(report), mine, cur), [report, mine, cur]);

  // Open on the newest Pledge Paid once the live report has answered (or failed), else on the exit replay.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || entity.status === "loading") return;
    started.current = true;
    run((presets.find((p) => p.id === "latest") ?? presets.find((p) => p.id === "replay")!).job);
  }, [entity.status, presets, run]);

  // "Open in frame-doctor" on the live sender: load the run it is working on (its raw tx before the send, its hash after).
  const latest = useRef(presets);
  latest.current = presets;
  useEffect(() => onOpenInDoctor(() => {
    const p = latest.current.find((x) => x.id === "run");
    if (p) { setInput(""); run(p.job); }
  }), [run]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const job = jobForInput(input);
    if (typeof job === "string") invalid(job);
    else run(job);
  };
  const done = current.status === "done" ? current : undefined;
  const gap = gapOf(done?.view);
  const status = current.status === "running" ? "running…" : done ? `${done.ms} ms · live` : current.status === "error" ? "failed" : "";

  return (
    <Section id="doctor">
      <div className="flex flex-wrap items-end justify-between gap-12">
        <h2 className="m-0 text-[clamp(36px,5vw,56px)]/[1.07] font-light tracking-[-.03em] text-balance">
          frame-doctor, <span className="text-fg2">running in this page.</span>
        </h2>
        <p className="m-0 max-w-[460px] text-fg2">
          <span className="font-mono text-fg1">checkAdmission(tx)</span> says whether the public mempool and the alt mempool admit a frame transaction. When one rejects it, the report names the rule, the entity, the frame and the fix. Each verdict names its source: the node's simulation, the sidecar's admission record, or our local rule model, marked <span className="text-warn">unverified</span>.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex overflow-hidden rounded-xl border border-ln2 bg-s1">
          <label htmlFor="doctor-in" className="flex min-w-0 flex-1 items-center gap-3 px-[18px]">
            <span className="font-mono text-amber">$</span>
            <input
              id="doctor-in"
              aria-label="Transaction hash or raw frame transaction"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="paste a tx hash (0x… 64 hex) or a raw frame tx"
              className="h-[52px] min-w-0 flex-1 border-0 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg2"
            />
          </label>
          <button type="submit" disabled={current.status === "running"} className="bg-fg px-[26px] text-[15px] font-medium text-[#0a0a0c] disabled:cursor-wait disabled:opacity-50">Run</button>
        </form>
        <div role="group" aria-label="Examples" className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.id}
              aria-pressed={current.preset === p.id}
              onClick={() => { setInput(""); run(p.job); }}
              className={cx(
                "min-h-9 rounded-full border px-3.5 py-[7px] text-left text-sm",
                current.preset === p.id ? "border-amberln bg-amberbg text-amber" : "border-ln2 text-fg1",
              )}
            >{p.label}</button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[12px] text-fg2" aria-live="polite">
        <span className="uppercase tracking-[.08em]">{current.title}</span>
        <span className="flex items-center gap-2">
          <Dot state={done ? "live" : current.status === "error" || current.status === "invalid" ? "err" : undefined} />
          <span>{status}</span>
        </span>
      </div>
      {(current.status === "error" || current.status === "invalid") && <p className="m-0 rounded-xl border border-bad/40 bg-bad/[.06] p-4 font-mono text-sm text-bad [overflow-wrap:anywhere]">frame-doctor: {current.error}</p>}

      <GapStory view={done?.view} sent={current.preset === "run" ? cur?.hash : undefined} preset={current.preset === "run" ? cur?.preset : undefined} />
      <Panes view={done?.view} pending={current.status === "running"} gap={gap} />

      <div className="flex flex-col gap-4">
        <H3>Rule by rule</H3>
        <RuleGrid view={done?.view} />
      </div>

      {done?.view.frames && (
        <details className="group flex flex-col gap-4">
          <summary className="cursor-pointer list-none font-mono text-sm text-fg1 marker:hidden">
            <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>Frame by frame
          </summary>
          <div className="mt-4"><Frames frames={done.view.frames} /></div>
        </details>
      )}

      <details className="group">
        <summary className="cursor-pointer list-none font-mono text-sm text-fg1 marker:hidden">
          <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>The same report, as the CLI prints it
        </summary>
      <Card className="mt-4">
        <CardBar windowDots>
          <span>frame-doctor {done?.view.txHash ?? ""}</span>
        </CardBar>
        <Terminal
          text={done?.text}
          error={current.status === "error" || current.status === "invalid" ? current.error : undefined}
        />
      </Card>
      </details>

      <div className="flex flex-col gap-4">
        <H3>Use it in your code</H3>
        <UseIt />
      </div>
    </Section>
  );
};
