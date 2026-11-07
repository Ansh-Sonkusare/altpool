import { useState } from "react";
import type { EntityReport } from "@altpool/monitor";
import type { Live } from "../live";
import { Card, CardBar, cx, Eyebrow, ExtLink, Section } from "./ui";
import { PipelineStrip } from "./toolkit/Pipeline";
import { AdmissionPanel, McpPanel, SdkPanel, WatchPanel } from "./toolkit/panels";
import { usePipeline } from "./toolkit/usePipeline";

const REPO = "https://github.com/Ansh-Sonkusare/altpool/tree/main";

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
];

interface Entry {
  path: string;
  name: string;
  job: string;
  uses: readonly string[];
}

// In the order they act in Pledge Paid, then the tools around it.
const ENTRIES: readonly Entry[] = [
  {
    path: "packages/prover", name: "@altpool/prover",
    job: "Builds the note, rebuilds the pool's Merkle path and makes the Groth16 proof that frames 1 and 2 use. The QuietSend exit and Pledge Paid share it. The site runs a browser websnark port in src/liveExit.",
    uses: ["createNote", "rootFor", "pathFor", "prove"],
  },
  {
    path: "packages/contracts", name: "@altpool/contracts",
    job: "The on-chain side of both flows. PayRelayWETH checks the proof, pays the gas and pins frames 2 to 8. SettlerFactory deploys the Settler at an address fixed by the invoice terms, and InvoiceBook records the payment. ExitRelay and ExitRelayToken are the plain QuietSend exit.",
    uses: ["payTx", "settlerAddress", "exitTx", "deployments"],
  },
  {
    path: "packages/core", name: "@altpool/core",
    job: "The devnet constants, the chain definition and the RPC clients that every other package uses.",
    uses: ["DEVNET", "altDevnet", "gateway", "ethrex"],
  },
  {
    path: "packages/sdk", name: "altpool",
    job: "The viem extension that prepares, checks and sends the nine-frame transaction to the sidecar, then reads back what the node decided.",
    uses: ["preflightFrameTransaction", "sendFrameTransaction", "waitForFrameTransactionReceipt", "getAdmissionReport", "prepareNonceKeys", "stakeEntity"],
  },
  {
    path: "packages/simulator", name: "@altpool/simulator",
    job: "Tells you whether each mempool will admit the transaction before you sign it. The frame-doctor CLI wraps it.",
    uses: ["checkAdmission", "createSimulator", "diagnoseAdmission", "frame-doctor"],
  },
  {
    path: "packages/monitor", name: "@altpool/monitor",
    job: "Watches a staked relay on the gateway and the miner's sidecar. It reports reputation, stake, balance, and stuck or rejected transactions.",
    uses: ["watchEntity", "entityStatus", "txReport", "watch-entity"],
  },
  {
    path: "packages/mcp", name: "@altpool/mcp",
    job: "A stdio MCP server that lets an AI agent ask whether a frame transaction will be admitted.",
    uses: ["check_admission", "get_admission_report", "entity_status"],
  },
  {
    path: "packages/falcon", name: "@altpool/falcon",
    job: "Not part of Pledge Paid. A Falcon-512 wallet that can receive a QuietSend payout and spend it with a frame transaction. Its VERIFY frame needs more gas than the public cap, so only the alt mempool admits it.",
    uses: ["falconKeygen", "falconSign", "falconSpendTx", "predictWalletAddress"],
  },
  {
    path: "apps/quietsend", name: "quietsend",
    job: "The command-line QuietSend exit on the ETH pool, which is frames 0 to 2 on their own.",
    uses: ["quietsend deposit", "quietsend withdraw <note>"],
  },
  {
    path: "apps/demo", name: "@altpool/demo",
    job: "A scripted run of the exit against the live devnet. It checks both mempools, sends, and explains the result.",
    uses: ["bun run demo", "--prepare", "--stage", "--fixture"],
  },
  {
    path: "apps/monitor-web", name: "@altpool/monitor-web",
    job: "A browser view of one entity or one transaction across the sidecars, built on the monitor package.",
    uses: ["?entity=0x…", "?tx=0x…"],
  },
  {
    path: "apps/site", name: "@altpool/site",
    job: "This page. Its Pledge Paid sender runs the prover, the contracts package and the SDK in your browser against the devnet.",
    uses: ["src/livePledge/run.ts"],
  },
];

const Code = ({ code }: { code: string }) => (
  <pre className="m-0 overflow-x-auto p-4 font-mono text-[12px]/[19px] text-fg1">
    {code.split("\n").map((l, i) => (
      <div key={i} className={cx("min-h-5 whitespace-pre", /^\s*(\/\/|#)/.test(l) && "text-dim")}>{l}</div>
    ))}
  </pre>
);

export const Codebase = ({ entity }: { entity: Live<EntityReport> }) => {
  const [id, setId] = useState(TOOLS[0]!.id);
  const t = TOOLS.find((x) => x.id === id)!;
  const p = usePipeline(entity);
  const wide = id === "monitor";
  const snippet = (
    <Card className="overflow-hidden">
      <CardBar windowDots><span>{t.file}</span></CardBar>
      <Code code={t.code} />
      <ul className="m-0 flex list-none flex-col gap-1.5 border-t border-ln p-4 text-[13px]/[20px] text-fg2">
        {t.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </Card>
  );
  const demo = (
    <Card className="overflow-hidden">
      {id === "sdk" && <SdkPanel p={p} />}
      {id === "admission" && <AdmissionPanel p={p} />}
      {id === "monitor" && <WatchPanel entity={entity} p={p} />}
      {id === "mcp" && <McpPanel p={p} />}
    </Card>
  );
  return (
    <Section id="toolkit">
      <div className="flex flex-col gap-4">
        <Eyebrow>The toolkit</Eyebrow>
        <h2 className="m-0 text-balance text-[clamp(36px,5vw,56px)]/[1.07] font-light tracking-[-.03em]">
          Four tools for the alt mempool.
        </h2>
        <p className="m-0 max-w-[640px] text-[16px]/[26px] text-fg2">
          The strip follows one Pledge Paid through each tool. It follows yours once you send one, and the newest on chain until then.
        </p>
      </div>
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
              "min-h-11 rounded-full border px-4 py-2 font-mono text-[14px]",
              x.id === id ? "border-amberln bg-amberbg text-fg" : "border-ln2 text-fg2 hover:text-fg",
            )}
          >{x.tab}</button>
        ))}
      </div>
      <div role="tabpanel" id="tool-panel" aria-labelledby={`tab-${id}`} className="flex flex-col gap-4">
        <p className="m-0 max-w-[720px] text-[15px]/[24px] text-fg1">{t.value}</p>
        <div className={cx("grid items-start gap-4", wide ? "grid-cols-1" : "grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] max-[960px]:grid-cols-1")}>
          {snippet}
          {demo}
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-3 border-t border-ln pt-8">
        <h3 className="m-0 text-[22px]/[28px] font-light tracking-[-.01em]">Every package, starting with the ones Pledge Paid uses</h3>
      </div>
      <div className="grid grid-cols-3 gap-4 max-[960px]:grid-cols-2 max-[720px]:grid-cols-1">
        {ENTRIES.map((e) => (
          <Card key={e.path} className="flex flex-col gap-3 p-5">
            <span className="truncate font-mono text-[12px] text-dim">{e.path}</span>
            <h3 className="m-0 font-mono text-[16px] font-medium text-fg">{e.name}</h3>
            <p className="m-0 text-[14px]/[22px] text-fg2">{e.job}</p>
            <div className="mt-auto flex flex-wrap gap-1.5">
              {e.uses.map((u) => (
                <span key={u} className="inline-flex rounded border border-ln2 px-2 py-1 font-mono text-[12px] text-fg1">{u}</span>
              ))}
            </div>
            <ExtLink href={`${REPO}/${e.path}`} className="font-mono text-[12px] text-amber hover:text-fg">Source</ExtLink>
          </Card>
        ))}
      </div>
    </Section>
  );
};
