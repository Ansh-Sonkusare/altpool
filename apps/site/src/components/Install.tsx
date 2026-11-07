// "Use it": the three ways in. Install the SDK, send an admitted frame tx, give an agent the checks.
// Every name in SNIPPET is exported by altpool (packages/sdk/src); the shape follows packages/sdk/scripts/live.ts.
import type { ReactNode } from "react";
import { Code } from "./Code";
import { cx, InkPanel, Section } from "./ui";

const INSTALL = `git clone https://github.com/Ansh-Sonkusare/altpool
cd altpool && bun install
bun run --filter altpool build          # not on npm yet: build from the repo
(cd packages/sdk && npm pack)           # writes altpool-<version>.tgz
# in your project:
npm i /path/to/altpool/packages/sdk/altpool-*.tgz viem @forshtat/hegota-support`;

const SNIPPET = `import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import {
  altDevnet, altpoolActions, createAltMempoolClient, DEVNET,
  frame, newTx, secp256k1Placeholder,
} from "altpool";

const sidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile });
const ap = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
  .extend(altpoolActions({ sidecar })).altpool;

const { nonceKeys, nonceSeq } = await ap.prepareNonceKeys({ sender: account.address });
const transaction = newTx({
  chainId: DEVNET.chainId, sender: account.address, nonceKeys, nonceSeq,
  frames: [
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
    frame(profile, "SENDER", { target: to, execution: 50_000n, state: 200_000n, value: 1n }),
  ],
  signatures: [secp256k1Placeholder(profile)],
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
});

// gas filled, signed, sent
const { hash } = await ap.sendFrameTransaction({ transaction, signer: account, prepare: true });`;

const MCP = `git clone https://github.com/Ansh-Sonkusare/altpool
cd altpool && bun install
claude mcp add altpool -- bun $PWD/packages/mcp/src/server.ts`;

const Step = ({ n, title, lead, file, children, className, lang }: { n: string; title: string; lead: ReactNode; file: string; children: string; className?: string; lang?: "ts" | "sh" }) => (
  <div className={cx("flex min-w-0 flex-col gap-3", className)}>
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[12px] text-fg2">{n}</span>
      <h3 className="m-0 text-[19px]/[25px] font-medium">{title}</h3>
    </div>
    <p className="m-0 max-w-[62ch] text-[15px]/[23px] text-fg1">{lead}</p>
    <InkPanel title={file}>
      <Code code={children} lang={lang} className="p-4 text-[12.5px]/[20px]" />
    </InkPanel>
  </div>
);

const code = "font-mono text-fg";
const link = "text-acc underline underline-offset-2";

export const Install = () => (
  <Section
    id="install"
    band
    n="05"
    label="Install"
    title="An admitted frame transaction, from viem."
    lede="Altpool extends the viem client you already use. It encodes with the devnet's own codec, fills each frame's gas, picks a free nonce key, and can run frame-doctor's admission check before it sends."
  >
    <div className="grid grid-cols-1 items-start gap-x-10 gap-y-10 min-[1100px]:grid-cols-2">
      <Step n="01" title="Install" className="min-[1100px]:col-start-1" file="shell" lang="sh" lead={<>The packages are not on npm yet. Build and pack the SDK from the repo, then install the tarball next to viem and the devnet's codec. Works in Node and in the browser; <a href="/wallet" className={link}>/wallet</a> runs it in this tab with MetaMask.</>}>{INSTALL}</Step>
      <Step n="02" title="Send" file="send.ts" className="min-[1100px]:col-start-2 min-[1100px]:row-span-2 min-[1100px]:row-start-1" lead={<><span className={code}>prepare: true</span> estimates every frame's gas before signing. Every failure is an <span className={code}>AltpoolSdkError</span> with a <span className={code}>.fix</span>. <span className={code}>account</span> is any viem local account; fund it with <span className={code}>ap.faucet(address)</span>.</>}>{SNIPPET}</Step>
      <Step n="03" title="Give an agent the same checks" className="min-[1100px]:col-start-1" file="shell · Claude Code" lang="sh" lead={<>The MCP server exposes <span className={code}>check_admission</span>, <span className={code}>get_admission_report</span> and <span className={code}>entity_status</span>. A session exported from <a href="/wallet" className={link}>/wallet</a> lets an agent send within the limits you signed.</>}>{MCP}</Step>
    </div>
  </Section>
);
