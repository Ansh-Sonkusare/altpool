# @altpool/mcp

A stdio MCP server that lets an AI agent ask the ERC-8421 alt mempool (devnet, chain 1337) whether an EIP-8141 frame tx will be admitted.

## Tools

- `check_admission` { raw? | tx? }: both mempools' verdict for a frame tx, given as 0x hex (`raw`, ethrex-eip8141-tracer profile) or wire JSON (`tx`). A 66-char hash is routed to `get_admission_report`. Returns a text summary plus the full AdmissionReport JSON.
- `get_admission_report` { hash, node?: "miner" | "gateway" }: what a node actually did with a submitted tx (outcome, every rule check, failures with fixes). Default node is the miner sidecar. Records are node-local, so a miss means "try the other node".
- `entity_status` { address }: stake, reputation, headroom before throttle/ban, pending txs, recent inclusions.

Bad input returns an MCP error (`isError`) with a `Fix:` line.

## Install

```
claude mcp add altpool -- bun <path-to-altpool>/packages/mcp/src/server.ts
```

Generic client config:

```json
{ "mcpServers": { "altpool": { "command": "bun", "args": ["<path-to-altpool>/packages/mcp/src/server.ts"] } } }
```

## Caveats

The alt mempool has no dry-run RPC. An alt verdict in `check_admission` is the node's own answer only when its `source` is `explorer` or `simulate`. When `source` is `model`, it is our local rule model: an unverified prediction. The tool output says so.

## Verify

`bun run --filter @altpool/mcp smoke` spawns the server and runs all three tools against the live devnet.
