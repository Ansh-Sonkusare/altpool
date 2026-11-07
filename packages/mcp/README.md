# @altpool/mcp

A stdio MCP server for the ERC-8421 alt mempool (EIP-8141 frame transactions). It lets an AI agent:
- check a frame tx before sending it, and read why a node rejected it;
- build, sign, submit and follow frame txs;
- act on the fix itself: fund an address, or stake an entity.

The repair loop is send → read the failing rule → fix → resend, until the alt mempool admits the tx.

## Tools

| Tool | Does |
| --- | --- |
| `agent_info` | The signers this server holds: the agent EOA (address, balance, stake) and an optional BridgeAccount session (account, limits, expiry). Call it first. |
| `check_admission` { raw? \| tx? } | Both mempools' verdict for a frame tx, with the failing rule and its fix. A 66-char hash is routed to `get_admission_report`. |
| `get_admission_report` { hash, node? } | What a node actually did with a submitted tx: outcome, every rule check, fixes. Records are node-local and kept in memory. |
| `entity_status` { address } | Stake, reputation, headroom before throttle or ban, pending txs, recent inclusions. |
| `explain_rule` { rule } | A rule and its fix, looked up by ERC-8421 id (`BUDGET-010`), by sidecar check id (`storage`, `OP-061`), or by keyword (`stake`, `timestamp`). |
| `send_calls` { calls, via?, parallel?, dryRun?, force? } | Builds, signs, runs frame-doctor on, and submits a tx. `via: "agent"` sends from the agent EOA. `via: "session"` sends from the user's BridgeAccount. It refuses to submit a tx predicted to be rejected unless you pass `force`. |
| `prepare_owner_tx` { account, calls } | Human in the loop: returns an unsigned Mode A tx plus the EIP-712 typed data its owner signs in MetaMask or Rabby. |
| `submit_frame_tx` { tx \| raw, ownerSignature? } | Attaches the owner's signature, checks it recovers `OWNER()`, runs frame-doctor, and submits. |
| `wait_for_receipt` { hash, timeoutSec? } | Reports inclusion and each frame's status and gas. If the node dropped the tx, it says so and gives the reason. |
| `fund_from_faucet` { address? } | Funds from the devnet faucet. The default address is the agent. |
| `stake_entity` { contract?, amountEth? } | Stakes the agent EOA. With `contract`, calls that contract's payable `stake(registry, delay)`, because the registry keys stakes on `msg.sender`. |

The server also has a resource, `altpool://rules`: the rule catalog with limits, sidecar check ids and fixes. It
has one prompt, `get_admitted { goal }`, which runs the repair loop. Bad input returns `isError` with a `Fix:` line.
Handlers never throw.

## Keys and what the agent may do

The server never asks for or prints a user's wallet key.

- **Agent EOA.** Set by `ALTPOOL_AGENT_PK`. If that is unset, a key is generated once into `packages/mcp/.env`
  (gitignored). This is a devnet throwaway: fund it with `fund_from_faucet`.
- **A user's BridgeAccount, by session.** The user authorises a session in `apps/wallet-bridge-web` (one MetaMask
  signature), clicks **Export for an agent**, and starts the server with `ALTPOOL_SESSION=/path/to/file.json` (inline
  JSON works too). The file holds the session key. The account's own VERIFY code enforces the session's target,
  value per tx, fee cap per tx and expiry on-chain. `send_calls` refuses calls outside those limits before signing.
- **A user's BridgeAccount, per tx.** `prepare_owner_tx` gives the typed data, the user signs it in their wallet, and
  `submit_frame_tx` sends it. The agent never holds the owner's key.

frame-doctor's alt-mempool verdict is our local rule model when its `source` is `model`, because the alt mempool has
no dry-run RPC. The node's own answer is `get_admission_report` after submission.

## Install

```
claude mcp add altpool -- bun <path-to-altpool>/packages/mcp/src/server.ts
# acting for a user's BridgeAccount:
claude mcp add altpool -e ALTPOOL_SESSION=/path/to/altpool-session-xxxxxx.json -- bun <path-to-altpool>/packages/mcp/src/server.ts
```

Generic client config:

```json
{ "mcpServers": { "altpool": { "command": "bun", "args": ["<path-to-altpool>/packages/mcp/src/server.ts"], "env": { "ALTPOOL_SESSION": "/path/to/session.json" } } } }
```

## Verify

```bash
bun run --filter @altpool/mcp test                      # offline: input validation, session files, rule catalog
bun run --filter @altpool/mcp smoke                     # live, read-only: every tool registered, resource, prompt, reads
bun run --filter @altpool/mcp smoke -- --write          # + agent path: faucet -> send_calls -> wait_for_receipt
bun run --filter @altpool/mcp bridge-smoke              # + session and owner paths on the wallet-bridge test account
```

Live evidence (2026-11-07, public devnet, every frame succeeded):

| Path | Tx | Block |
| --- | --- | --- |
| agent EOA, `send_calls` | [0xd3598e53…](https://explorer.altmempool.wtf/tx/0xd3598e53ce6f3c31e99b69ace5e74870a6a920a35eab7ed489eaa8809298abd5?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 11667 |
| BridgeAccount session, `send_calls via session` | [0xaa43b7c2…](https://explorer.altmempool.wtf/tx/0xaa43b7c2bfe7f69f067bcbe5a012ba6475a0281366a3d1a6cec77e7240b214e2?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 11708 |
| BridgeAccount owner, `prepare_owner_tx` → `submit_frame_tx` | [0x39f06591…](https://explorer.altmempool.wtf/tx/0x39f06591f44ed095f3e746be8a68111dd4449ecbb3d85809a477f29c7604a693?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 11712 |

Known devnet behaviour: the sidecar can admit a 2-frame contract-sender tx and then cancel it with "relayed 4 times
without being included in a block". ethrex's builder drops these intermittently. `wait_for_receipt` reports this,
and a resend lands.

## Demo readiness

| | Public devnet (chain 1337) | altpool-localnet (chain 1337) |
| --- | --- | --- |
| Endpoints | defaults in `@altpool/core` `DEVNET` | `ETHREX_URL=http://127.0.0.1:8555 MINER_SIDECAR_URL=http://127.0.0.1:14337/rpc GATEWAY_URL=http://127.0.0.1:14337/rpc` |
| Agent funds | `fund_from_faucet` (1 ETH) | the localnet funder; the explorer faucet works only if the sidecar runs with `--explorer.enable` |
| Admission reports | miner and gateway explorer APIs | the sidecar needs `--explorer.enable`, or `get_admission_report` returns -32601 |
| Session path | a BridgeAccount for the owner (`bun run --filter @altpool/wallet-bridge deploy`) plus an exported session | the same, deployed on the localnet. The session file's `chainId` must match, and the localnet is also 1337 |
| Ready check | `bun run --filter @altpool/mcp smoke -- --write` | the same command, with the env vars above |

Talk track (about 1 min in Claude Code with the server added):
1. "Send 1 wei to 0x… from my account": `agent_info`, then `send_calls via session`, then `wait_for_receipt`, then
   the explorer link.
2. "Send 2000 wei": refused before signing, because the session caps value at 1000 wei per tx and the account
   enforces that on-chain.
3. `check_admission` on a QuietSend exit: public ✗ (100k cap, foreign storage), alt ✓ with ExitRelay staked.
   `explain_rule storage` says why.
