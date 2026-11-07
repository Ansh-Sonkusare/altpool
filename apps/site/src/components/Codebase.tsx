import { useState } from "react";
import type { EntityReport } from "@altpool/monitor";
import type { Live } from "../live";
import { Code } from "./Code";
import { Card, cx, InkPanel, Section } from "./ui";
import { PipelineStrip } from "./toolkit/Pipeline";
import { AdmissionPanel, McpPanel, SdkPanel, WatchPanel } from "./toolkit/panels";
import { usePipeline } from "./toolkit/usePipeline";

interface Tool {
  id: string;
  tab: string;
  value: string;
  file: string;
  code: string;
  notes: readonly string[];
}

// Every name below is exported by the package named in the file label. Check them against the READMEs before editing.
const TOOLS: readonly Tool[] = [
  {
    id: "sdk",
    tab: "SDK",
    value: "Build, check and send a frame transaction from a viem client, then read the rule-by-rule record the node kept.",
    file: "altpool · viem extension",
    code: `import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET } from "altpool";

const sidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile });
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
  .extend(altpoolActions({ sidecar }));

// tx is built with newTx() and frame(profile, ...)
const pre  = await client.altpool.preflightFrameTransaction({ transaction: tx, signer: account });
const sent = await client.altpool.sendFrameTransaction({ transaction: tx, signer: account, prepare: true });
const { receipt } = await client.altpool.waitForFrameTransactionReceipt({ hash: sent.hash });
const report = await client.altpool.getAdmissionReport({ hash: sent.hash });`,
    notes: ["preflightFrameTransaction predicts and never sends.", "Also on client.altpool: stakeEntity, prepareNonceKeys, estimateFrameTransactionGas, explainAdmissionFailure.", "Every error is an AltpoolSdkError with a .fix."],
  },
  {
    id: "admission",
    tab: "checkAdmission",
    value: "Learn which rule would reject your transaction, on which entity and frame, and what to change, before you sign.",
    file: "@altpool/simulator · also the frame-doctor CLI",
    code: `import { checkAdmission } from "@altpool/simulator";

const report = await checkAdmission(tx);   // a FrameTx, or its raw 0x hex
const alt = report.verdicts.alt;           // report.verdicts.public is the other mempool

alt.verdict;       // "admitted" | "rejected"
alt.source;        // "simulate" | "explorer" | "model"
alt.failed?.rule;  // the rule that failed
alt.fix;           // what to change

// from a shell: frame-doctor <rawTx | txHash> [--json] [-v]
// exits 0 when the alt mempool admits it, 1 when it rejects, 2 on usage or RPC errors`,
    notes: ["Every verdict names its source.", "A source of \"model\" is our local rule model and is unverified. The devnet has no alt dry-run."],
  },
  {
    id: "monitor",
    tab: "watchEntity",
    value: "Get warned before a staked relay is throttled, runs low on balance, has a stuck transaction or loses its stake.",
    file: "@altpool/monitor",
    code: `import { watchEntity } from "@altpool/monitor";

const stop = watchEntity(relayAddress, {
  throttleWarnAt: 20,   // sends left before throttling
  onStatus: (s) => console.log(s.reputation.status, s.headroom.untilThrottled),
  onThrottleWarning: (s) => alert(\`\${s.headroom.untilThrottled} sends left\`),
  onStuck: (t) => console.warn("stuck", t.hash, t.status),
  onStakeChange: (prev, next) => console.warn("stake", prev.isStaked, next.isStaked),
  onError: console.error,
});

stop();   // unwatch`,
    notes: ["Also onInclusion, onRejection, onEviction and onLowBalance.", "entityStatus(address) is the one-shot read and txReport(hash) follows one transaction."],
  },
  {
    id: "mcp",
    tab: "MCP",
    value: "An AI agent that writes frame transactions can ask whether each mempool admits them, and read the reason when one does not.",
    file: "@altpool/mcp · stdio server",
    code: `# add it to Claude Code
claude mcp add altpool -- bun <path-to-altpool>/packages/mcp/src/server.ts

check_admission        { raw | tx }              both mempools' verdict, the failed rule, the fix
get_admission_report   { hash, node?: "miner" | "gateway" }   what a node did with a sent tx
entity_status          { address }               stake, reputation, headroom, pending, inclusions`,
    notes: ["Bad input returns an MCP error with a Fix: line.", "An alt verdict with source \"model\" is labelled unverified in the tool output."],
  },
  {
    id: "vitest",
    tab: "Vitest preset",
    value: "Assert in CI that a frame transaction is admitted by the alt mempool. One line in the Vitest config puts the matchers on expect.",
    file: "@altpool/simulator/vitest-setup",
    code: `// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["@altpool/simulator/vitest-setup"] } });

// tx.test.ts
import { expect, test } from "vitest";
test("my tx is admitted by alt", async () => {
  await expect(tx).toBeAdmittedBy("alt");
});`,
    notes: ["Other matchers: toBeRejectedFor(mempool, rule) and toRouteTo(\"alt\", \"miner\").", "Pass { verified: true } so only a node's own answer counts. A verdict from the local rule model is unverified."],
  },
];

export const Codebase = ({ entity }: { entity: Live<EntityReport> }) => {
  const [id, setId] = useState(TOOLS[0]!.id);
  const t = TOOLS.find((x) => x.id === id)!;
  const p = usePipeline(entity);
  const wide = id === "monitor" || id === "vitest";
  const snippet = (
    <div className="flex min-w-0 flex-col gap-3">
      <InkPanel title={t.file}>
        <Code code={t.code} lang={t.id === "mcp" ? "sh" : "ts"} className="p-4 text-[12px]/[19px]" />
      </InkPanel>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]/[20px] text-fg2">
        {t.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
  const demo = id === "vitest" ? null : (
    <Card className="overflow-hidden">
      {id === "sdk" && <SdkPanel p={p} />}
      {id === "admission" && <AdmissionPanel p={p} />}
      {id === "monitor" && <WatchPanel entity={entity} p={p} />}
      {id === "mcp" && <McpPanel p={p} />}
    </Card>
  );
  return (
    <Section
      id="toolkit"
      n="04"
      label="Toolkit"
      title="Five tools, one check."
      lede="The strip follows one Pledge Paid through each tool. It follows yours once you send one, and the newest on chain until then."
    >
      <PipelineStrip p={p} tab={id} onTab={setId} />
      <div role="tablist" aria-label="Altpool tools" className="flex flex-wrap gap-2">
        {TOOLS.map((x) => (
          <button
            key={x.id}
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={x.id === id}
            aria-controls="tool-panel"
            onClick={() => setId(x.id)}
            className={cx(
              "min-h-11 rounded-md border px-4 py-2 font-mono text-[14px]",
              x.id === id ? "border-accln bg-accbg text-acc" : "border-ln2 text-fg2 hover:text-fg",
            )}
          >{x.tab}</button>
        ))}
      </div>
      <div role="tabpanel" id="tool-panel" aria-labelledby={`tab-${id}`} className="flex flex-col gap-4">
        <p className="m-0 max-w-[68ch] text-[15px]/[24px] text-fg1">{t.value}</p>
        <div className={cx("grid items-start gap-4", wide ? "grid-cols-1" : "grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] max-[960px]:grid-cols-1")}>
          {snippet}
          {demo}
        </div>
      </div>
      <p className="m-0 border-t border-ln pt-6 text-[15px]/[24px] text-fg1">
        Every package, with API and recipes: <a href="/docs" className="font-mono text-acc underline underline-offset-4">/docs</a>
      </p>
    </Section>
  );
};
