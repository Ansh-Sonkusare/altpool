#!/usr/bin/env bun
// stdio MCP server: lets an AI agent ask the ERC-8421 alt mempool whether a frame tx will be admitted.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkAdmissionTool, entityStatusTool, getAdmissionReportTool } from "./tools";

const server = new McpServer({ name: "altpool", version: "0.0.0" });

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

await server.connect(new StdioServerTransport());
