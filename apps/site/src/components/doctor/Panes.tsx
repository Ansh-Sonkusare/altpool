import type { MempoolVerdict } from "@altpool/core";
import type { DoctorView } from "../../live";
import { cx, Pill, short } from "../ui";
import type { Gap } from "./gapOf";

const SOURCE: Record<MempoolVerdict["source"], { label: string; kind: "v" | "u" }> = {
  simulate: { label: "node simulation", kind: "v" },
  explorer: { label: "sidecar admission record", kind: "v" },
  send: { label: "sent to the node", kind: "v" },
  model: { label: "local model, unverified", kind: "u" },
};

const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[72px_1fr] gap-3 text-sm/[21px]">
    <dt className="font-mono text-[12px] text-fg2">{k}</dt>
    <dd className="m-0 min-w-0 text-fg1 [overflow-wrap:anywhere]">{children}</dd>
  </div>
);

const Pane = ({ title, v, note, pending, rolledBack, gap }: { title: string; v?: MempoolVerdict; note?: string; pending?: boolean; rolledBack?: number; gap?: Gap }) => {
  const f = v?.failed;
  const bad = v?.verdict === "rejected";
  return (
    <section aria-label={`${title} verdict`} className={cx("flex min-w-0 flex-col gap-4 p-6", bad && "bg-bad/[.04]", gap && "bg-warnbg")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-mono text-[12px] font-normal uppercase tracking-[.12em] text-fg2">{title}</h3>
        {v ? <Pill kind={SOURCE[v.source].kind}>{SOURCE[v.source].label}</Pill> : <span className="font-mono text-[11px] text-fg2">no source</span>}
      </div>
      <p className={cx("m-0 font-serif text-[40px]/[1.1]", v ? (bad ? "text-bad" : "text-ok") : "text-fg2")}>
        {v ? (bad ? "✗ Rejected" : "✓ Admitted") : pending ? "…" : "Not checked"}
      </p>
      {v && f && (
        <dl className="m-0 flex flex-col gap-2">
          <Fact k="rule"><span className="font-mono text-fg">{f.rule}</span>{f.ercRule && <span className="text-fg2"> ({f.ercRule})</span>}</Fact>
          {f.entity && <Fact k="entity"><span className="font-mono">{f.entity.role} {short(f.entity.address)}</span></Fact>}
          {f.frameIndex !== undefined && <Fact k="frame">frame {f.frameIndex}</Fact>}
          {v.error?.revertReason ? <Fact k="revert"><span className="font-mono">"{v.error.revertReason}"</span></Fact> : v.error?.message && <Fact k="node">{v.error.message}</Fact>}
        </dl>
      )}
      {v?.fix && <p className="m-0 border-l-2 border-ok/60 pl-3 text-sm/[21px] text-fg1"><span className="font-mono text-[12px] text-ok">fix </span>{v.fix}</p>}
      {gap && (
        <p className="m-0 border-l-2 border-warn pl-3 text-sm/[21px] text-fg1">
          <span className="font-mono text-[12px] text-warn">gap </span>
          Admitted, but frame {gap.frame} {gap.phase === "presend" ? "reverts in the node's simulation" : "reverted on chain"}{gap.reason && <>: <span className="font-mono">{gap.reason}</span></>}.
        </p>
      )}
      {v && !bad && !gap && <p className="m-0 text-sm/[21px] text-fg2">No failing rule.{rolledBack !== undefined && ` Admitted to the pool, but frame ${rolledBack} reverted on chain and the batch rolled back.`}</p>}
      {!v && note && <p className="m-0 text-sm/[21px] text-fg2">{note}</p>}
    </section>
  );
};

export const Panes = ({ view, pending, gap }: { view?: DoctorView; pending?: boolean; gap?: Gap }) => (
  <div className="grid grid-cols-2 divide-x divide-ln overflow-hidden rounded-xl border border-ln2 bg-s1 max-[720px]:grid-cols-1 max-[720px]:divide-x-0 max-[720px]:divide-y">
    <Pane title="Public mempool" v={view?.public} note={view?.notes.public} pending={pending} />
    <Pane title="Alt mempool (ERC-8421)" v={view?.alt} note={view?.notes.alt} pending={pending} gap={gap} rolledBack={view?.alt?.source === "explorer" ? view.frames?.rows.find((r) => r.state === "failed")?.index : undefined} />
  </div>
);
