#!/usr/bin/env bun
// stdio MCP server for the ERC-8421 alt mempool: an AI agent can check, build, sign, submit and follow EIP-8141 frame
// txs, read why a node rejected one, and act on the fix (fund, stake). Keys: see context.ts; none are ever printed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkAdmissionTool, entityStatusTool, getAdmissionReportTool } from "./tools";
import { agentInfoTool, fundFromFaucetTool, prepareOwnerTxTool, sendCallsTool, stakeEntityTool, submitFrameTxTool, waitForReceiptTool } from "./write";
import { RULES_MARKDOWN, explainRuleTool } from "./rules";

const server = new McpServer({ name: "altpool", version: "0.1.0" });

const call = z.object({
  to: z.string().describe("0x target address"),
  value: z.string().optional().describe("wei, decimal or 0x hex (default 0)"),
  data: z.string().optional().describe("0x calldata (default empty)"),
  gas: z.string().optional().describe("execution gas limit for this frame (default: estimated / generous)"),
  state: z.string().optional().describe("state gas limit (default: enough to create a fresh recipient or new storage)"),
});

// ---------------------------------------------------------------------------------------------- read ------

server.registerTool("check_admission", {
  description: "Will the public mempool and the ERC-8421 alt mempool admit this EIP-8141 frame transaction, and if not, which rule fails and how to fix it. Give `raw` (0x hex) or `tx` (wire JSON). A 66-char hash is routed to get_admission_report. Alt verdicts with source \"model\" are unverified predictions.",
  inputSchema: {
    raw: z.string().optional().describe("0x-prefixed hex of the encoded frame tx (ethrex-eip8141-tracer profile), or a 0x tx hash"),
    tx: z.record(z.string(), z.unknown()).optional().describe("Frame tx in wire JSON (hex-string numbers), as sent to eth_sendFrameTransaction"),
  },
}, (a) => checkAdmissionTool(a));

server.registerTool("get_admission_report", {
  description: "What a node actually did with a submitted frame tx: outcome (accepted/rejected/included/...), every rule check, failures with fixes. Admission records are node-local, so a miss on one node may hit on the other.",
  inputSchema: {
    hash: z.string().describe("0x 32-byte frame tx hash"),
    node: z.enum(["miner", "gateway"]).optional().describe("Which node to ask (default miner)"),
  },
}, (a) => getAdmissionReportTool(a));

server.registerTool("entity_status", {
  description: "An alt-mempool entity's (sender/payer/factory/paymaster) stake, reputation, headroom before throttle/ban, pending txs and recent inclusions.",
  inputSchema: { address: z.string().describe("0x 20-byte entity address") },
}, (a) => entityStatusTool(a));

server.registerTool("explain_rule", {
  description: "Explain an alt-mempool admission rule and its fix, by ERC-8421 id (BUDGET-010, STORAGE, PREFIX-010), the sidecar check id from an admission record (storage, out-of-gas, OP-061, signature), or a keyword (stake, nonce, timestamp, state gas).",
  inputSchema: { rule: z.string().describe("rule id, sidecar check id, or keyword") },
}, (a) => explainRuleTool(a));

server.registerTool("agent_info", {
  description: "Which signers this server holds and what they may do: the agent's own devnet EOA (address, balance, stake) and, if configured, a BridgeAccount session (account, limits, expiry). Call first.",
  inputSchema: {},
}, () => agentInfoTool());

// --------------------------------------------------------------------------------------------- write ------

server.registerTool("send_calls", {
  description: "Build, sign, check (frame-doctor) and submit an EIP-8141 frame tx to the alt mempool. via \"agent\" (default): from the agent's own devnet EOA. via \"session\": from the user's BridgeAccount, signed by a session key the user authorised in their wallet; the account's own VERIFY code enforces the session's target, value and fee caps and expiry. Refuses to submit a tx frame-doctor predicts the alt mempool rejects (force: true overrides). Returns the hash and explorer link; then call wait_for_receipt.",
  inputSchema: {
    calls: z.array(call).min(1).max(6).describe("one SENDER frame per call, executed in order"),
    via: z.enum(["agent", "session"]).optional(),
    parallel: z.boolean().optional().describe("agent only: use a fresh EIP-8250 nonce key, so several txs can be pending at once"),
    dryRun: z.boolean().optional().describe("build, sign and check, but do not submit"),
    force: z.boolean().optional().describe("submit even if frame-doctor predicts a rejection"),
  },
}, (a) => sendCallsTool(a));

server.registerTool("prepare_owner_tx", {
  description: "Human-in-the-loop: build an unsigned Mode A tx for a BridgeAccount and the EIP-712 typed data its owner signs in a browser wallet (MetaMask/Rabby, eth_signTypedData_v4). The agent never holds the owner's key. Then submit_frame_tx with the signature.",
  inputSchema: { account: z.string().describe("the BridgeAccount address"), calls: z.array(call).min(1).max(6) },
}, (a) => prepareOwnerTxTool(a));

server.registerTool("submit_frame_tx", {
  description: "Check (frame-doctor) and submit a frame tx. Give the wire-JSON `tx` from prepare_owner_tx plus the owner's `ownerSignature` (it is attached and verified against the account's OWNER), or an already-signed tx / `raw` hex.",
  inputSchema: {
    tx: z.record(z.string(), z.unknown()).optional(),
    raw: z.string().optional().describe("0x encoded frame tx"),
    ownerSignature: z.string().optional().describe("the wallet's 65-byte eth_signTypedData_v4 result"),
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
  },
}, (a) => submitFrameTxTool(a));

server.registerTool("wait_for_receipt", {
  description: "Wait until a submitted frame tx is included and report every frame's status and gas, with an explorer link.",
  inputSchema: { hash: z.string(), timeoutSec: z.number().optional().describe("default 120, max 600") },
}, (a) => waitForReceiptTool(a));

server.registerTool("fund_from_faucet", {
  description: "Fund an address from the devnet faucet (default: the agent EOA). Fixes 'insufficient funds' / payer-solvency rejections.",
  inputSchema: { address: z.string().optional() },
}, (a) => fundFromFaucetTool(a));

server.registerTool("stake_entity", {
  description: "Stake in the alt mempool's staking registry, from the agent's funds. No `contract`: stakes the agent EOA. With `contract`: calls its payable stake(address registry, uint32 delay), since the registry keys on msg.sender and a contract must stake itself. Fixes STORAGE / BALANCE / budget rejections that say 'stake the entity'.",
  inputSchema: {
    contract: z.string().optional(),
    amountEth: z.string().optional().describe("default minStake + 0.002 ETH"),
    unstakeDelaySec: z.number().optional().describe("default max(node minimum, 86400)"),
  },
}, (a) => stakeEntityTool(a));

// ---------------------------------------------------------------------------------- resources, prompts ------

server.registerResource("rules", "altpool://rules", {
  title: "Alt mempool admission rules",
  description: "ERC-8421 admission rules with limits, sidecar check ids and fixes, plus how the public devnet differs.",
  mimeType: "text/markdown",
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: RULES_MARKDOWN }] }));

server.registerPrompt("get_admitted", {
  title: "Get a frame tx admitted",
  description: "The repair loop: send, read why it was rejected, fix, resend until the alt mempool admits it.",
  argsSchema: { goal: z.string().describe("what the tx should do, e.g. 'send 1 wei to 0x…'") },
}, ({ goal }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: `Goal: ${goal}\n\nUse the altpool tools. 1) agent_info. 2) send_calls (dryRun first if unsure). 3) If it is refused or rejected, read the failing rule (explain_rule, get_admission_report), apply the fix (fund_from_faucet, stake_entity, change the calls or limits), and retry. 4) When admitted, wait_for_receipt and report the explorer link. Never ask for a private key.`,
    },
  }],
}));

await server.connect(new StdioServerTransport());
