# Altpool

**Know before you sign: will this frame transaction be admitted, and if not, which rule rejects it.**

Live site and findings: https://altpool.vercel.app

## What it is

Altpool is a toolkit for the ERC-8421 alternative mempool, built on viem. Frame transactions (EIP-8141) are checked by nodes against admission rules. Altpool lets you run those checks before you send.

- **SDK** (`altpool`): a viem extension to build, estimate, sign, send and watch frame transactions. See [packages/sdk/README.md](packages/sdk/README.md).
- **Admission simulator and `frame-doctor`** (`@altpool/simulator`): predicts admitted or rejected, and names the rule. See [packages/simulator/README.md](packages/simulator/README.md).
- **Monitor** (`@altpool/monitor`): `watchEntity` for stake, reputation and inclusions. Live view in `apps/monitor-web`.
- **MCP server** (`@altpool/mcp`): lets an agent check and send frame transactions. See [packages/mcp/README.md](packages/mcp/README.md).
- **Vitest preset**: add `setupFiles: ["@altpool/simulator/vitest-setup"]` to check frame transactions in your tests.

## Proof

| Measure | Result | What it is |
| --- | --- | --- |
| Live accuracy | 16 of 17 matched | Each tx was predicted before sending, then sent to the devnet. ethrex-simulate predictions (verified): 9 of 9. Our rule-model predictions (unverified source): 7 of 8. Details: [packages/simulator/accuracy/LIVE.md](packages/simulator/accuracy/LIVE.md) |
| Post-fix replay | 16 of 17 matched | Offline replay of the captured pre-send fixtures, explorer and estimate lookups off, after fixing the model against these same cases. In-sample, not held-out: the live row above is the honest measure. Details: [RESULTS.md](packages/simulator/accuracy/RESULTS.md) |
| Conformance | 43 agree, 2 differ, 239 not modelled | 227 are pool-over-time checks. 12 are shape, signature and expiry checks left to ethrex. |
| Live suite | 17 attempted comparisons, 1 skipped | Runs against the live devnet with a fresh key each time. |

The live run is the primary accuracy figure. The one miss there (case 4, alt mempool) exposed a model bug: we compared the stake's unstake delay with our own minimum (86400) instead of the node's (0). We fixed the model after that run. The live table is not re-predicted.

The one remaining replay miss is case 9 on the alt mempool: the node checked the gas budget first, and our rule ordering differs.

The 2 conformance differences are the canonical paymaster exemption (the devnet sidecar has none) and unassigned opcodes (the devnet sidecar allows them). The model follows the sidecar.

Reproduce:

```bash
bun run --filter @altpool/simulator live-suite     # live devnet, fresh key, writes accuracy/LIVE.md
bun run --filter @altpool/simulator accuracy       # offline replay, sends nothing
bun run --filter @altpool/simulator conformance    # model vs the rule suite
```

## Pledge Paid

Pledge Paid is the showcase transaction: one frame transaction with 9 frames, using PayRelayWETH and the Settler (see Uniswap v4 below).

Status: simulated 9/9 frames ok, not yet included (accepted by the miner sidecar, status New). Evidence in `packages/contracts/evidence/pledge.json`.

- Two 9-frame txs passed ethrex's pre-send simulation with all 9 frames ok. Per-frame simulated gas: 3051, 550095, 328225, 36521, 14870, 116368, 45832, 13037, 7373.
- The miner sidecar accepted both but has not mined them:
  [0xda290663…98a7ab](https://explorer.altmempool.wtf/tx/0xda290663c97abd926ad3989de284b526b4cd7830ffd71b1628376f37f298a7ab?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc),
  [0x0a0c612e…18be6e](https://explorer.altmempool.wtf/tx/0x0a0c612e2e14f1bde70c788184159a2374982b4504dcfa4385374e1eff18be6e?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- Quote at run time: 50 fgUSD cost 0.028065 ETH, with max-in set 3% above.

So the claim is: simulated 9/9. An included run is not yet linked.

## Uniswap v4

The Settler swaps through the Uniswap v4 PoolManager inside a frame transaction. The links below show swaps inside frames on the devnet.

- Swap inside a frame, via the Universal Router (spike): [block 8842](https://explorer.altmempool.wtf/tx/0x1e329339292a7080d68b7ada81abcc03a1a4dad2675c1d6418640fc8712e93ae?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- Atomic swap and pay: [block 8847](https://explorer.altmempool.wtf/tx/0x1f3a2d2a5b544e4ed5056682b12dbacc4f24287f27c3bb08a9e621bf71d8d134?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- Rolled-back swap with receipt status success: [block 8852](https://explorer.altmempool.wtf/tx/0x9f9bdc6bcff9db868ea9bc7f0403baee9771b520020c176e883e74a966c6d39d?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- The Settler's own direct PoolManager path has Foundry tests against a mock PoolManager only. It has not run against the real PoolManager on the devnet.

Where to look:

- `packages/contracts/src/Settler.sol`: `swap` and `unlockCallback`.
- `apps/site/src/livePledge/quote.ts`: the quote and max-in.
- `packages/contracts/scripts/pledge.ts`: builds and sends the 9-frame tx.
- `FEEDBACK.md`: our notes on Uniswap v4.

## Validation cost and why it is safe

| Contract | VERIFY gas | Limit | Source |
| --- | --- | --- | --- |
| ExitRelay | 374,217 measured | 450k pinned | live exits |
| PayRelayWETH | 550,095 simulated | 600k cap | ethrex simulation, Pledge Paid |
| Falcon-512 wallet | about 3.86M | n/a | measured |
| ExitRelayRR | 368,270 simulated VERIFY (ExitRelay: 374,217) | 450k pinned | reads no foreign storage; simulator reports only the public 100k gas cap, no storage violation; accepted by the miner sidecar, not mined ([tx](https://explorer.altmempool.wtf/tx/0x1eabf89749d952bf966a5678d138756c7c9c5bcee67532d74687f223fac6d43b?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc)) |

Why about 550k gas of validation is acceptable (from the site):

- The cost is fixed, with no loops. Every payment uses the same VERIFY gas, and the monitor charts it per inclusion.
- Cheap checks run before the pairing.
- Only the note's own withdrawal, or about 100 later deposits, can invalidate a pending payment.
- The relay is staked, so nodes can throttle it.
- It removes the relayer, a party who could censor the payment.

## Findings

We found issues in the devnet node and sidecar while building. The full list is at https://altpool.vercel.app/#proof.

Upstream status, exactly:

- Finding 9 (the sidecar admits a tx its own simulation says will revert, so a staked third-party payer funds a guaranteed failure) is filed upstream as [issue #7](https://github.com/forshtat/mempool-workshop-sidecar/issues/7), with a fix and a test in [PR #8](https://github.com/forshtat/mempool-workshop-sidecar/pull/8). The test fails without the fix and passes with it.
- The rolled-back frame status proposal (finding 10) is drafted for the EIP-8141 discussion, not posted yet.
- Finding 8 is to be reported privately. It has not been reported.

## Install

Nothing is on npm yet. Build and pack locally:

```bash
bun install
bun run --filter altpool build
(cd packages/sdk && npm pack)
bun run --filter @altpool/simulator build
(cd packages/simulator && npm pack)
```

Quick start (from [packages/sdk/README.md](packages/sdk/README.md)):

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, frame, newTx, secp256k1Placeholder } from "altpool";

const sidecar = createAltMempoolClient({
  httpUrl: DEVNET.gatewayUrl,
  webSocketUrl: DEVNET.gatewayUrl.replace(/^http/, "ws"),
  profile,
});
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
  .extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));

const { nonceKeys, nonceSeq } = await client.altpool.prepareNonceKeys({ sender: account.address });
const tx = newTx({
  chainId: 1337, sender: account.address, nonceKeys, nonceSeq,
  frames: [
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
    frame(profile, "SENDER", { target: to, execution: 50_000n, value: 1n }),
  ],
  signatures: [secp256k1Placeholder(profile)],
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
});

const pre = await client.altpool.preflightFrameTransaction({ transaction: tx, signer: account }); // prediction, never sends
const sent = await client.altpool.sendFrameTransaction({ transaction: tx, signer: account, prepare: true });
```

## Also built

- **ExitRelay and the QuietSend CLI** (`apps/quietsend`): private withdrawals to a 0-ETH wallet with no relayer, sent by a staked contract.
  Stake: [0xe60f892d…905f07](https://explorer.altmempool.wtf/tx/0xe60f892d470fbafb01070ef27f87ac0eb0a4dbc077ef129715a0d558c2905f07?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
  Exits:
  [0x5ceab9fd…4a9a9c](https://explorer.altmempool.wtf/tx/0x5ceab9fd792a5e39a4f74d0a480ca1d8e5f75281510e10f506ac79552b4a9a9c?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc),
  [0x3d1c2ceb…56dfd8](https://explorer.altmempool.wtf/tx/0x3d1c2cebf96ad2502941aaaeb07437cb15ba0be28383f1831b3c3e998d56dfd8?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc),
  [0xbaf4b795…ca8415](https://explorer.altmempool.wtf/tx/0xbaf4b795d20d8792aeea42876b8deb8c7785d5e19a72e4b6460496f832ca8415?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- **ExitRelayRR**: an ExitRelay variant whose VERIFY reads no foreign storage. Its simulated VERIFY gas is in the cost table above.
- **Falcon-512 wallets** ([packages/falcon](packages/falcon/README.md)): a post-quantum signature wallet, VERIFY about 3.86M gas.
- **Wallet Bridge** ([packages/wallet-bridge](packages/wallet-bridge/README.md)): browser wallets sign frame transactions through EIP-712. Mode A tx: [0x0060822c…8638](https://explorer.altmempool.wtf/tx/0x0060822c51248172ea2764e96b4b0a9bc3bff6b8bd79e372f1144bb6a41e8638?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).
- **MCP agent run**: agent [0xd3598e53…98abd5](https://explorer.altmempool.wtf/tx/0xd3598e53ce6f3c31e99b69ace5e74870a6a920a35eab7ed489eaa8809298abd5?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc), session [0xaa43b7c2…b214e2](https://explorer.altmempool.wtf/tx/0xaa43b7c2bfe7f69f067bcbe5a012ba6475a0281366a3d1a6cec77e7240b214e2?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc), owner [0x39f06591…a693](https://explorer.altmempool.wtf/tx/0x39f06591f44ed095f3e746be8a68111dd4449ecbb3d85809a477f29c7604a693?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc).

## Limits

- Devnet only (chain 1337). Nothing here has run on a public network.
- The crowd of deposits is seeded by us. Privacy for QuietSend is designed-to, not proven.
- Model verdicts are unverified until a node answers. Only ethrex-simulate predictions are verified.
- The miner sidecar currently leaves heavy frame txs unmined: only 6 small type-6 txs in about 2500 blocks. Admitted alt txs in the live suite also sat in status New. This is why Pledge Paid is simulated, not included.

## Develop

```bash
bun install
cp .env.example .env                 # fresh key only
bun run typecheck && bun run test    # all packages
bun run smoke                        # live devnet check (chain 1337, gateway, ethrex, explorer)
```

Run one slice: `bun run turbo test --filter=@altpool/simulator...`

| Folder | Package | What it is |
| --- | --- | --- |
| `packages/core` | `@altpool/core` | types, devnet config, RPC clients, captured fixtures |
| `packages/sdk` | `altpool` | viem extension |
| `packages/simulator` | `@altpool/simulator` | `checkAdmission`, `frame-doctor`, accuracy and conformance |
| `packages/monitor` | `@altpool/monitor` | `watchEntity` |
| `packages/mcp` | `@altpool/mcp` | MCP server |
| `packages/contracts` | `@altpool/contracts` | ExitRelay, PayRelayWETH, Settler (Foundry), ABI, deployments |
| `packages/prover` | `@altpool/prover` | note, MiMC tree, Groth16 proof |
| `packages/falcon` | `@altpool/falcon` | Falcon-512 wallet |
| `packages/wallet-bridge` | `@altpool/wallet-bridge` | BridgeAccount |
| `apps/quietsend` | `quietsend` | CLI: deposit, withdraw |
| `apps/site` | `@altpool/site` | the site, with the live Pledge Paid page |
| `apps/monitor-web` | `@altpool/monitor-web` | one-page live view |
| `apps/wallet-bridge-web` | `@altpool/wallet-bridge-web` | MetaMask/Rabby demo page |
| `apps/demo` | `@altpool/demo` | `bun run demo` |

Fixtures in `@altpool/core/fixtures` are real devnet responses, each `{ request: { method, params }, response }`.

Foundry is only needed to change contracts. `bun run --filter @altpool/contracts abi` regenerates `src/generated/abi.ts`; commit it with `deployments.json`.

The root `tsup ^9` devDependency is never run. It keeps bun from hoisting the packages' `tsup 8.5` to the root, where it would load the root TypeScript 7 and fail on declarations. Each package's tsup must resolve its own `typescript 5.9`, so don't remove the root pin; rebuild with `bun run --filter altpool build` if you change it.

## Disclosure

AI assistance was used to write code, tests and docs, and is disclosed per event rules. Numbers in this README come from the files linked next to them.
