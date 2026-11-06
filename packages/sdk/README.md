# altpool (SDK)

A viem extension for the EIP-8141 frame-transaction alternative mempool (the ERC-8421 sidecar). The execution
client (ethrex) and the sidecar are separate endpoints. Encoding, hashing and signing all come from
`@forshtat/hegota-support`; this package adds no second codec.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, frame, newTx, secp256k1Placeholder } from "altpool";

const sidecar = createAltMempoolClient({
  httpUrl: DEVNET.gatewayUrl,                              // https://altmempoolgateway.forshtat.com/rpc
  webSocketUrl: DEVNET.gatewayUrl.replace(/^http/, "ws"),  // same path, for subscriptions
  profile,                                                 // explicit: there is no default profile
});
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
  .extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));

const caps = await client.altpool.assertCompatible();     // chain, entry point, version, p2p, explorer, staking params

const { nonceKeys, nonceSeq } = await client.altpool.prepareNonceKeys({ sender: account.address }); // fresh random key
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
const { receipt } = await client.altpool.waitForFrameTransactionReceipt({ hash: sent.hash });
const report = await client.altpool.getAdmissionReport({ hash: sent.hash });          // the node's rule-by-rule record
```

`signer` is either a viem `LocalAccount` (raw-digest `sign({ hash })`) or `{ privateKey }`. Both produce identical
bytes. Wallet `signMessage` (EIP-191) does not work.

## What's under `client.altpool`

| Area | Methods |
| --- | --- |
| Node | `getConfig`, `getExplorerInfo`, `getMempoolInfo`, `assertCompatible`, `getGasPrice`, `getConnectedPeers`, `faucet`, `mempool(name)` |
| Transactions | `estimateFrameTransactionGas`, `prepareFrameTransaction`, `signFrameTransaction`, `submitFrameTransaction`, `sendFrameTransaction`, `getFrameTransaction`, `getFrameTransactionReceipt`, `getTransactionStatus`, `simulateFrameTransaction`, `waitForFrameTransactionReceipt` |
| Admission | `preflightFrameTransaction`, `getAdmissionReport`, `explainAdmissionFailure`, `compareMempoolProfiles` |
| Staking | `getMinimumStake`, `getEntityStake`, `isEntityStaked`, `stakeEntity`, `unlockEntityStake`, `withdrawEntityStake` |
| Keyed nonces | `getKeyedNonce`, `getNonceSequence`, `validateNonceKeys`, `prepareNonceKeys` (plus `replacementFees()`) |
| Recent roots | `getCurrentSlot`, `recentRootSourceId`, `encodeRecentRootWrite`, `verifyRecentRootPredeploy`, `getRecentRoot`, `validateRecentRootReferences`, `prepareRecentRootReferences` |
| Monitoring | `watchExplorerEvents`, `watchPendingTransactions`, `watchSubmittedTransactions`, `watchOnChainTransactions`, `watchTransaction`, `watchEntityReputation`, `getEntityReputation`, `watchEntityStake` |

Every function is also exported standalone (e.g. `getEntityStake(client, params, addr)`, `watchExplorerEvents(sidecar, …)`)
for code that doesn't want the extension (Dev C's monitor, the demo).

**Mempools.** `mempool: "public"` sends through ethrex `eth_sendRawTransaction`. Any other name picks a configured
sidecar (`altpoolActions({ sidecar, mempools: { other: createAltMempoolClient(…) } })`). The SDK has no
per-transaction mempool id: a node joins one mempool through its P2P topic, so choosing a mempool means choosing
a node.

**Errors.** Every error is an `AltpoolSdkError`, carrying `.rpc` (method, url, code, data, raw), `.detail` (the
`AltpoolError` union from `@altpool/core`) and `.fix`. The classes are `FrameAdmissionError`, `FrameSimulationError`,
`FrameSignatureError`, `NonceConflictError`, `RecentRootExpiredError`, `InsufficientStakeError`,
`StakeConfigurationError`, `ProfileMismatchError`, `UnsupportedCapabilityError`, `SubscriptionError`,
`TransportError` and `ReceiptTimeoutError`. Submissions are never retried.

## Devnet facts the SDK depends on (verified live, chain 1337, sidecar v4.1.1)

- **Estimation needs a signed probe.** The estimator rewrites body-frame limits to 10,000,000 (execution and
  state) *before* checking signatures. A tx signed at its real limits therefore fails with `-32507`, and so does an
  unsigned one. `estimateFrameTransactionGas({ signer })` signs that probe for you. Prefix (VERIFY) frames keep
  their declared limits and are marked `autoEstimated: false`. The signed probe is a valid tx, so spend the nonce
  right after.
- `nonceKeys` must have 1–16 entries (`[]` is rejected). `[0n]` is the account nonce. Other keys are read from
  NONCE_MANAGER (`0x…8250`) storage at `keccak256(pad32(sender) ‖ key)`.
- A replacement needs both fees +10% (+9% is rejected).
- Recent roots (`0x…8272`) are write-only: a write is 64 bytes, `salt ‖ root`, and the source is `msg.sender`. The
  storage layout comes from the deployed bytecode and is checked with `verifyRecentRootPredeploy()`.
  References travel in the early-8272 `recentRootReferences` payload field.
- Live `ethrex_simulateFrameTransaction` returns `canonicalMempoolValid` / `canonicalMempoolViolation`, not the
  documented `valid` / `violation`. The SDK accepts both.
- Staking is per `msg.sender`, and `minStake` / `minUnstakeDelay` / the registry come from `skandha_config`. A
  contract payer or factory has to call `addStake` from its own code. `registryCalldata` gives the calldata, and
  `stakeEntity({ entity })` refuses to stake on another address's behalf.
- Reputation, admissions and lifecycle events are node-local and kept in memory. Every such result carries `node`.
- The public gateway runs `bundlingMode: "manual"`. Admitted txs can sit in `New` indefinitely.
- The bundler's revalidation drops txs whose prefix uses more than 100,000 gas (`MAX_VERIFY_GAS`), even though
  admission accepted them.

## Live run

```sh
bun run --filter altpool live                 # public devnet
NETWORK=local bun run --filter altpool live   # altpool-localnet (quietsend-research/altpool-localnet)
```

The script uses a fresh in-memory key funded by the faucet (never printed, never saved). It writes hashes and
verdicts to `live/<network>-latest.json`.
