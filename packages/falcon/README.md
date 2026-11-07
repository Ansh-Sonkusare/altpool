# @altpool/falcon

Post-quantum recipient wallets for QuietSend: a contract account whose only authority is a Falcon-512 signature, spending through an EIP-8141 frame transaction on the ERC-8421 alt mempool. Nothing here uses a native Falcon scheme (EIP-8141 has only ARBITRARY, SECP256K1 and P256): the signature rides in an `ARBITRARY` entry and `FalconWallet` is the verifier.

## Pieces

| File | What |
| --- | --- |
| `src/FalconWallet.sol` | The account. `fallback()` is the VERIFY frame; `execute(to, value, data)` is callable only by the wallet itself (a SENDER frame whose target is the wallet). `receive()` takes ETH. |
| `src/FalconSig.sol` | Decodes the signature bytes and calls the shared ZKNOX verifier. |
| `src/FalconWalletFactory.sol` | CREATE2 factory, salt = `pkHash`. `predictAddress(pkHash)` works before the wallet exists. |
| `src/falcon.ts`, `src/factory.ts` | noble keygen, NTT-domain key encoding, signing, frame-tx builder, off-chain `predictWalletAddress`. |
| `src/account.ts` | `falconAccount` / `falconSigner`: the optional post-quantum account for the `altpool` SDK. |
| `src/generated/bytecode.ts` | FalconWallet creation code (`bun run bytecode`), so prediction needs no forge and no `fs` (browser-safe). |
| `scripts/falcon-smoke.ts` | Live gate: deploy, fund, simulate, tamper test, real inclusion. |
| `scripts/falcon-recipient.ts` | Live flow: a QuietSend exit pays a not-yet-deployed Falcon wallet, which is then deployed and spends. |
| `vendor/ethfalcon` | ZKNOX ETHFALCON `43ac863`, MIT, unmodified (see `vendor/README.md`). |

## Use it from the SDK (optional post-quantum)

The SDK needs no change: a `FrameSigner` may be `{ signFrame }`, and `falconSigner` is one. Apps that never import this package keep plain secp256k1.

```ts
import { falconAccount, falconKeygen } from "@altpool/falcon";
const pq = falconAccount({ key: falconKeygen() });     // devnet factory + verifier by default; pq.address is final now
// pay pq.address (e.g. a QuietSend exit), deploy it once from any funded account:
await wallet.sendTransaction({ ...pq.deployCall(), gas: 18_000_000n, type: "legacy" });
const tx = pq.buildTx({ nonce: await pq.getNonce(client), to, value, maxFeePerGas });
await client.altpool.sendFrameTransaction({ transaction: tx, signer: pq.signer, prepare: true, mempool: "alt" });
```

Send to the alt mempool only: the public one rejects a ~3.9M-gas VERIFY. For `checkAdmission`, use `createSimulator({ verifyGasMax: FALCON_VERIFY_GAS })`: the default 450k pin is ExitRelay's. The demo shows it with `bun run demo --pq`.

## Design

- **Key.** Falcon-512 from `@noble/post-quantum` (897-byte public key, 655-byte signature). The verifier wants the key in the NTT domain and the signature's `s2` as 32 packed words. `pubkeyToNtt` reimplements ZKNOX's forward NTT (twiddle `psirev[i] = 49^bitrev9(i) mod 12289`, checked against ZKNOX's 512-entry table); `test/FalconSig.t.sol` proves a TS-encoded key and signature verify in the real `ZKNOX_falcon`.
- **Signature bytes** (ARBITRARY entry, 2088 bytes): `salt(40) || s2(32 words) || ntth(32 words)`. The wallet stores only `pkHash = keccak256(ntth)` as an immutable and checks the shipped `ntth` against it. Deviation from "store the precomputed key in the constructor": it makes VERIFY read no state, and deploy writes no 1 KB of key (state gas is 1530/byte). The key is public in every signature anyway.
- **Message.** `TXPARAM SIG_HASH` (32 bytes), read in VERIFY; the entry must be ARBITRARY with empty `msg` (so the signature covers the canonical sig hash) and exactly one signature must be present. The sig hash covers all frame data and the nonce, so a signature is bound to one transaction.
- **Frames.** 0 `VERIFY` target = wallet, scope `EXECUTION_AND_PAYMENT`, data `0x00` (empty data hits `receive()` and never approves); 1 `SENDER` target = wallet, `execute(to, value, data)`. The wallet pays its own gas.
- **Nonce.** Read `eth_getTransactionCount`, never assume 1: `HegotaSupport` CREATEs 7 opcode helpers from the wallet, so a fresh wallet's account nonce is 8.

## Verified on the devnet (chain 1337, 2026-11-07)

All numbers below were printed by the scripts in this package.

- Contracts: shared `ZKNOX_falcon` verifier deploys at 16.47M gas (10.5 KB code, state gas), `FalconWallet` 6.39M, `FalconWalletFactory` 9.18M, wallet via factory 6.15M. Addresses in `deployments.json`.
- **VERIFY gas** (`ethrex_simulateFrameTransaction`): 3,859,128 for the gate tx; 3.62M to 3.86M over 25 random signatures (mean 3.75M; the spread is hash-to-point rejection sampling). Included receipts: 3,859,128 (gate), 3,624,583 (a resubmitted spend), 3,859,373 (recipient flow). Frame limit is `FALCON_VERIFY_GAS` = 4.5M, 16% over the observed max; unused gas is not charged. Forge measures the verifier alone at about 4.0M for one vector.
- **SENDER frame**: 13,031 execution gas plus 183,600 state gas (new recipient account). It halted at an execution limit of 150k and passed at 200k, so the limit is 250k.
- **(a)** A good signature simulates `success` (VERIFY ok, SENDER ok). **(b)** One flipped `s2` byte fails in VERIFY (frame 0, revert data `0xe0704462` = `BadFalconSignature()`), and the sidecar refuses it at submission. **(c)** The good tx was admitted by the miner sidecar (all rule checks pass: signature, simulation, trace-alignment, OP-011, storage, create, COD-010, entrypoint-access) and included; the recipient received exactly 0.001 ETH.
- **QuietSend recipient flow** (`falcon-recipient.ts`): a real exit through the live ExitRelay paid 0.09 ETH to an address with no code, the factory then deployed the wallet at that address (balance kept), and a Falcon-signed frame tx spent 0.01 ETH out; the wallet paid ~0.0041 ETH gas.
- `SIGDATACOPY` (0xB5) was listed "from the EIP text, not exercised" in hegota-support for this devnet: it works here.
- Gas cost: at a 1 gwei tip a spend costs ~0.004 ETH on this devnet.

## Why only the alt mempool

VERIFY here is ~3.9M gas (frame limit 4.5M). ethrex's public mempool caps VERIFY at 100,000 (`MAX_VERIFY_GAS`); the same simulation reports `prefix gas budget exceeded: 4500100 > 100000`. The alt-mempool sidecar's `validationGasLimit` is 10,000,000 (the devnet team removed the old 100k cap on Nov 6 and calls the replacement temporary), so these transactions go to the sidecar (`DEVNET.minerSidecarUrl`) and never to the public mempool.

**Over the ERC-8421 budget.** 3.9M is about 4× ERC-8421's 1M staked VERIFY budget (BUDGET-010), and the wallet is not staked. It is admitted only because this devnet's sidecar allows 10M. Unlike ExitRelay (~375k, under 1M), a Falcon wallet does not fit the spec's budgets as written: it needs either a cheaper verifier (EIP-8052 precompile, ~3k gas in draft; or a cheaper Solidity variant) or a spec budget for post-quantum accounts. The argument for the cost: the verifier is pure compute and the wallet's VERIFY reads no storage (only its own immutables and the frame opcodes), so other transactions cannot invalidate a validated tx. The sidecar's storage and opcode rules passed; that argument is ours, not the devnet team's acceptance of it.

## Caveats

- **ZKNOX_falcon is experimental and unaudited** (upstream says so). Nothing here has been reviewed by a third party. The NIST/SHAKE256 verifier is the only part that decides who can spend.
- noble's Falcon is also young; signing is randomised and a signature is not constant gas.
- Not verified: other nodes' validation caps; behaviour under a hard-fork change of the frame opcodes; a mainnet-grade audit; gossip across nodes (everything was sent to the miner's sidecar).
- Of four correct spend submissions to the miner, one was admitted and then dropped by the miner after 4 relays without a block (hash `0x057b1b16…4e00`, status `Cancelled`); an identical resubmission at the same nonce was included in 8 seconds. Cause not established. `falcon-recipient.ts` resubmits once on a drop.
- `falcon-smoke.ts` and first-time deploys need `forge build` (artifacts in `out/`); `falcon-recipient.ts` runs without forge once the factory is deployed. Scripts read keys from the gitignored `.env` (generated, funded from the faucet; never a published devnet key).

## Commands

```sh
export PATH="$PATH:$HOME/.foundry/bin"
forge test -vv                          # 10 tests: TS-encoded key + sig verify in ZKNOX, tamper, factory, execute guard
bun scripts/gen-vector.ts               # regenerate test/vector.json
bun run bytecode                        # regenerate src/generated/bytecode.ts (from out/ or the deployed factory)
forge build && bun scripts/falcon-smoke.ts       # F1 gate (live)
bun scripts/falcon-recipient.ts                  # QuietSend recipient flow (live), spend through the SDK
bun scripts/falcon-spend.ts <wallet> [to] [eth]  # SDK spend from a deployed wallet whose key is in .env (live)
```
