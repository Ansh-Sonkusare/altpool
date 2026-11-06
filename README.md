# Altpool + QuietSend

**Altpool** is a viem toolkit for the ERC-8421 alt mempool: an SDK, an admission simulator with a `frame-doctor` CLI, and an entity monitor. **QuietSend** is the app we build with it: private withdrawals to a 0-ETH wallet with no relayer, sent by a staked contract, ExitRelay. ETHGlobal Mumbai, EF prize "Best use of the Frame Transaction Alternative Mempool".

Plan, owners and timeline: `docs/08-gates-and-tasks.md` in `Ansh-Sonkusare/quietsend-research`.

## Start

```bash
pnpm install
cp .env.example .env          # fresh key only
pnpm typecheck && pnpm test   # all packages
pnpm smoke                    # live devnet check (chain 1337, gateway, ethrex, explorer)
```

Work on your slice only: `pnpm turbo test --filter=@altpool/simulator...`

## Who owns what

| Folder | Package | Owner |
| --- | --- | --- |
| `packages/core` | `@altpool/core`: types, devnet config, RPC clients, captured fixtures | everyone (additive only after H1) |
| `packages/prover` | `@altpool/prover`: note, MiMC tree, Groth16 proof (gate G1) | Dev A |
| `packages/contracts` | `@altpool/contracts`: ExitRelay (Foundry), ABI, deployments | Dev A |
| `packages/sdk` | `altpool`: viem extension (send, gas, nonce keys, stake) | Dev B |
| `apps/quietsend` | `quietsend` CLI: deposit, withdraw | Dev B |
| `packages/simulator` | `@altpool/simulator`: `checkAdmission`, `frame-doctor` | Dev C |
| `packages/monitor` | `@altpool/monitor`: `watchEntity` | Dev C |
| `apps/monitor-web` | one-page live view | Dev C |
| `apps/demo` | `pnpm demo` | Dev C |

Packages depend only on `@altpool/core`. Only the apps reach across owners.

## Mocks

`@altpool/core/fixtures` loads real devnet responses captured during pre-event research (`fixtures/public`, `fixtures/public-r9`, `fixtures/local`, `fixtures/r9-demo`): rejections, ethrex simulate, estimates, reputation, admissions, a full paymaster demo run. Each file is `{ request: { method, params }, response }`. `fixtures/quietsend/withdraw-proof.mock.json` stands in for the prover until gate G1.

Known devnet facts (from the fixtures): `frame_simulateTransactionV1` is not deployed (`public/22`); ethrex simulate returns `{ canonicalMempoolValid, canonicalMempoolViolation }` (`public/29-31`); estimating an unsigned or 8-field tx fails.

## Contracts

Foundry isn't needed by anyone except Dev A. `pnpm --filter @altpool/contracts abi` builds and regenerates `src/generated/abi.ts`; commit that file and `deployments.json` so the apps never need `forge`. First time: `curl -L https://foundry.paradigm.xyz | bash && foundryup`, then `cd packages/contracts && forge install foundry-rs/forge-std --no-git`.

## Disclosure

Types and fixtures come from pre-event research (`quietsend-research`). Product code starts here. AI assistance is used and disclosed per event rules.
