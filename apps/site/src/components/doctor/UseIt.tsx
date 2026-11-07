import type { ReactNode } from "react";
import { Code } from "../Code";

const Block = ({ title, lead, children, lang }: { title: string; lead: ReactNode; children: string; lang?: "ts" | "sh" }) => (
  <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-ln bg-s1 p-5">
    <h3 className="m-0 font-mono text-[12px] font-normal uppercase tracking-[.12em] text-fg2">{title}</h3>
    <Code code={children} lang={lang} className="text-[12.5px]/[20px]" />
    <p className="m-0 mt-auto text-sm/[21px] text-fg2">{lead}</p>
  </div>
);

const code = "font-mono text-fg1";

export const UseIt = () => (
  <div className="grid grid-cols-3 gap-3 max-[960px]:grid-cols-1">
    <Block
      title="CLI"
      lang="sh"
      lead={<>Exits <span className="text-ok">0</span> when the alt mempool admits, <span className="text-bad">1</span> when it rejects and <span className="text-warn">2</span> on usage or RPC errors, so it can gate CI. <span className={code}>--json</span> prints the report as JSON. <span className={code}>-v</span> adds every rule check.</>}
    >{`frame-doctor <rawTx | txHash> [--json] [-v]
frame-doctor 0x02… --json
echo $?   # 0, 1 or 2`}</Block>
    <Block
      title="TypeScript"
      lead={<><span className={code}>checkAdmission</span> takes a raw tx or a FrameTx and returns both verdicts. Pass <span className={code}>simulator</span> as the SDK's <span className={code}>precheck</span> option, and the SDK runs it on preflight and on <span className={code}>{"submit({ precheck: true })"}</span>.</>}
    >{`import { checkAdmission, renderReport } from "@altpool/simulator";

const r = await checkAdmission(rawTx);
r.verdicts.public.verdict;       // "admitted" | "rejected"
r.verdicts.alt.failed?.rule;     // the failing rule
r.verdicts.alt.fix;              // what to change
console.log(renderReport(r));`}</Block>
    <Block
      title="MCP, for agents"
      lead={<>The <span className={code}>check_admission</span> tool in packages/mcp takes <span className={code}>raw</span> or <span className={code}>tx</span> and returns the same verdicts. A 66-character hash is routed to <span className={code}>get_admission_report</span>.</>}
    >{`tool: check_admission
args: { raw: "0x…" }
→ public + alt verdict, failing rule,
  entity, frame, fix. "model" = unverified`}</Block>
  </div>
);
