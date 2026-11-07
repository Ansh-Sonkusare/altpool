# Altpool reference

Altpool is a viem toolkit for the ERC-8421 alternative mempool on the EIP-8141 frame-transaction devnet (chain 1337). QuietSend and Pledge Paid are apps built with it. This reference is derived from the repository source at https://github.com/Ansh-Sonkusare/altpool and was checked against the live devnet on 2026-11-07. Items marked **unverified** were not confirmed from source or a run.

## Start here

### What is in the repo

| Package | npm / import name | What it is |
| --- | --- | --- |
| `packages/core` | `@altpool/core` | Types (`FrameTx`, `RuleId`, `AdmissionReport`...), `DEVNET` constants, `altDevnet` chain, `gateway()` and `ethrex()` RPC clients, offline fixtures. |
| `packages/sdk` | `altpool` | viem extension: build, check, send, wait, admission report, staking, keyed nonces, recent roots, watchers, Wallet Bridge, wallet network helpers. |
| `packages/simulator` | `@altpool/simulator` | `checkAdmission`, `createSimulator`, routing, rule diagnosis, the `frame-doctor` CLI, vitest matchers, ERC-8421 conformance runner. |
| `packages/monitor` | `@altpool/monitor` | `watchEntity`, `entityStatus`, `entityReport`, `txReport`, network view, webhook alerts, the `watch-entity` CLI. |
| `packages/mcp` | `@altpool/mcp` | stdio MCP server: 11 tools, one resource, one prompt. |
| `packages/prover` | `@altpool/prover` | Tornado v2.0 note, Merkle path and Groth16 withdraw proof. |
| `packages/contracts` | `@altpool/contracts` | ExitRelay and PayRelayWETH sources, `exitTx`, `payTx`, deposit/send helpers, `deployments.json`. |
| `packages/wallet-bridge` | `@altpool/wallet-bridge` | `BridgeAccount.sol` (browser wallet controls a frame-tx account). Client API is in `altpool`. |
| `packages/falcon` | `@altpool/falcon` | Post-quantum (Falcon-512) account for the SDK. |
| `apps/quietsend` | `quietsend` CLI | `deposit`, `withdraw`. |
| `apps/demo` | `bun run demo` | Scripted live demo of the whole flow. |

### Install

Only `altpool` is published to npm. Everything else is a workspace package: clone the repo and import by package name from a script inside it.

```sh
npm i altpool viem @forshtat/hegota-support        # SDK only (Node and browser)

git clone https://github.com/Ansh-Sonkusare/altpool && cd altpool
bun install
bun run typecheck && bun run test                   # all packages
bun run smoke                                       # live devnet check (chain 1337, gateway, ethrex, explorer)
```

The codec, hashing and signing come from `@forshtat/hegota-support`. Altpool adds no second codec. Every example imports the codec profile explicitly: there is no default profile.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
```

### Agent quick start (MCP)

```sh
git clone https://github.com/Ansh-Sonkusare/altpool && cd altpool && bun install
claude mcp add altpool -- bun $PWD/packages/mcp/src/server.ts
```

Then ask the agent to "send 1 wei to 0x... on the alt mempool". It calls `agent_info`, `send_calls`, `wait_for_receipt`. Tools and schemas are in the MCP section below.

### Plain-text copies of these docs

- `/llms.txt`: short index (llms.txt convention).
- `/llms-full.txt`: this entire reference as Markdown.

## Recipes

Each recipe is a complete script. Run from inside the repo (for example save as `scratch/x.ts` inside `apps/demo`, then `bun x.ts`) so workspace imports resolve. They use throwaway keys. Recipes that send transactions need the devnet faucet to answer.

### A. Send a plain frame tx with a fresh key

Verified shape: this is `packages/sdk/scripts/live.ts` reduced to its core. The sender is an EOA that pays for itself: frame 0 is a self-VERIFY that approves execution and payment, frame 1 is the transfer.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, frame, newTx, secp256k1Placeholder } from "altpool";

const key = generatePrivateKey();                       // fresh, never reuse a published devnet key
const account = privateKeyToAccount(key);
const sidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile, name: "gateway" });
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
  .extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));
const ap = client.altpool;

await ap.assertCompatible();                            // throws ProfileMismatchError if chain or entry point differ

// 1. fund from the devnet faucet (skandha_explorer_faucet) and wait for the balance
const faucet = await ap.faucet(account.address);        // { txHash, amount }
for (let i = 0; i < 40 && (await client.getBalance({ address: account.address })) === 0n; i++)
  await new Promise((r) => setTimeout(r, 1500));

// 2. build: a fresh nonce key so several txs can be pending at once
const { nonceKeys, nonceSeq } = await ap.prepareNonceKeys({ sender: account.address });
const to = "0x000000000000000000000000000000000000dEaD";
const transaction = newTx({
  chainId: DEVNET.chainId, sender: account.address, nonceKeys, nonceSeq,
  frames: [
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
    // state gas: a transfer that creates the recipient account needs about 183,600 state gas
    frame(profile, "SENDER", { target: to, execution: 50_000n, state: 200_000n, value: 1n }),
  ],
  signatures: [secp256k1Placeholder(profile)],
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
});

// 3. predict, then send (prepare: true fills body-frame gas from the node's estimator and signs after)
const pre = await ap.preflightFrameTransaction({ transaction, signer: account });
console.log(pre.public.status, pre.alternative.status);        // "likely-admitted" | "likely-rejected" | "unknown"
const sent = await ap.sendFrameTransaction({ transaction, signer: account, prepare: true });
console.log("sent", sent.hash, ap.explorerLink(sent.hash));

// 4. wait and read what the node did
const { receipt } = await ap.waitForFrameTransactionReceipt({ hash: sent.hash });
console.log(receipt.status, receipt.frames.map((f) => f.status));
const report = await ap.getAdmissionReport({ hash: sent.hash });
console.log(report?.outcome, report?.failed);
sidecar.close();
```

Gotcha seen live: a signed self-paying tx from a fresh, unfunded key failed ethrex simulation with `VERIFY frame 0 ... failed: default code halted: RevertOpcode` (the cause was not isolated, but the key had no balance), so wait for the faucet before checking or sending. The gateway runs `bundlingMode: "manual"`: an admitted tx can sit in `New`; if `waitForFrameTransactionReceipt` times out, send through the miner sidecar (`DEVNET.minerSidecarUrl`) instead.

### B. Stake an entity and read its status

Staking is per `msg.sender`: an EOA stakes itself. `stakeEntity` simulates first and throws before sending on a misconfiguration.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, InsufficientStakeError } from "altpool";
import { entityStatus } from "@altpool/monitor";

const account = privateKeyToAccount(generatePrivateKey());
const sidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile, name: "gateway" });
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar }));
const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const ap = client.altpool;

await ap.faucet(account.address);
for (let i = 0; i < 40 && (await client.getBalance({ address: account.address })) === 0n; i++)
  await new Promise((r) => setTimeout(r, 1500));

const min = await ap.getMinimumStake();                 // { minStake, minUnstakeDelaySec, registry, node }
try {
  await ap.stakeEntity({ wallet, amount: min.minStake });          // must be STRICTLY above minStake
} catch (e) {
  if (e instanceof InsufficientStakeError) console.log(e.fix);      // "Stake more than 10000000000000000 wei."
}
const tx = await ap.stakeEntity({ wallet, amount: min.minStake + parseEther("0.002"), unstakeDelaySec: 86_400 });
await client.waitForTransactionReceipt({ hash: tx });

console.log(await ap.getEntityStake(account.address));  // { state: "staked", meetsMinimum: true, ... }
console.log(await ap.isEntityStaked(account.address));  // { staked: true, source: "node" | "contract", node }
const status = await entityStatus(account.address);     // stake + reputation + headroom + pending + inclusions
console.log(status.stake.isStaked, status.reputation.status, status.headroom);
sidecar.close();
```

Unstaking: `ap.unlockEntityStake({ wallet })`, wait `unstakeDelaySec`, then `ap.withdrawEntityStake({ wallet, to? })`. After `unlock` the node reports the entity as not staked immediately. A contract entity (a payer, ExitRelay) must call `addStake` from its own code; `stakeEntity({ entity })` refuses to stake for another address (`StakeConfigurationError`).

### C. Check admission before signing, then branch on the verdict

`checkAdmission` needs a transaction that is final and signed: an unsigned or placeholder-signed tx is rejected by ethrex with `frame signature list does not authenticate the sender` (observed live). Fill gas first, sign last.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, frame, newTx, secp256k1Placeholder, signFrameTransaction } from "altpool";
import { checkAdmission, routeFromReport, renderReport } from "@altpool/simulator";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const sidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, profile, name: "gateway" });
const ap = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar })).altpool;

const unsigned = newTx({
  chainId: DEVNET.chainId, sender: account.address, nonceKeys: [123n], nonceSeq: 0n,
  frames: [
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
    frame(profile, "SENDER", { target: "0x000000000000000000000000000000000000dEaD", execution: 50_000n, state: 200_000n, value: 1n }),
  ],
  signatures: [secp256k1Placeholder(profile)],
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
});
const tx = await signFrameTransaction(profile, unsigned, { privateKey: key });

const report = await checkAdmission(tx);
const alt = report.verdicts.alt;
if (alt.verdict === "admitted") {
  if (alt.source === "model") console.warn("alt verdict is our local rule model: unverified");
  const decision = routeFromReport(report);               // { target: "public" | "alt" | "none", node?, url?, reason, verified, fixes }
  console.log("send to", decision.target, decision.node ?? "");
} else {
  console.error(renderReport(report));                    // text with rule, entity, frame and fix
  console.error(alt.failed?.rule, alt.failed?.ercRule, alt.fix);
  // branch on the rule: "storage" -> stake the entity; "gas-limit"/"public-gas-cap" -> lower VERIFY; "simulation" -> read alt.error.revertReason
}
sidecar.close();
```

A real result, from running this recipe with an unfunded key on 2026-11-07, is shown in the `AdmissionReport` section below. Offline alternative with no network: `replaySimulator(fixture(...))`.

### D. Explain a rejected transaction hash with frame-doctor

From a shell. Admission records are node-local and in memory, so a hash that one node does not know may be known by the other (the tool asks the gateway and the miner by default).

```sh
bun packages/simulator/src/frame-doctor.ts 0x<txHash>            # explorer record + receipt, both sidecars
bun packages/simulator/src/frame-doctor.ts 0x<txHash> --node https://altmempool.forshtat.com/rpc -v   # one node, all rule checks
bun packages/simulator/src/frame-doctor.ts 0x<rawSignedTx> --json | jq '.verdicts.alt.fix'
bun packages/simulator/src/frame-doctor.ts --fixture public/29-ethrex_simulateFrameTransaction.json   # offline, no network
echo $?    # 0 admitted by some mempool, 1 none, 2 usage or RPC error
```

Programmatic, with the same data:

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, http } from "viem";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET } from "altpool";

const hash = "0x...";                                   // the rejected or stuck tx
for (const [name, httpUrl] of [["miner", DEVNET.minerSidecarUrl], ["gateway", DEVNET.gatewayUrl]] as const) {
  const sidecar = createAltMempoolClient({ httpUrl, profile, name, timeoutMs: 90_000 });
  const ap = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) })
    .extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl })).altpool;
  const r = await ap.getAdmissionReport({ hash });       // null if this node never saw it
  if (!r) { console.log(`${name}: no record`); continue; }
  console.log(`${name}: ${r.outcome}`, r.failed.map((c) => `${c.rule} frame ${c.frameIndex ?? "-"}`));
  if (r.explanation) console.log("rule:", r.explanation.rule, "\nfix:", r.explanation.fix, "\nrevert:", r.explanation.revertReason);
  sidecar.close();
}
```

Real output of `frame-doctor` on an included tx (the MCP README's agent transaction):

```text
frame-doctor 0xd3598e53ce6f3c31e99b69ace5e74870a6a920a35eab7ed489eaa8809298abd5
  alt    ✓ admitted    [explorer record]
  public · not checked for a sent tx (pass the raw tx to simulate it)
  status OnChain in block 11667, frames: ok, ok
  VERIFY gas used 100
  explorer https://explorer.altmempool.wtf/tx/0xd3598e53...?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc
  node https://altmempool.forshtat.com/rpc
```

And the offline fixture of a rejected paymaster that reads its own storage:

```text
frame-doctor 0xaecb2f60d93c16689ce678d9e956958a1bf256b7877db1f43e778922bf07ffdd
  public ✗ rejected  public-storage (STORAGE-010)  [node simulation]
         at: frame 1: 0x4b94…ed0c reads its own storage slot 0x906333e3…
         node: StorageReadNonSender
         fix: The public mempool lets VERIFY read only the sender's own storage. Send to the alt mempool with the reading entity staked.
  alt    ✗ rejected  storage (STORAGE-031..033) payer 0x4b94…ed0c frame 1  [local model, unverified]
         fix: Stake payer 0x4b94...ed0c in the staking registry (> 0.01 ETH, 1-day unstake delay), then resend to the alt mempool. ...
  VERIFY gas 97,200 (public cap 100,000, our pin 450,000)
  FOCIL ✗ not eligible  inclusion lists draw only on the public mempool, which rejects it (public-storage); ...
  route  nowhere (unverified)  public rejects public-storage (StorageReadNonSender); alt rejects storage
```

### E. QuietSend: deposit, then withdraw to a 0-ETH address through ExitRelay

Needs the prover artifacts once: `bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert` (about 70 MB of JSON). The same flow as `apps/quietsend/src/cli.ts`.

```ts
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";
import { createNote, noteToString, prove } from "@altpool/prover";
import { EXIT_FEE, deployments, depositNote, exitTx, explorerExit, sendExit } from "@altpool/contracts";
import { createSimulator, renderVerdict } from "@altpool/simulator";

const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });

// 1. deposit 0.1 ETH from a faucet-funded fresh key; keep the note secret
const depositor = privateKeyToAccount(generatePrivateKey());
await gateway().faucet(depositor.address);
for (let i = 0; i < 60 && (await pub.getBalance({ address: depositor.address })) < DEVNET.denomination + parseEther("0.01"); i++)
  await new Promise((r) => setTimeout(r, 2000));
const wallet = createWalletClient({ account: depositor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const note = createNote();
console.log("note (secret):", noteToString(note));
await depositNote(wallet, note);                        // pool.deposit(commitment) with value 0.1 ETH

// 2. a recipient with 0 ETH: it never signs or pays anything
const recipient: Address = privateKeyToAccount(generatePrivateKey()).address;
const exitRelay = deployments.exitRelay as Address;     // staked ExitRelay (relayer = ExitRelay, fee = EXIT_FEE = 0.01 ETH)

// 3. prove (minutes the first time: rebuilds the tree from Deposit events, then Groth16)
const proof = await prove(note, { recipient, relayer: exitRelay, fee: EXIT_FEE });   // WithdrawProof & { rootIdx }
const tx = exitTx(proof, { exitRelay });                // 3 frames, nonce key = nullifierHash, no signatures

// 4. check, submit to the MINER sidecar, wait
const report = await createSimulator({ explorer: false }).check(tx);
console.log(renderVerdict(report.verdicts.public).join("\n"));   // public: rejected (gas cap), expected
console.log(renderVerdict(report.verdicts.alt).join("\n"));
const result = await sendExit(tx);                      // submitFrameTransaction + waitForFrameTransactionReceipt, throws unless every frame succeeds
console.log(result.hash, result.frames);                // [{ status, gasUsed, stateGasUsed }, ...]
console.log("recipient", formatEther(await pub.getBalance({ address: recipient })), "ETH");   // 0.09
console.log(explorerExit(result.hash));                 // link with ?node=<miner>
```

CLI equivalent: `quietsend deposit` then `quietsend withdraw <note> [recipient]`. Variants: `exitTxRR` (ExitRelayRR, reads the pool root through EIP-8272 recent roots) and the WETH pool (`depositNoteWeth`, `exitTx(..., { pool })`). See the Contracts section.

### F. Pledge Paid: build a nine-frame payment with `payTx`

`payTx` withdraws from the WETH Tornado pool to a Settler contract whose address is fixed by the invoice terms, then deploys it, unwraps WETH, swaps to the invoice token, marks the InvoiceBook paid and sweeps the change, all in one atomic batch behind the paid withdrawal. Read the argument shape below: `terms.maxIn` is a price quote you must supply, and the proof's `recipient` must equal the Settler address.

```ts
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";
import { createNote, prove } from "@altpool/prover";
import { EXIT_FEE, deployments, depositNoteWeth, payTx, sendExit, settlerAddress, settlerFactoryAbi, type Terms } from "@altpool/contracts";
import { checkAdmission } from "@altpool/simulator";

const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const { payRelayWETH, settlerFactory, invoiceBook, wethPool } = deployments as Record<string, Address>;

// invoiceId comes from InvoiceBook.create(payee, token, amount) (event Created). amount is in the invoice token's units.
// maxIn = the most WETH the swap may spend (quote it, add slippage). packages/contracts/scripts/pledge.ts prices it with the Uniswap v4 quoter.
const terms: Terms = {
  invoiceId: 1n,
  book: invoiceBook,
  amount: 5_000_000n,                                   // invoice amount, token units
  maxIn: 3_000_000_000_000_000n,                        // wei of WETH
  change: privateKeyToAccount(generatePrivateKey()).address,   // fresh address that receives the change
};

const settlerCodeHash = await pub.readContract({ address: settlerFactory, abi: settlerFactoryAbi, functionName: "settlerCodeHash" });
const settler = settlerAddress(settlerFactory, settlerCodeHash, terms);   // CREATE2 address, known before it exists
// optional cross-check: factory.addressOf(terms) must equal settler

// deposit 0.1 WETH into the WETH pool from a funded key, then prove with recipient = settler, relayer = payRelayWETH, refund = 0
const donor = privateKeyToAccount(generatePrivateKey());
await gateway().faucet(donor.address);                  // then wait for the balance, as in recipe E
const wallet = createWalletClient({ account: donor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const note = createNote();
await depositNoteWeth(wallet, note, wethPool);          // wrap, approve, deposit

const proof = await prove(note, { recipient: settler, relayer: payRelayWETH, fee: EXIT_FEE, refund: 0n }, wethPool);
const tx = payTx(proof, { payRelay: payRelayWETH, pool: wethPool, factory: settlerFactory, settlerCodeHash, terms });

console.log((await checkAdmission(tx)).verdicts.alt);   // check before sending
const result = await sendExit(tx);                      // nine frames; throws unless every frame succeeded
```

`payTx(p, o)` arguments:

| Argument | Type | Meaning |
| --- | --- | --- |
| `p` | `WithdrawProof & { rootIdx: number }` | From `prove(note, to, wethPool)`. `p.recipient` must equal `settlerAddress(...)`, `p.relayer` must equal `o.payRelay`, `p.refund` must be 0. Each mismatch throws `Error`. |
| `o.payRelay` | `Address` | The staked PayRelayWETH contract (`deployments.payRelayWETH`). It is the tx sender and payer. |
| `o.pool` | `Address` | The WETH Tornado pool (`deployments.wethPool`). |
| `o.factory` | `Address` | `SettlerFactory` (`deployments.settlerFactory`). |
| `o.settlerCodeHash` | `Hex` | `factory.settlerCodeHash()`. |
| `o.terms` | `Terms` | `{ invoiceId: bigint, book: Address, amount: bigint, maxIn: bigint, change: Address }`. ABI-encoded length 160. |
| `o.nonceSeq` | `bigint` (default `0n`) | Nonce key is the nullifier hash. The contract allows `nonceSeq <= 2`, for retries of a note whose key was consumed. |
| `o.maxFeePerGas` | `bigint` (default `EXIT_FEE / PAY_GAS_BUDGET`) | Keeps `max_cost <= fee`. |
| `o.maxPriorityFeePerGas` | `bigint` (default `1_000_000n`) | The site passes the node tip capped at the fee cap. |
| `o.nowSec` | `number` | Clock override for the expiry deadline (600 s grid). |

Returns a `FrameTx` with nine frames and no signatures (see the Contracts section for the frame table). A failure inside frames 3 to 7 (for example the invoice was already paid) rolls that batch back, but the withdrawal in frame 2 is kept: the WETH is parked at the code-less Settler address. Anyone can then call `SettlerFactory.deploy(terms)` and `settler.refund()` (it requires the invoice to be paid) to send every balance to `terms.change`. `packages/contracts/scripts/pledge.ts` does exactly this in `rescue()`.

### G. Watch an entity and alert through a webhook

```ts
import { watchEntity, webhookAlerts } from "@altpool/monitor";
import type { Address } from "@altpool/core";

const entity = "0x9b1f934ac769ebfa3fec40eb72d2b4c932166ca1" as Address;   // PayRelayWETH
const stop = watchEntity(entity, {
  feePerTx: 10n ** 16n,                                 // what it earns per tx (EXIT_FEE), for the margin line
  throttleWarnAt: 20,
  lowBalanceAt: 5,
  ...webhookAlerts(entity, [process.env.WEBHOOK_URL!], { label: "PayRelayWETH", mute: ["rejected"] }),
  onStatus: (s) => console.log(s.reputation.status, `headroom ${s.headroom.untilThrottled}`, `balance ${s.funds.balance}`),
  onError: console.error,
});
// later: stop();
```

`webhookAlerts` POSTs JSON `{ content, text, kind, entity, label, message, hash?, at }` per event: `content` for Discord, `text` for Slack or Telegram `sendMessage?chat_id=...`. Delivery failures never throw. CLI: `watch-entity 0x... --alert-webhook <url>`.

### H. Wallet Bridge from a browser wallet (Mode A and Mode B)

A BridgeAccount is a contract account whose VERIFY frame recovers an EIP-712 signature. Deploy one with `bun run --filter @altpool/wallet-bridge deploy` (or the "Deploy one for me" button on /wallet). The code below runs in a browser with MetaMask or Rabby; the same page is live at /wallet.

```ts
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, createWalletClient, custom, http, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altDevnet, altpoolActions, bridgeAccount, connectAltDevnet, createAltMempoolClient, DEVNET, typedDataSigner } from "altpool";

const sidecar = createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, profile, name: "miner", timeoutMs: 60_000 });
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const ap = pub.extend(altpoolActions({ sidecar })).altpool;

const wallet = createWalletClient({ chain: altDevnet, transport: custom((window as any).ethereum) });
const [owner] = await wallet.requestAddresses();
await connectAltDevnet(wallet, { client: pub });         // switch/add chain 1337, then compare heads (rejects MetaMask's "Localhost 8545")

const account = "0xYourBridgeAccount" as Address;
const bridge = bridgeAccount({ address: account, owner, profile });

// Mode A: one wallet popup per transaction. prepare: false (the default): never ask a person to sign an estimation probe.
const { tx } = await bridge.prepareTx({ client: pub, sidecar, calls: [{ to: "0x000000000000000000000000000000000000dEaD", value: 1n }] });
const a = await ap.sendFrameTransaction({ transaction: tx, signer: typedDataSigner(wallet, bridge, owner) });
await ap.waitForFrameTransactionReceipt({ hash: a.hash });

// Mode B: one popup authorises a session; a local key then signs natively, many times
const sessionKey = generatePrivateKey();
const session = {
  key: privateKeyToAccount(sessionKey).address,
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
  maxValuePerTx: parseEther("0.001"),
  maxCostPerTx: parseEther("0.005"),                    // bounds gas x maxFeePerGas so a leaked key cannot burn the balance on fees
  target: "0x0000000000000000000000000000000000000000" as Address,   // zero = any target
};
const ownerSignature = await wallet.signTypedData({ account: owner, ...bridge.authorizeSession(session) });
const stx = await bridge.prepareSessionTx({ client: pub, sidecar, session, ownerSignature, calls: [{ to: "0x000000000000000000000000000000000000dEaD", value: 1n }] });
const b = await ap.sendFrameTransaction({ transaction: stx, signer: { privateKey: sessionKey } });
```

If a Mode A send throws `InteractiveSignerError`, you passed `prepare: true`. `/wallet` can also export the session for an agent (`ALTPOOL_SESSION`), see the MCP section.

## SDK reference (`altpool`)

### Setup: `createAltMempoolClient` and `altpoolActions`

```ts
function createAltMempoolClient(cfg: AltMempoolClientConfig): AltMempoolClient

interface AltMempoolClientConfig {
  httpUrl: string;            // sidecar JSON-RPC, e.g. DEVNET.gatewayUrl
  webSocketUrl?: string;      // same path with ws/wss; needed for subscriptions (watch* helpers). Without it hasWebSocket() is false
  profile: Profile;           // explicit codec profile, no default
  name?: string;              // carried on every node-local answer; default: the URL host
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  timeoutMs?: number;         // per-request limit. The miner sidecar can be slow: the site uses 90_000
  trace?: ...; ws?: ...;
}

function altpoolActions(opts: {
  sidecar: AltMempoolClient;                         // default alt-mempool node
  mempools?: Record<string, AltMempoolClient>;       // other named nodes; picking a mempool = picking a node
  precheck?: AdmissionChecker;                       // default checker for preflight / submit({ precheck: true })
  explorerUrl?: string;                              // for explorerLink() and report links
}): (client: Client) => { altpool: AltpoolActions }
```

Usage: `createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar })).altpool`. Throws `ProfileMismatchError` at extend time if two mempools use different profiles. `mempool` arguments below take a configured name (the sidecar's `name`, or `"alt"` for the default); `"public"` is accepted by `submitFrameTransaction` and `sendFrameTransaction` only and goes through ethrex `eth_sendRawTransaction`. An unknown name throws `UnsupportedCapabilityError`.

`AltMempoolClient` also exposes raw methods: `request(method, params)`, `getConfig`, `getExplorerInfo`, `getGasPrice`, `getConnectedPeers`, `estimateFrameTransactionGas`, `sendFrameTransaction`, `getFrameTransaction`, `getFrameTransactionReceipt`, `getTransactionStatus`, `listTransactions`, `listAdmissions`, `getExplorerTransaction`, `listReputation`, `faucet`, `getNodeStakeStatus`, `subscribe`, `hasWebSocket`, `close`.

### Building a transaction

Re-exported from `@forshtat/hegota-support/tx`: `newTx`, `frame`, `secp256k1Placeholder`, `sigHash`, `txHash`, `encodeTx`, `decodeTx`, `signTx`, `approveScope`, `frameMode`, `sigScheme`, `encodeRecentRootData`, `toWire`, `explainRejection`, `MAX_RECENT_ROOT_REFERENCES`.

```ts
interface FrameTx {
  chainId: bigint;
  nonceKeys: bigint[];            // EIP-8250 keyed nonces. [0n] is the sender's linear account nonce. 1 to 16 strictly increasing keys
  nonceSeq: bigint;               // must equal every key's current sequence
  sender: Address;
  frames: Frame[];
  signatures: SignatureEntry[];
  fees: { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; maxFeePerBlobGas: bigint };  // blob fee must be 0 on this profile
  blobVersionedHashes: Hex[];
  recentRootReferences: RecentRootReference[];     // EIP-8272 early revision: { sourceId: Hex; slot: bigint; root: Hex }
}
interface Frame {
  mode: number;                   // profile.frameModes: DEFAULT 0, VERIFY 1, SENDER 2
  flags: number;                  // bits 0-1 approve scope (NONE 0, PAYMENT 1, EXECUTION 2, EXECUTION_AND_PAYMENT 3); ATOMIC_BATCH 0x4
  target: Address | null;         // null = the tx sender
  limits: { execution: bigint; state: bigint };    // gas / state gas limits (state gas is EIP-8037)
  value: bigint;
  data: Hex;
}
interface SignatureEntry { scheme: number; signer: Hex; msg: Hex; signature: Hex }  // schemes: ARBITRARY 0, SECP256K1 1, P256 2; "0x" msg = covers SIG_HASH

newTx(init: { chainId: bigint | number; sender: Address; frames: Frame[]; signatures: SignatureEntry[]; nonceSeq: bigint;
              nonceKeys?: bigint[] /* default [0n] */; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint /* default = maxFeePerGas */ } }): FrameTx
frame(profile, mode: "VERIFY" | "SENDER" | "DEFAULT" | ..., init: {
  target?: Address | null;        // default null = sender
  execution: bigint;              // required
  state?: bigint; value?: bigint; data?: Hex;
  flags?: number;                 // raw bits, ORed with scope
  scope?: "NONE" | "PAYMENT" | "EXECUTION" | "EXECUTION_AND_PAYMENT";
}): Frame
secp256k1Placeholder(profile, signer?: Hex): SignatureEntry    // filled in by signing
```

Helpers in `altpool`: `validationPrefixLength(profile, tx)`, `describeFrames(profile, tx)` (index, mode, scope, flags, target, value, limits, dataBytes, inPrefix), `maxGasCost(tx)` (sum of all limits times `maxFeePerGas`), `replacementFees(profile, fees)` (both fees +10%, rounded up), `frameTxHash`, `encodeFrameTx`, `fromWire(w)` (wire JSON to `FrameTx`), `estimationProbe(profile, tx)`.

`FrameSigner` (the `signer` parameter everywhere):

| Form | Use |
| --- | --- |
| `{ privateKey: Hex }` | Delegates to `signTx`. |
| `{ sign({ hash }) }` | A viem `LocalAccount` (raw 32-byte digest). Re-packed as `v \|\| r \|\| s`. `signMessage` (EIP-191) does not work. |
| `{ signFrame({ profile, tx, index }), interactive?: boolean }` | Fills an entry itself (`typedDataSigner`, `falconSigner`). `interactive: true` means a person is prompted; the SDK then never signs an estimation probe or simulation copy with it (`InteractiveSignerError`). |

### `client.altpool` actions

All actions are on `client.altpool`; every one is also exported standalone (`getEntityStake(client, params, addr)`, `preflightFrameTransaction(client, sidecar, args)`...).

#### Node

| Action | Parameters | Returns |
| --- | --- | --- |
| `getConfig(mempool?)` | name | `SidecarConfig`: `chainId, entryPoints, canonicalEntryPoint, relayers, minStake, minUnstakeDelaySec, stakingRegistry, reputation { minInclusionDenominator, throttlingSlack, banSlack }, validationGasLimit, txGasLimit, precompiles, standardMempoolId, supportedMempools, flags, raw`. |
| `getExplorerInfo(mempool?)` | name | `ExplorerInfo { protocolVersion, chainId, version, commit, bundlingMode, p2pEnabled, latestSeq, oldestSeq, historyCapacity, bootId, faucetEnabled }`. Throws `UnsupportedCapabilityError("explorer")` if the node runs without `--explorer.enable`. |
| `getMempoolInfo(mempool?)` | name | `Capabilities` (below). |
| `assertCompatible(mempool?)` | name | `Capabilities`, or throws `ProfileMismatchError` when execution chain, sidecar chain and profile disagree, or the entry point differs. |
| `getGasPrice(mempool?)` | name | `{ maxFeePerGas, maxPriorityFeePerGas }` (bigint) from `skandha_getGasPrice`. |
| `getConnectedPeers(mempool?)` | name | `unknown[]`. |
| `faucet(address, mempool?)` | address | `{ txHash: Hex; amount: string }` (`skandha_explorer_faucet`). Throws if the faucet is disabled. The balance arrives a few seconds later: poll it. |
| `mempool(name)`, `mempoolNames()`, `explorerLink(hash)` | | The client for a name; `["public", ...names]`; `${explorerUrl}/tx/${hash}` or `undefined`. |

```ts
interface Capabilities {
  chainId: { execution: number; sidecar: number; profile?: number; match: boolean };
  sidecar: { version?: string; protocolVersion?: number; commit?: string; bootId?: string; bundlingMode?: string };
  profile: { id: string; status: string; entryPointMatches: boolean; supportedBySdk: boolean };
  explorer: { enabled: boolean; historyCapacity?: number; inMemory: true; faucet: boolean };
  p2p: { enabled?: boolean; peers?: number };
  websocket: boolean;           // false unless webSocketUrl was configured
  staking: { registry?: Address; minStake: bigint; minUnstakeDelaySec: number };
  mempools: { mempoolId: string; entryPoint: Address }[];
  validationGasLimit?: bigint; txGasLimit?: bigint;
  warnings: string[]; config: SidecarConfig; info?: ExplorerInfo;
}
```

Real result against the gateway (2026-11-07): `chainId {1337,1337,1337,match:true}`, `sidecar { version: "v4.1.1", protocolVersion: 1, bundlingMode: "manual" }`, `staking { registry: 0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f, minStake: 10000000000000000n, minUnstakeDelaySec: 0 }`, `validationGasLimit 10000000n`, `txGasLimit 25000000n`, `explorer { enabled: true, historyCapacity: 10000, faucet: true }`, `p2p.peers 0`, `websocket false`. The call took about 1.6 s.

#### Transactions

| Action | Parameters | Returns / throws |
| --- | --- | --- |
| `estimateFrameTransactionGas({ transaction, signer?, margin?, mempool? })` | `margin: { percent: bigint; min: bigint; allowShrink?: boolean }` (default `{ 20n, 10_000n, false }`) | `FrameGasReport { frames: FrameGasRow[]; cumulativeGasUsed; fees; margin; totalLimit; estimate }`. Each `FrameGasRow`: `index, mode, inPrefix, declared, measured, suggested, autoEstimated, headroom?`. Prefix (VERIFY) frames keep their declared limits (`autoEstimated: false`). The signer signs a probe with 10,000,000 limits; interactive signers throw `InteractiveSignerError`. |
| `prepareFrameTransaction({ transaction, signer?, margin?, fees?: "node" \| "keep", feeMultiplierPercent?, mempool? })` | `fees` default `"node"`: replaces fees with the node gas price times `feeMultiplierPercent` (default 100) | `{ transaction (UNSIGNED, limits applied), gas: FrameGasReport }`. Sign again after. |
| `signFrameTransaction({ transaction, signer, index? })` | `index` = signature entry (default 0) | signed `FrameTx`. |
| `submitFrameTransaction({ transaction, mempool?, precheck? })` | `mempool` default `"alt"`; `precheck: true` uses `opts.precheck`, or pass an `AdmissionChecker` | `SubmitResult { hash, localHash, hashMatches, mempool, node }`. `hashMatches: false` means node and codec disagree on the bytes (profile problem). Never retried. With `precheck`, throws `FrameAdmissionError` (`.detail.kind === "ruleViolation"`, `.fix` from the verdict) if the checker predicts rejection. |
| `sendFrameTransaction({ transaction, signer, prepare?, margin?, mempool?, precheck? })` | `prepare: true` = estimate then sign then submit | `SubmitResult & { transaction: FrameTx; gas?: FrameGasReport }`. |
| `getFrameTransaction({ hash, mempool? })` | | `MempoolEntry { hash, sender, payer?, nonceSeq, nonceKeys, status, frameCount, maxFeePerGas, submittedAt?, updatedAt?, source?, tx? }` or `null`. |
| `getFrameTransactionReceipt({ hash, mempool? })` | | `FrameReceipt` or `null` while not mined. |
| `getTransactionStatus({ hash, mempool? })` | | `FrameTxStatus` or `null`. |
| `simulateFrameTransaction({ transaction, trace? })` | signed tx | `PublicSimulation` from `ethrex_simulateFrameTransaction`. |
| `waitForFrameTransactionReceipt({ hash, mempool?, timeoutMs?, pollingIntervalMs?, throwOnRevert? })` | timeout default 120000, poll 2000 | `{ receipt: FrameReceipt; status: FrameTxStatus \| null }`. Asks the sidecar, then ethrex (the sidecar can lag the chain by minutes). Throws `ReceiptTimeoutError` on timeout, `AltpoolSdkError` if the tx is `Cancelled`/`Reverted` without a receipt or `throwOnRevert` and the tx failed. A frame can fail inside a successful tx: check `receipt.frames`. |

```ts
type TxStatus = "New" | "Pending" | "Submitted" | "OnChain" | "Finalized" | "Cancelled" | "Reverted";   // FINAL_STATUSES: OnChain, Finalized, Cancelled, Reverted
interface FrameTxStatus { hash: Hex; status: TxStatus; sender: Address; payer?: Address; factory?: Address;
  transaction?: Hex /* on-chain tx hash once submitted */; reason?: string; tx?: FrameTx; node: NodeIdentity; raw: unknown }
type FrameOutcome = "success" | "reverted" | "failure" | "skipped";
interface FrameReceipt {
  hash: Hex; status: "success" | "reverted"; payer?: Address;
  blockNumber?: bigint; blockHash?: Hex; cumulativeGasUsed: bigint; gasUsed?: bigint; effectiveGasPrice?: bigint;
  frames: { index: number; status: FrameOutcome; gasUsed: { execution: bigint; state: bigint }; logs: unknown[] }[];
  source: "sidecar" | "execution"; raw: unknown;
}
interface PublicSimulation { valid: boolean; violation?: string; prefixShape?: string; payer?: Address; maxCost?: bigint; gasUsed?: bigint;
  frames?: { gasUsed: bigint; succeeded: boolean }[]; executionStatus?: string; executionError?: string; trace?: unknown[]; raw: unknown }
```

Live `ethrex_simulateFrameTransaction` names the fields `canonicalMempoolValid` / `canonicalMempoolViolation`; the SDK accepts both.

#### Admission

| Action | Parameters | Returns |
| --- | --- | --- |
| `preflightFrameTransaction({ transaction, signer?, precheck?, margin?, reputationPages?, mempool? })` | Never submits. Signs copies locally only if `signer` is given. `reputationPages` default 3 (0 skips) | `PreflightResult` (below). |
| `getAdmissionReport({ hash, mempool? })` | | `AdmissionReportView` or `null`. |
| `explainAdmissionFailure(errorOrRecord)` | an `AltpoolSdkError` or `AdmissionRecord` | `Explanation { rule, status: "fail", entity?, frameIndex?, message, revertReason?, fix?, source: "rpc-error" \| "explorer" }`. |
| `compareMempoolProfiles(a, b)` | two mempool names | `{ a, b, rows: { parameter, a, b, same }[], differences }`. |

```ts
interface PreflightResult {
  transactionHash: Hex; profile: string;
  public: MempoolPrediction; alternative: MempoolPrediction;     // { mempool, kind: "prediction", status: "likely-admitted" | "likely-rejected" | "unknown", checks }
  gas?: FrameGasReport; simulation?: PublicSimulation; notes: string[];
}
interface PreflightCheck {
  stage: "structure" | "estimate" | "simulate" | "stake" | "reputation" | "mempool" | "recent-root" | "precheck";
  rule: RuleId | string; status: "pass" | "fail" | "unknown";
  entity?: { role: "sender" | "payer" | "factory"; address?: Address }; frameIndex?: number;
  message: string; fix?: string;
  source: "local" | "sidecar-estimate" | "ethrex-simulate" | "contract" | "node-reputation" | "node-mempool" | "precheck" | "explorer";
  node?: string;
}
interface AdmissionReportView {            // what a node actually did (kind: "actual"), vs preflight (a prediction)
  hash: Hex; kind: "actual";
  outcome: "accepted" | "rejected" | "included" | "replaced" | "dropped" | "unknown";
  errorCode?: number; source?: string /* "rpc" | "gossip:<peer>" | "sync:<peer>" */; at?: Date;
  checks: { rule: RuleId; verdict: "pass" | "fail" | "skipped"; status: "pass" | "fail" | "unknown"; frameIndex?: number; entity?: EntityRole; detail?: string }[];
  failed: ExplorerRuleCheck[];             // the checks with status "fail"
  events: { seq: number; hash: Hex; at: Date; kind: "admitted" | "rejected" | "replaced" | "statusChanged" | "dropped" | "included"; status?: TxStatus; reason?: string }[];
  frameStatuses?: FrameOutcome[]; explanation?: Explanation; node: NodeIdentity; explorerUrl?: string; raw: unknown;
}
```

Real report for the included agent tx on the miner (`getAdmissionReport`, 2026-11-07): `outcome: "included"`, `source: "rpc"`, 17 checks all `pass` (`gas-limit, recent-root, prefix, structure, signature, simulation, trace-alignment, OP-061, execution`, then per entity `payer` frame 0: `trace-alignment, out-of-gas, OP-011, create, storage, COD-010, entrypoint-access`, then `mempool`), `failed: []`, events `admitted` (status `New`) then later status changes.

#### Staking

| Action | Parameters | Returns / throws |
| --- | --- | --- |
| `getStakingParameters()` / `getMinimumStake()` | | `{ minStake: bigint, minUnstakeDelaySec: number, registry: Address, node }`. Throws `StakeConfigurationError` if the node reports no staking registry. Both read `skandha_config`. |
| `getEntityStake(entity)` | | `EntityStake { entity, amount, unstakeDelaySec, withdrawTime, state: "none" \| "staked" \| "unlocking" \| "withdrawable", meetsMinimum, isContract, params }`. `meetsMinimum` = staked and `amount > minStake` and delay `>=` minimum. |
| `isEntityStaked(entity)` | | `{ staked: boolean; source: "node" \| "contract"; node: string }`: the node's own verdict if its debug API answers, else the registry read. |
| `stakeEntity({ amount, unstakeDelaySec?, entity?, wallet? })` | `amount` wei, must be `> minStake`; delay default = node minimum; `wallet` = a viem wallet client for the entity itself (default: the extended client) | tx hash. Throws `InsufficientStakeError` (`.fix`: `Stake more than <minStake> wei.`), `StakeConfigurationError` (delay below minimum, or `entity` is not the wallet's address). Simulated first. |
| `unlockEntityStake({ wallet?, entity? })` | | tx hash. The entity stops counting as staked at once. |
| `withdrawEntityStake({ wallet?, to?, entity? })` | | tx hash. Only after `withdrawTime`. |
| `watchEntityStake({ entity, onChange, onError?, intervalMs? })` | default 6000 ms | `Promise<Unwatch>`; emits `EntityStake` when amount, delay, withdrawTime or state change. |

#### Keyed nonces (EIP-8250)

| Action | Parameters | Returns |
| --- | --- | --- |
| `prepareNonceKeys({ sender, keys?, mempool?, checkPending? })` | no `keys`: one fresh random 192-bit key; keys are sorted and validated; `checkPending: false` skips the pending scan | `PreparedNonceKeys { nonceKeys, nonceSeq, sequence, conflicts: { hash, keys, nonceSeq, status }[], checks }`. Throws `NonceConflictError` for invalid keys or keys at different sequences. `conflicts` lists pending txs on this node that hold a key (node-local view). |
| `getKeyedNonce({ sender, key, blockTag? })` | | `{ sender, key, seq, fresh, exhausted, source: "accountNonce" \| "nonceManager" }`. Key 0 is the account nonce; other keys are read from NONCE_MANAGER (`0x...8250`) storage at `keccak256(pad32(sender) \|\| key)`. |
| `getNonceSequence({ sender, keys, blockTag? })` | | `{ keys: KeyedNonce[]; nonceSeq?; consistent }`. |
| `validateNonceKeys(keys)` | | `{ rule, status, message }[]`. 1 to 16 entries, strictly increasing, key 0 only alone. |

Exported without a client: `randomNonceKey()`, `nonceSlot(sender, key)`, `MAX_NONCE_SEQ`. A note about QuietSend: the nonce key of an exit is the note's `nullifierHash`, so a withdrawn note's key is consumed and replays fail with `Nonce mismatch: expected 1, got 0`.

#### Recent roots (EIP-8272, early revision)

`getCurrentSlot()` returns `{ currentSlot, headSlot, blockNumber }`. `recentRootSourceId(source, salt)`, `encodeRecentRootWrite(salt, root)` (64 bytes, `salt || root`; the source is `msg.sender`), `verifyRecentRootPredeploy()` (`{ address, ok, codeHash? }`), `getRecentRoot(ref)`, `validateRecentRootReferences(refs)` (`{ ok, currentSlot, checks }`), `prepareRecentRootReferences({ transaction, references })` (sets and sorts `recentRootReferences`). A root written in slot S is usable from S+1 for 8191 slots; at most 16 references. The predeploy `0x...8272` is write-only.

#### Monitoring (WebSocket needed except where noted)

| Action | Parameters | Notes |
| --- | --- | --- |
| `watchExplorerEvents({ onEvent, onReset?, onError?, sinceSeq?, hashes?, mempool? })` | | Lifecycle stream `LifecycleEvent`. Resumes from the last seq after a reconnect. Needs `webSocketUrl` (else `UnsupportedCapabilityError("websocket")`). Returns `Unwatch`. |
| `watchPendingTransactions(onEvent, onError?, mempool?)`, `watchSubmittedTransactions`, `watchOnChainTransactions` | | `MempoolEvent { kind: "pending" \| "submitted" \| "onChain"; hash, tx?, sender?, payer?, factory?, transaction?, status?, revertReason?, node, raw }`. |
| `watchTransaction({ hash, onUpdate, onError?, pollingIntervalMs?, transport?: "auto" \| "poll", mempool? })` | | Follows to a final status then fetches the receipt. `TransactionUpdate { hash, status?, previous?, event?, statusResult?, receipt?, final, via: "ws" \| "poll" }`. Polling always runs, so it works without WebSocket. |
| `getEntityReputation({ address, mempool?, maxPages? })` | maxPages default 5 | `ReputationEntry { address, opsSeen, opsIncluded, status: "ok" \| "throttled" \| "banned", isWhitelisted, isBlacklisted, stake, unstakeDelaySec, withdrawTime, isStaked, node }` or `null`. Node-local. |
| `watchEntityReputation({ address, onChange, onError?, intervalMs?, maxPages?, mempool? })` | default 5000 ms; polling | `ReputationUpdate { address, entry, headroom?, node }` when it changes. |

### Errors

Every error extends `AltpoolSdkError { message, rpc?: { method, url, code, message, data, raw, params }, detail?: AltpoolError, fix?: string, cause? }`. `decodeRpcError(info, kind)` maps a node reply to a class. Submissions are never retried.

| Class | Thrown when | `.detail.kind` | Typical `.fix` |
| --- | --- | --- | --- |
| `TransportError` | node unreachable, timed out, no JSON (no `rpc.code`) | `rpc` | |
| `UnsupportedCapabilityError` | code -32601, a missing explorer, no WebSocket, unknown mempool name; has `.capability` | | |
| `FrameSignatureError` | code -32507 | `signature` | "Re-sign after the last change to frames, fees or nonce: the signature hash covers all of them." |
| `FrameAdmissionError` | a rule rejected it: reputation (`... is throttled/banned`), banned opcode, storage, prefix, gas cap, decode (`Error decoding field`), or `precheck` predicted a rejection | `reputation`, `ruleViolation`, `decode` | per rule: "The entity reads storage it does not own. Stake that entity ...", "Validation used a banned opcode ...", "The public mempool caps the validation prefix at 100,000 gas. ..." |
| `FrameSimulationError` | `validation frame N: reverted [with data 0x...]` | `validationReverted` (`frameIndex`, `revertReason` decoded from `Error(string)`) | "A validation frame reverted. Decode the revert reason and fix the state or calldata it checks." |
| `NonceConflictError` | key held by a pending tx, replacement fee too low, nonce mismatch, bad key set | `nonceKeyHeld`, `replacementUnderpriced`, `rpc` | "Another pending tx holds this nonce key. Use a fresh key, wait for it to land, or replace it with +10% on both fees." / "Bump both maxFeePerGas and maxPriorityFeePerGas by at least 10% (see replacementFees())." |
| `RecentRootExpiredError` | message mentions `recent-root` or `EIP-8272` | `recentRoot` | "Reference a root that is committed, at a slot before the current one and within the usable window." |
| `AltMempoolRpcError` | any other node error | `rpc` | |
| `InsufficientStakeError` | `stakeEntity` amount not above `minStake` | | "Stake more than N wei." |
| `StakeConfigurationError` | no registry, delay below minimum, staking for another address | | |
| `ProfileMismatchError` | chain, entry point or profile ids disagree | | |
| `ReceiptTimeoutError` | `waitForFrameTransactionReceipt` timed out | | |
| `InteractiveSignerError` | an estimation probe would be signed by a wallet-popup signer | | "For a BridgeAccount use bridge.prepareTx ..., then sign once with prepare: false." |
| `WrongNetworkError` | wallet on another chain, or another chain sharing id 1337 | | "In the wallet, remove or rename the other chain-1337 network (MetaMask's Localhost 8545), then add <rpc>." |
| `SubscriptionError` | a WebSocket subscription failed | | |

```ts
import { AltpoolSdkError, FrameAdmissionError, explainAdmissionFailure } from "altpool";
try {
  await ap.sendFrameTransaction({ transaction, signer, prepare: true });
} catch (e) {
  if (e instanceof AltpoolSdkError) {
    console.error(e.name, e.message);
    console.error("fix:", e.fix);                       // one line: what to do next
    console.error("rpc:", e.rpc?.code, e.rpc?.method);   // -32500 validation, -32502 rule, -32504 reputation, -32507 signature, ...
    console.error(explainAdmissionFailure(e));           // { rule, entity, frameIndex, revertReason, fix }
  }
}
```

JSON-RPC codes mapped (pinned to captured devnet strings): `-32000` decode, `-32507` signature, `-32502` rule violation, `-32500` validation reverted or recent root, `-32504` reputation, `-32602` nonce key held or replacement underpriced, `-32601` method missing.

### Wallet network helpers

`checkWalletNetwork(wallet, { client, chain?, maxBlockDrift? })` (read-only; throws `WrongNetworkError` unless the wallet's chain id is 1337 and its head is within `maxBlockDrift` blocks, default 20, of the devnet's) and `connectAltDevnet(wallet, { client, chain?, maxBlockDrift? })` (switch, add the chain if unknown, then check). Both return `{ chainId, walletBlock, devnetBlock }`.

## Core reference (`@altpool/core`)

```ts
const DEVNET = {
  chainId: 1337,
  gatewayUrl: "https://altmempoolgateway.forshtat.com/rpc",   // env GATEWAY_URL
  ethrexUrl: "https://altmempool.forshtat.com",               // env ETHREX_URL
  minerSidecarUrl: "https://altmempool.forshtat.com/rpc",     // env MINER_SIDECAR_URL
  explorerUrl: "https://explorer.altmempool.wtf",
  profile: "ethrex-eip8141-tracer",
  pool: "0xF8d72424D07721aB219cdbd2852657F3301673fC",          // Tornado 0.1 ETH, unmodified
  verifier: "0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01",
  hasher: "0x4500a5B572903a1DE1615d13A366cF2B324675E2",        // MiMCSponge
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
  withdrawSelector: "0x21a0adb6",
  denomination: 10n ** 17n, treeLevels: 20, rootHistorySize: 100,
  minStakeWei: 10n ** 16n,       // stake STRICTLY more than this
  unstakeDelaySec: 86_400,
  publicVerifyGasCap: 100_000n,  // ethrex MAX_VERIFY_GAS, still enforced on the public mempool
  verifyGasMax: 450_000n,        // our own pin for ExitRelay VERIFY, not a protocol limit
  reputation: { minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 },
};
altDevnet            // viem chain: id 1337, rpc DEVNET.ethrexUrl, explorer DEVNET.explorerUrl
explorerTx(hash)     // `${explorerUrl}/tx/${hash}`
gateway(url?)        // raw sidecar calls: sendFrameTransaction, estimateFrameTransactionGas, faucet, txStatus, admission, listReputation, explorerInfo, receipt
ethrex(url?)         // simulateFrameTransaction(raw, trace?), sendRawTransaction(raw)
```

Shared types (condensed from `packages/core/src/types.ts`):

```ts
type Mempool = "public" | "alt";
type EntityRole = "sender" | "payer" | "factory";
type RuleId = "gas-limit" | "recent-root" | "prefix" | "structure" | "signature" | "simulation" | "trace-alignment"
  | "OP-061" | "execution" | "out-of-gas" | "OP-011" | "create" | "storage" | "COD-010" | "entrypoint-access"
  | "mempool" | "admission" | "public-storage" | "public-gas-cap" | "nullifier-spent" | "unknown";

interface RuleCheck { rule: RuleId; frameIndex?: number; entity?: EntityRole; verdict: "pass" | "fail" | "skipped" | "warn"; detail?: string }

interface MempoolVerdict {
  mempool: Mempool;
  verdict: "admitted" | "rejected";
  source: "send" | "simulate" | "explorer" | "model";   // only "model" is unverified: our local rule model, no node said so
  failed?: { rule: RuleId; ercRule?: string; entity?: { role: EntityRole; address: Address }; frameIndex?: number };
  error?: { code: number; message: string; revertReason?: string };
  checks?: RuleCheck[];
  fix?: string;
  where?: string;               // e.g. "frame 1: 0xab… reads 0xcd… slot 0x0"
}

interface AdmissionReport {
  txHash?: Hex;
  verdicts: Record<Mempool, MempoolVerdict>;
  verifyGas?: bigint;           // sum of the validation prefix's execution limits
  focil?: { eligible: boolean; reason: string };   // inclusion lists (FOCIL, EIP-8369) draw only on the public mempool
}

type ReputationStatus = "ok" | "throttled" | "banned";
interface Stake { amount: bigint; unstakeDelaySec: number; withdrawTime: bigint; isStaked: boolean }
interface EntityStatus {
  address: Address; stake: Stake;
  reputation: { opsSeen: number; opsIncluded: number; status: ReputationStatus; isWhitelisted: boolean; isBlacklisted: boolean };
  headroom: { untilThrottled: number; untilBanned: number };   // throttled when floor(seen/10) > included + 10; banned when > included + 50
  pending: { hash: Hex; status: TxStatus; role: EntityRole }[];
  inclusions: { hash: Hex; block: number; verifyGas?: bigint }[];
  evictions: { hash: Hex; kind: "dropped" | "replaced" | "Cancelled"; reason?: string }[];
}

type AltpoolError =
  | { kind: "decode"; mempool: Mempool; message: string }
  | { kind: "signature"; message: string }
  | { kind: "ruleViolation"; mempool: Mempool; rule: RuleId; entity?: { role: EntityRole; address: Address }; message: string }
  | { kind: "validationReverted"; frameIndex: number; revertReason?: string; message: string }
  | { kind: "reputation"; status: "throttled" | "banned"; role: EntityRole; address: Address }
  | { kind: "nonceKeyHeld"; key: bigint; pendingHash: Hex }
  | { kind: "replacementUnderpriced"; message: string }
  | { kind: "recentRoot"; message: string }
  | { kind: "rpc"; code: number; message: string };

interface Note { secret: bigint; nullifier: bigint; commitment: Hex; nullifierHash: Hex }
interface WithdrawProof { proof: Hex; root: Hex; nullifierHash: Hex; recipient: Address; relayer: Address; fee: bigint; refund: bigint }
interface AdmissionChecker { check(tx: FrameTx): Promise<AdmissionReport> }   // the simulator implements it; the SDK accepts any as `precheck`
```

`@altpool/core/fixtures` (Node only): `fixture(path)`, `scenario(dir)`, `raw(path)`, `scenarios`, `mockWithdrawProof()` load captured devnet calls (`{ request, response }`) for offline tests.

## Simulator reference (`@altpool/simulator`)

### `checkAdmission(tx)` and `createSimulator(opts)`

```ts
checkAdmission(tx: FrameTx | Hex): Promise<AdmissionReport>            // default simulator on the public devnet
createSimulator(opts?: {
  ethrex?: ReturnType<typeof ethrex>;       // inject for tests
  gateway?: ReturnType<typeof gateway>;
  verifyGasMax?: bigint;                    // default DEVNET.verifyGasMax = 450_000n (ExitRelay's pin). Pass FALCON_VERIFY_GAS for Falcon, 600_000n for PayRelayWETH
  explorer?: boolean;                       // look the tx up on the explorer first (default true)
  estimate?: boolean;                       // ask the gateway's estimator for UNSIGNED txs (default true)
  assumeUnstaked?: boolean;                 // what-if: treat every entity as unstaked (skips the estimator)
}): AdmissionChecker & { check(tx: FrameTx | Hex): Promise<AdmissionReport> }
```

The input must be the final, signed transaction (or raw hex): ethrex rejects an unsigned one. How the two verdicts are produced:

| Mempool | Source order | `source` |
| --- | --- | --- |
| public | `ethrex_simulateFrameTransaction` (with ERC-7562 trace). A thrown RPC error is diagnosed the same way. | `simulate` |
| alt | 1. the explorer's admission record when the tx was already sent. 2. For a tx with **no signatures** (ExitRelay), the gateway estimator, which runs the sidecar's full rule engine with stake lookups but not reputation. 3. Otherwise our local rule model over the ethrex trace plus live stake and reputation. | `explorer`, `simulate`, `model` |

`source: "model"` is **unverified**: the alt mempool has no dry-run RPC (`frame_simulateTransactionV1` is not deployed). If the tx fails before any alt-only rule matters (bad signature, revert, nonce), the alt verdict copies the public diagnosis with source `model`. The model covers storage, banned opcodes, out-of-gas, calls to code-less addresses, reputation, and the VERIFY gas pin. It does not cover ASSOC exemptions beyond the keccak-base heuristic, CREATE rules or mempool-wide limits.

A `warn` check with rule `execution` is added when ethrex predicts the tx reverts after validation: the sidecar still admits it, so it would land reverted and the payer pays the gas. It never flips a verdict.

Real output (2026-11-07, a fresh unfunded key, signed, one self-paying transfer), trimmed:

```json
{
  "txHash": "0xe11c42f8...",
  "verdicts": {
    "public": { "mempool": "public", "source": "simulate", "verdict": "rejected",
      "failed": { "rule": "simulation", "frameIndex": 0 },
      "fix": "Validation failed in simulation. Check the nonce, the payer's balance and the VERIFY frame's revert.",
      "error": { "code": 0, "message": "Invalid Transaction: Invalid frame transaction: VERIFY frame 0 (target 0x05d1..., 0 bytes of code) failed: default code halted: RevertOpcode" },
      "where": "frame 0 (sender)" },
    "alt": { "mempool": "alt", "source": "model", "verdict": "rejected", "failed": { "rule": "simulation", "frameIndex": 0 }, "fix": "...same...", "where": "frame 0 (sender)" }
  },
  "verifyGas": "60000",
  "focil": { "eligible": false, "reason": "inclusion lists draw only on the public mempool, which rejects it (simulation); an alt-mempool tx gets no inclusion guarantee" }
}
```

(The same tx unsigned gave rule `unknown`, message `frame signature list does not authenticate the sender`.) Latency was about 0.6 s.

### Routing

| Export | Signature | Meaning |
| --- | --- | --- |
| `routeFromReport(report, opts?)` | pure, no network | `RouteDecision { target: "public" \| "alt" \| "none"; node?: "gateway" \| "miner"; url?; fallback?; reason; verified; fixes: string[]; report }`. Prefers public when admitted; otherwise alt on the **miner** when `report.verifyGas > heavyVerifyAt` (default 100,000, because the gateway's revalidation drops heavy txs) else the gateway. If the alt model could not run (no trace, rule `unknown`) it still routes to alt with `verified: false`. |
| `routeTransaction(tx, opts?)` | `opts: RouteOptions & { simulator? }` | `checkAdmission` then `routeFromReport`. `RouteOptions { prefer?: "public" \| "alt"; heavyVerifyAt?: bigint; gatewayUrl?; minerUrl?; ethrexUrl? }`. |
| `sdkMempool(decision)` | | `"public"`, `"gateway"` or `"miner"` for `submitFrameTransaction({ mempool })`. Throws if the target is `none`. Register both sidecars as `mempools: { gateway, miner }`. |

### Diagnosis

```ts
interface Diagnosis { rule: RuleId; ercRule?: string; entity?: { role: EntityRole; address?: Address }; frameIndex?: number; revertReason?: string; detail: string; fix: string }
diagnoseError(err: { code: number | string; message: string; data?: unknown }, mempool: "public" | "alt"): Diagnosis   // a send/estimate rejection
diagnoseSimulation(sim): Diagnosis | undefined                  // ethrex_simulateFrameTransaction result; undefined = admitted
diagnoseAdmission(admission: { outcome: string; checks?: RuleCheck[] }): Diagnosis | undefined   // explorer record; undefined unless outcome is "rejected"
decodeRevert(data?: string): string | undefined                  // Error(string) or an ExitRelay custom error such as "UnknownRoot()"
```

The pattern table that drives these is the Rule catalogue below. Other exports: `runModel`, `entitiesOf`, `prefixFrames`, `verifyGasOf` (the model), `renderReport`, `renderVerdict`, `renderChecks`, `renderRoute`, `summarize` (text output; honours `NO_COLOR`), `replaySimulator(captured, { staked?, label? })` (offline simulator from one captured call).

### Test matchers (`@altpool/simulator/vitest`)

```ts
import { expect } from "vitest";
import { altpoolMatchers } from "@altpool/simulator/vitest";
expect.extend(altpoolMatchers);

await expect(tx).toBeAdmittedBy("alt");
await expect(tx).toBeAdmittedBy("alt", { verified: true });          // only a node's own answer counts
await expect(tx).not.toBeAdmittedBy("public");
await expect(tx).toBeRejectedFor("alt", "storage");
await expect(tx).toRouteTo("alt", "miner");
await expect(tx).toBeAdmittedBy("alt", { checker: replaySimulator(fixture("public/29-ethrex_simulateFrameTransaction.json"), { staked: true }) });  // offline
```

The received value may be a `FrameTx`, raw bytes or an `AdmissionReport`.

### Conformance (`@altpool/simulator/conformance`)

`runConformance(dir)` plays the ERC-8421 vectors (exp-mempool-l2s d1a57c6, Apache-2.0) against the local model and counts agree, differ and not modelled per file. CLI in the CLI reference.

## Monitor reference (`@altpool/monitor`)

| Export | Signature | Returns |
| --- | --- | --- |
| `entityStatus(entity, gw = gateway(), opts?)` | one node (the gateway by default) | `EntityReport` |
| `entityReport(entity, opts?)` | `opts.nodes` default gateway and miner | `EntityReport` merged across nodes |
| `watchEntity(entity, opts)` | below | `() => void` (unwatch). Never throws: errors go to `onError`. |
| `txReport(hash, { nodes?, ethrexUrl?, timeoutMs? })` | one tx across nodes | `TxReport` with per-node views, events, frames and outcomes |
| `networkReport({ nodes?, timeoutMs?, maxReputationPages? })`, `watchNetwork({ nodes?, intervalMs?, onReport, onError? })` | the network view behind /monitor | `NetworkReport` |
| `headroom(opsSeen, opsIncluded, params?)` | pure | `{ untilThrottled, untilBanned }` |
| `webhookAlerts(entity, urls, { label?, mute?, onSent?, fetch? })` | | watch callbacks that POST alerts (recipe G) |
| `postAlert(urls, alert, opts?)`, `failing(report, conditions, { lowBalanceAt?, throttleWarnAt? })`, `CONDITIONS` | | the CI check behind `--fail-if` |
| `DEFAULT_NODES` | | `[{ name: "gateway", url }, { name: "miner", url }]` |

```ts
interface EntityReport extends EntityStatus {       // every EntityStatus field keeps its meaning (see Core)
  nodes: { name; url; ok; error?; latencyMs?; reputation?; reputationAt?; reputationError? }[];   // each node keeps its own seen/included counts
  pending: { hash; role; status; nodes: Record<string, TxStatus>; submittedAt?; ageMs?; stuck? }[];
  inclusions: { hash; block; verifyGas?; gasUsed?; cost?; nodes: string[] }[];
  rejections: { hash; at; nodes; role; errorCode?; failed?: RuleCheck; checks: RuleCheck[] }[];   // raw: run diagnoseAdmission yourself
  funds: { balance: bigint; avgCost?; feePerTx?; marginPerTx?; txsLeft? };
  exposure: { txs: { hash; sender; maxCost; cumulative; covered; nonceKeys }[]; total: bigint; uncovered: number; keyClashes: { sender; key; hashes }[] };
  throttleEta?: { headroomPerMin: number; minutes?: number };
  updatedAt: number;
}

watchEntity(entity: Address, opts: {
  nodes?: NodeRef[];                 // default gateway + miner
  feePerTx?: bigint;                 // what the entity earns per tx (ExitRelay: 10n ** 16n)
  intervalMs?: number;               // fallback poll, default 10000 (explorer calls take 2-10 s on the shared devnet; live events trigger polls sooner)
  live?: boolean;                    // subscribe to each node's explorer events over WebSocket (default true where WebSocket exists)
  throttleWarnAt?: number;           // default 20 sends left
  lowBalanceAt?: number;             // default 5 txs left
  stuckAfterMs?: number;             // default 90000 (about 7 blocks)
  timeoutMs?: number;                // per request, default 25000
  txLimit?: number; maxInclusions?: number; ethrexUrl?: string;
  onStatus?(s: EntityReport): void;                     // first snapshot, then on every change
  onInclusion?(i: Inclusion, s): void;  onRejection?(r: Rejection, s): void;  onEviction?(e, s): void;
  onStuck?(t: TrackedTx, s): void;       onThrottleWarning?(s): void;          onLowBalance?(s): void;
  onStakeChange?(prev: Stake, next: Stake, s): void;    // staked flipped, or an unlock started
  onError?(e: unknown): void;           onPoll?(p: { at; ok; nextAt }): void;
}): () => void
```

Real `entityStatus("0x9b1f934a...")` (PayRelayWETH, 2026-11-07), one node, 4.5 s:

```json
{
  "address": "0x9b1f934ac769ebfa3fec40eb72d2b4c932166ca1",
  "stake": { "amount": "12000000000000000", "unstakeDelaySec": 86400, "withdrawTime": "0", "isStaked": true },
  "reputation": { "opsSeen": 0, "opsIncluded": 0, "status": "ok", "isWhitelisted": false, "isBlacklisted": false },
  "headroom": { "untilThrottled": 110, "untilBanned": 510 },
  "pending": [], "inclusions": [], "evictions": [], "rejections": [],
  "funds": { "balance": "1047822476600750496" },
  "exposure": { "txs": [], "total": "0", "uncovered": 0, "keyClashes": [] },
  "nodes": [{ "name": "gateway", "url": "https://altmempoolgateway.forshtat.com/rpc", "ok": true, "latencyMs": 3682 }],
  "updatedAt": 1794019377872
}
```

Reputation (`status`) is node-local; each sidecar counts seen and included separately. A merged `watchEntity` snapshot (gateway and miner) of the same entity at the same time reported `untilThrottled: 183` against 110 from the gateway alone, with node latencies of 2.3 s (gateway) and 9.0 s (miner).

## Prover reference (`@altpool/prover`)

Node only (uses `node:crypto`, circomlib and ~70 MB of proving artifacts: `bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert` first, else `prove` throws `missing prover artifacts`). The site runs a browser port of the same prover in `src/liveExit`.

| Export | Signature | Meaning |
| --- | --- | --- |
| `createNote()` | `Note` | Random 31-byte nullifier and secret. `commitment = pedersen(nullifier \|\| secret)`, `nullifierHash = pedersen(nullifier)`. |
| `noteToString(note)` / `parseNote(str)` | `0x` + 62 bytes hex | The note is the secret that spends the deposit. Never log it. |
| `rootFor(note, pool = DEVNET.pool)` | `Promise<MerklePath>` | Rebuilds the 20-level MiMC tree from the pool's `Deposit` events and returns `{ root, rootIdx, leafIndex, pathElements, pathIndices }`. `rootIdx < 100` is an index into the pool's root history. |
| `pathFor(leaves, leafIndex)`, `pathForRoot(note, root, pool?)`, `hashLeftRight`, `ZEROS` | | Tree helpers. |
| `prove(note, to, pool?)` | `Promise<WithdrawProof & { rootIdx }>` | `to: { recipient: Address; relayer: Address; fee: bigint; refund?: bigint }`. Public inputs: recipient, relayer, fee, refund are bound by the proof, so a relayer cannot redirect or inflate. |
| `proveWithPath(note, path, to)` | `WithdrawProof` | Skips the tree rebuild. |
| `proveForRoot(note, root, to, pool?)` | `Promise<WithdrawProof>` | A proof against a given root (ExitRelayRR's published EIP-8272 root). |

## Contracts reference (`@altpool/contracts`)

```ts
import { exitTx, exitTxRR, payTx, settlerAddress, depositNote, depositNoteWeth, sendExit, explorerExit, rootSourceOf,
         EXIT_FEE, MINER_SIDECAR, WETH9, deployments, exitRelayAbi, settlerAbi, settlerFactoryAbi, invoiceBookAbi, erc20PoolAbi, wethAbi } from "@altpool/contracts";
```

### `exitTx` and `exitTxRR`

```ts
EXIT_FEE = 10n ** 16n                                   // 0.01 ETH, the withdrawal fee that repays the gas
exitTx(p: WithdrawProof & { rootIdx: number }, o: { exitRelay: Address; pool?: Address; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; nowSec?: number }): FrameTx
exitTxRR(p: WithdrawProof & { rootSlot: bigint }, o: { exitRelayRR: Address; ...same }): FrameTx   // frame 1 data "0x00"; adds one recentRootReference
```

Throws `proof relayer ... is not exit relay ...` if `p.relayer` is not the relay. Defaults: `maxFeePerGas = (EXIT_FEE - refund) / budget` with budget 1,850,000 gas (2,050,000 with a refund), so `max_cost <= fee`; priority fee 1 gwei; deadline rounded up to a 600 s grid so it does not fingerprint the send time. Sender = ExitRelay, nonce key = `nullifierHash`, `nonceSeq` 0, no signatures.

| # | Mode | Target | Limit (execution / state) | Data |
| --- | --- | --- | --- | --- |
| 0 | VERIFY | `0x...8141` expiry verifier | 10,000 | 8-byte big-endian deadline |
| 1 | VERIFY `EXECUTION_AND_PAYMENT` | ExitRelay | 450,000 | `abi.encode(uint256 rootIdx)` (RR: one ignored byte) |
| 2 | SENDER | Tornado pool | 1,000,000 / 300,000 (500,000 with a refund) | `withdraw(proof, root, nullifierHash, recipient, exitRelay, fee, refund)` |

ExitRelay VERIFY check order, cheapest first (`ExitRelayChecks`): frame count 3 and frame shapes; `MAX_COST <= FEE`; withdraw calldata (selector, `relayer == self`, `fee == FEE`, `refund == 0` unless the token variant, proof length 256); nonce (one key equal to `nullifierHash`, seq 0, at most one signature); root index below 100 and nonzero. Then state: `pool.roots(rootIdx) == root` (`UnknownRoot`), `!pool.isSpent(nullifierHash)` (`NullifierSpent`), and `verifier.verifyProof` last in try/catch (`BadProof`, `VerifierReverted`). Then `APPROVE(EXECUTION_AND_PAYMENT)`. Custom errors: `BadFrameCount, BadExpiryFrame, BadVerifyFrame, BadWithdrawFrame, CostTooHigh, BadSelector, BadRelayer, BadFee, BadRefund, BadProofLength, BadNonce, TooManySignatures, BadRoot, UnknownRoot, NullifierSpent, BadProof, VerifierReverted, BadRootSource` (`decodeRevert` names them).

### `payTx` (Pledge Paid, PayRelayWETH)

Argument shape is in recipe F. Frames (`packages/contracts/src/pay.ts`; `PayRelayWETH.sol` pins the modes, flags, calldata and these limits as floors):

| # | Mode | Target and call | Execution / state | Flags |
| --- | --- | --- | --- | --- |
| 0 | VERIFY | `0x...8141` expiry | 10,000 | |
| 1 | VERIFY `EXECUTION_AND_PAYMENT` | PayRelayWETH, `abi.encode(rootIdx)` | 600,000 | |
| 2 | SENDER | pool `withdraw(proof, root, nullifierHash, settler, payRelay, fee, 0)` | 1,000,000 / 300,000 | not in the batch |
| 3 | DEFAULT | `SettlerFactory.deploy(terms)` | 400,000 / 11,000,000 | ATOMIC_BATCH |
| 4 | SENDER | `settler.unwrap()` | 100,000 / 100,000 | ATOMIC_BATCH |
| 5 | SENDER | `settler.swap()` | 400,000 / 400,000 | ATOMIC_BATCH |
| 6 | SENDER | `InvoiceBook.settle(invoiceId, settler)` | 150,000 / 300,000 | ATOMIC_BATCH |
| 7 | SENDER | `settler.sweep()` | 300,000 / 200,000 | ATOMIC_BATCH |
| 8 | DEFAULT | `settler.assertSettled()` (view; reverts to roll back 3 to 7) | 100,000 / 0 | closes the batch |

`PAY_VERIFY_GAS_MAX` is 600,000 (simulated 550,095: the 3-frame VERIFY at about 374.5k plus about 175k of frame-opcode reads); the nonce key is consumed at APPROVE even if a later frame fails; `MAX_NONCE_SEQ` is 2. `settlerAddress(factory, settlerCodeHash, terms)` = `CREATE2(factory, keccak256(abi.encode(terms)), settlerCodeHash)`.

### Helpers

| Export | Meaning |
| --- | --- |
| `depositNote(wallet, note)` | `pool.deposit(commitment)` with 0.1 ETH (`gas 2_000_000`, legacy tx); waits for the receipt; throws if reverted. Returns the hash. |
| `depositNoteWeth(wallet, note, pool)` | Wrap 0.1 ETH, approve, deposit into an ERC20 Tornado pool. |
| `sendExit(tx, { sendUrl? })` | Submits through the SDK to `SEND_URL` or the miner sidecar, waits up to 180 s, throws unless the tx and every frame succeeded. Returns `{ hash, status, blockNumber, gasUsed?, frames: { status, gasUsed, stateGasUsed }[] }`. |
| `explorerExit(hash)` | Explorer link with `?node=<miner>`. |
| `rootSourceOf(exitRelayRR)` | `keccak256(abi.encodePacked(relay, bytes32(0)))`, ExitRelayRR's EIP-8272 namespace. |
| `deployments` | `deployments.json`, below. |

### Deployed contracts

The explorer at https://explorer.altmempool.wtf has no address page (its routes are `/`, `/activity`, `/peers`, `/reputation` and `/tx/<hash>`; any other path serves the same app shell), so addresses below link their deployment transaction. Use `/reputation` to find staked entities.

| Contract | Address | Role |
| --- | --- | --- |
| ExitRelay | `0x2576dcb7c8dc6c19cd6e39c8d49de03389b0ea6f` | QuietSend exit relay, staked. |
| Patched verifier | `0x43168942ab0d0272c7a7efd6f6540266afb7c1b3` | Copy of the pool's verifier with 3 sites rewritten (`PUSH2 0x07d0 GAS SUB` to `JUMPDEST x4 GAS`, 15 bytes) because ERC-7562 OP-012 bans `GAS` unless right before a `*CALL`. |
| ExitRelayRR | `0x86ea983cfd294ffa8a67aa353c67054c38e95170` | Reads the pool root through EIP-8272, so VERIFY reads no foreign storage. |
| WETH Tornado pool | `0x8b9e63aadfe58e413b0082933f3eaf303c5a4425` | `ERC20Tornado` over WETH9 `0x1b7d32025f7ca633943bbcc9ec61a98ef66187b6`, 0.1 WETH. |
| ExitRelayToken | `0xc8ad613fe8dd85ca688599cf76dd90a0a4c5e669` | ExitRelay for the WETH pool, with a 0.001 ETH refund. |
| PayRelayWETH | `0x9b1f934ac769ebfa3fec40eb72d2b4c932166ca1` | Pledge Paid relay, staked 0.012 ETH. |
| SettlerFactory | `0x5e1a0537093dfc364e3456721aeacb582e0bffd4` | Deploys Settlers at addresses fixed by the invoice terms. |
| InvoiceBook | `0xae43e222aa2e508832926f4faabb74c9b8a1ae2a` | Records invoices and payments. |

Deployment transactions are in `deployments.json` (`deployTx`, `verifierTx`, `exitRelayRRDeployTx`, `wethPoolTx`, `exitRelayWETHDeployTx`, `payRelayWETHDeployTx`, `settlerFactoryTx`, `invoiceBookTx`; link with `https://explorer.altmempool.wtf/tx/<hash>?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc`). Falcon's factory and verifier addresses are in `packages/falcon/deployments.json`.

## Wallet Bridge reference

`BridgeAccount.sol` lives in `packages/wallet-bridge`; the client API is exported by `altpool`. No wallet can sign a type-0x06 frame tx (and `eth_sign` is disabled), but every wallet signs EIP-712 typed data: the account's VERIFY frame recovers it with `ecrecover`.

```ts
bridgeAccount(cfg: { address: Address; owner: Address; profile: Profile }) => {
  address; owner; profile;
  buildTx(a: BridgeTxArgs): { tx: FrameTx; typedData: FrameTxTypedData }                    // Mode A
  prepareTx(a: BridgeTxArgs-like & PrepareArgs): Promise<{ tx; typedData }>                 // fills nonce, fees and limits from the chain, no signature
  typedDataFor(tx): FrameTxTypedData
  attachSignature(tx, signature: Hex): FrameTx                                              // 65-byte r||s||v from eth_signTypedData_v4, not repacked
  authorizeSession(session: BridgeSession): SessionTypedData                                // Mode B, the owner signs once
  buildSessionTx(a: BridgeTxArgs & { session; ownerSignature: Hex; deadline: bigint }): FrameTx   // UNSIGNED; sign entry 0 with the session key
  prepareSessionTx(a: PrepareArgs & { session; ownerSignature; deadline?: bigint }): Promise<FrameTx>   // fresh random nonce key by default
  recoverOwner(tx, signature): Promise<Address>; isOwnerSignature(tx, signature): Promise<boolean>
}
typedDataSigner(wallet: { signTypedData }, bridge, account?: Address): FrameSigner   // interactive: true, Mode A only, entry 0 only

interface BridgeCall { to: Address; value?: bigint; data?: Hex; gas?: bigint /* default 50k (100k when prepared) */; state?: bigint /* default 0; a fresh account needs about 200k */ }
interface BridgeTxArgs { calls: BridgeCall[]; nonce: bigint; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint }; nonceKey?: bigint /* default 0 */; verifyGas?: bigint }
interface PrepareArgs { client: Client /* ethrex */; calls; fees?; sidecar?: { getGasPrice() }; feeMultiplierPercent?: bigint /* default 200 */; nonce?; nonceKey?; verifyGas? }
interface BridgeSession { key: Address; validUntil: bigint /* unix s */; maxValuePerTx: bigint; maxCostPerTx: bigint; target: Address /* zero = any */ }
```

EIP-712 domain: `{ name: "AltpoolBridge", version: "1", chainId: 1337, verifyingContract: <account> }`. Mode A signs `FrameTx { bytes32 sigHash; address to; uint256 value; uint256 nonce; uint256 frameCount; uint256 maxFeePerGas }`; Mode B signs `Session { address key; uint64 validUntil; uint256 maxValuePerTx; uint256 maxCostPerTx; address target }`.

| | Mode A | Mode B |
| --- | --- | --- |
| Frames | `[VERIFY self (data 0x01), SENDER calls...]` | `[VERIFY 0x8141 expiry, VERIFY self (0x02 \|\| abi.encode(Session, ownerSig)), SENDER calls... (max 6)]` |
| Signature entry 0 | `ARBITRARY`, signer `"0x"`, msg `"0x"` (an ARBITRARY entry that names a signer is rejected), holds the EIP-712 signature | `SECP256K1` by the session key (protocol-verified) with empty msg |
| Default VERIFY gas | 40,000 (measured 30,020) | 60,000 + 4,000 per extra call (measured 53,818 for one call) |
| Wallet popups | one per tx | one per session |
| Why no stake | VERIFY reads only immutables, the tx, and the `ecrecover` precompile: no storage, no BALANCE | same |

Prepared limits: body frames 100,000 execution; state 200,000 when the call creates an account (value to an empty address), 300,000 when the call has data, else 0. `deadline` must be `<= session.validUntil`; `buildSessionTx` throws if a call target is outside the session or `value > maxValuePerTx`. The account enforces target, per-tx value, `maxCostPerTx` and expiry on-chain.

## Falcon reference (`@altpool/falcon`)

A contract account whose only authority is a Falcon-512 signature. EIP-8141 has no native Falcon scheme: the signature rides in an `ARBITRARY` entry (2088 bytes: `salt(40) || s2(32 words) || ntth(32 words)`) and `FalconWallet.fallback()` is the VERIFY frame, using the shared ZKNOX ETHFALCON verifier.

| Export | Meaning |
| --- | --- |
| `falconKeygen(seed?)` | `FalconKey` (noble Falcon-512: 897-byte public key). |
| `falconAccount({ key, factory?, verifier? })` | `{ address, pkHash, factory, verifier, signer, buildTx(args), deployCall(), isDeployed(client), getNonce(client) }`. `address` is the CREATE2 address, final before deployment, so it can be paid first. |
| `falconSigner(key)` | A non-interactive `FrameSigner`. |
| `buildFalconSpendTx / falconSpendTx` | Spend frames: `0 VERIFY wallet (data 0x00), 1 SENDER wallet.execute(to, value, data)`. Args: `{ wallet, key, nonce, to, value, data?, maxFeePerGas, maxPriorityFeePerGas?, verifyGas?, spendGas?, spendStateGas? }`. |
| `predictWalletAddress({ factory, verifier, publicKey })`, `pkHashOf`, `pubkeyToNtt`, `falconSign` | Lower level. |
| `FALCON_VERIFY_GAS` = 4,500,000n, `FALCON_SPEND_GAS` = 250,000n, `FALCON_SPEND_STATE_GAS` = 250,000n | Frame limits. |

Read the nonce with `getNonce`, never assume 1: HegotaSupport CREATEs 7 helper contracts from the wallet, so a fresh wallet's nonce is 8. Send to the alt mempool only (`mempool: "alt"`): VERIFY is about 3.6M to 3.9M gas (the public cap is 100k). That is about 4x ERC-8421's staked 1M VERIFY budget (BUDGET-010) and the wallet is unstaked; it is admitted only because this devnet's sidecar allows 10M. The ZKNOX verifier is experimental and unaudited. Usage, from `packages/falcon/README.md`:

```ts
import { falconAccount, falconKeygen } from "@altpool/falcon";
const pq = falconAccount({ key: falconKeygen() });                   // pq.address exists now; pay it (e.g. a QuietSend exit), then deploy once
await wallet.sendTransaction({ ...pq.deployCall(), gas: 18_000_000n, type: "legacy" });
const tx = pq.buildTx({ nonce: await pq.getNonce(client), to, value, maxFeePerGas });
await ap.sendFrameTransaction({ transaction: tx, signer: pq.signer, prepare: true, mempool: "alt" });
// admission check: createSimulator({ verifyGasMax: FALCON_VERIFY_GAS })
```

## Rule catalogue

Every `RuleId` the simulator can return, from `packages/simulator/src/rules.ts` (message patterns, first match wins), `check.ts` and `model.ts`. `ercRule` is the ERC-8421 id the simulator attaches (`Diagnosis.ercRule`, `verdict.failed.ercRule`). "Public" is ethrex's canonical mempool (`ethrex_simulateFrameTransaction`, `eth_sendRawTransaction`); "alt" is the sidecar. Fix texts are what `.fix` carries (abridged only where marked).

| RuleId | ERC rule | Mempool | Triggered by (node message or model check) | Fix |
| --- | --- | --- | --- | --- |
| `structure` | none | both | `Error decoding field`; `ATOMIC_BATCH_FLAG`, `expected tx.sender`, `VERIFY frame after`, `chain id ... does not match`, `state gas sum`, `PreVerify`. Also how the alt side records the public gas cap (`public-gas-cap` maps to `structure` on alt). | "Fix the tx structure: VERIFY frames target the sender (or null), sit only in the prefix, and never set ATOMIC_BATCH_FLAG." |
| `signature` | SIGNATURE-010 | both | code -32507, `Invalid frame transaction signature` | "Re-sign over the final tx. Gas estimation swaps in placeholder limits, so sign after filling gas, not before." |
| `recent-root` | none in the map (see RECENT-ROOT below) | both | message mentions `recent-root`, `RECENT_ROOT`, `RecentRoot` | "Reference a recent root that is committed in the RECENT_ROOT_ADDRESS predeploy and still inside the window, or drop the reference." |
| `prefix` | PREFIX-010 | both | `validation prefix not recognized` | "Reshape the frames: the validation prefix must be one of the recognised shapes (self_verify, or only_verify + pay)." |
| `public-gas-cap` | BUDGET-010 | public (alt: shown as `structure`) | `prefix gas budget exceeded: N > 100000`, `exceeds MAX_VERIFY_GAS`, `VerifyGasBudgetExceeded` | public: "The public mempool caps the whole validation prefix at 100k gas. Lower the VERIFY limits or send to the alt mempool." alt: "Lower the VERIFY frame limits: the prefix is over this node's MAX_VERIFY_GAS." |
| `gas-limit` | none in the map (see BUDGET-010 below) | alt (also the model's pin) | `gas limit is too high`, `per-transaction gas cap`; or the model: an entity's declared VERIFY gas is over our pin (`verifyGasMax`, default 450,000) | "Lower the frame limits: the total is over the node's per-transaction gas cap." For the model pin: "Lower the VERIFY limits to at most 450000, or justify raising the pin." |
| `OP-011` | OPCODES-010 | both | `uses banned opcode` / `BannedOpcode`. Banned: BALANCE, ORIGIN, GASPRICE, BLOCKHASH, COINBASE, TIMESTAMP, NUMBER, PREVRANDAO, GASLIMIT, SELFBALANCE, BASEFEE, BLOBHASH, BLOBBASEFEE, GAS (unless before a CALL), INVALID, SELFDESTRUCT. BALANCE and SELFBALANCE are allowed once the entity is staked. | "Remove the banned opcode from VERIFY (TIMESTAMP, NUMBER, BALANCE, GAS not before a CALL, ...). BALANCE/SELFBALANCE are allowed once the entity is staked." |
| `OP-061` | OPCODES (static VERIFY) | alt | `nested CALL with value` | "VERIFY runs static: remove the CALL with value." |
| `out-of-gas` | OPCODES-040 | alt | `<entity> internally reverts on oog` | "Raise the VERIFY frame's execution limit: an entity frame may not revert on out-of-gas." |
| `create` | CREATION-010 | alt | `<entity> uses banned opcode: CREATE/CREATE2`, `too many CREATE2` | "Only the deploy frame may CREATE/CREATE2, once, to install code at tx.sender." |
| `COD-010` | CALLING-010 | alt (public: ethrex also checks) | `<entity> accesses un-deployed contract`, `CallToNonexistentOrDelegated`. Precompiles 0x01 to 0x11 and 0x100 are allowed; the sender itself is exempt. | "VERIFY touched an address with no code. Deploy it first or remove the call." |
| `entrypoint-access` | none | alt | `<entity> accesses EntryPoint` | "Don't read the EntryPoint sentinel's code during validation." |
| `public-storage` | STORAGE-010 | public | `StorageReadNonSender`, `StorageWrite` | "The public mempool lets VERIFY read only the sender's own storage. Send to the alt mempool with the reading entity staked." |
| `storage` | STORAGE-031..033 | alt | `unstaked <entity> accessed ...`, `<entity> has forbidden read/write`; the model walks the ERC-7562 trace slot by slot (sender storage always; sender-associated slots; staked entity: own storage, reads elsewhere, associated writes) | "Stake <entity> in the staking registry (> 0.01 ETH, 1-day unstake delay), then resend to the alt mempool. If it is already staked, check its reputation: a banned entity is reported as unstaked." |
| `mempool` | none | alt | `is banned`, `is throttled`, `is unstaked`, `stake ... is too low`, `unstake delay ... is too low`, `already held by pending`, `cannot be replaced`, `cannot cover its pending`, `used as a different entity`; the model: a banned entity | "Mempool policy rejected it: wait for the pending tx on this nonce key, bump fees by at least 10%, use a fresh key, or let the entity's reputation recover." |
| `simulation` | none | both | `validation frame N: reverted [with data 0x...]` (revert reason decoded), `Nonce mismatch: expected X, got Y`, `Invalid Transaction`, `has N wei` (payer cannot cover) | Nonce case: "Nonce Y is used up: rebuild the tx with nonceSeq X (or a fresh nonce key) and re-sign." Revert case: "VERIFY frame N reverted: "<reason>". Fix the input the contract rejects." Else: "Validation failed in simulation. Check the nonce, the payer's balance and the VERIFY frame's revert." On a non-zero nonce key the simulator rewrites the nonce fix to say the key (the nullifier hash for an ExitRelay exit) is already used. |
| `nullifier-spent` | none | both | a VERIFY revert whose reason matches `NullifierSpent`, `already spent`, `nullifier ... used`, `note has been` | "This note was already withdrawn. Use a fresh note." |
| `admission` | none | alt | an explorer record with outcome `rejected` and no failing check | "Read the admission record on the explorer for the failing check." |
| `execution` | none | both (warn only) | Added by `checkAdmission` as a `warn` check when ethrex predicts the tx reverts after validation (the sidecar still admits it) | Detail: "frame N reverts in execution after G gas: <reason>. Admission still passes, so it would land reverted and the payer pays the gas." |
| `trace-alignment` | none | alt | appears in admission records (a sidecar check); the simulator has no specific fix | falls through to the default |
| `unknown` | none | both | no pattern matched, or ethrex returned no trace so the alt rules could not be modelled | "Unrecognised rejection. Run frame-doctor on the tx hash to read the explorer's admission record." |

Entity roles: `sender`, `payer` (a non-sender VERIFY target that approves payment; `paymaster` in node messages maps to `payer`) and `factory` (the target of a deploy `DEFAULT` frame).

### ERC-8421 rules as the MCP `explain_rule` tool lists them

Condensed from `packages/mcp/src/rules.ts` (source: https://docs.altmempool.wtf/rules/, the ERC-8421 draft, plus observed devnet behaviour). `explain_rule { rule }` takes the id, a sidecar check id from an admission record, or a keyword.

| Id | Sidecar check ids | Rule and fix |
| --- | --- | --- |
| BUDGET-010 | `gas-limit`, `out-of-gas`, `public-gas-cap` | Sum of DECLARED `limits.execution` over an entity's validation frames (plus signature intrinsic cost for the sender): unstaked at most 100,000, staked at most 1,000,000 (draft). The public mempool caps the whole prefix at 100,000. Running out of gas in VERIFY is a rejection (OPCODES-040). Fix: keep VERIFY limits tight (declared, not used, gas counts); over 100k, stake the entity and use the alt mempool. |
| PREFIX-010 | `prefix`, `structure` | Allowed prefixes: `[self_verify]`, `[deploy, self_verify]`, `[only_verify, pay]`, `[deploy, only_verify, pay]`; one pre_verify before each approving frame; optional expiry_verify (0x8141) first. No ATOMIC_BATCH in the prefix, no VERIFY after it; a VERIFY that reverts or never APPROVEs rejects. Fix: VERIFY frames first, each calling APPROVE; SENDER frames after. Empty VERIFY calldata hits `receive()`, not `fallback`: send at least 1 byte. |
| SIGNATURE-010 | `signature` | SECP256K1 / P256 entries are verified before simulation. ARBITRARY entries are not verified by the protocol and must NOT name a signer. msg `0x` means the entry signs SIG_HASH. Fix: sign after gas and fees are final; ARBITRARY signer is `0x`; a VERIFY that trusts SIGPARAM must also check MSG, or old signatures replay. |
| OPCODES | `OP-011`, `OP-061`, `OP-062` | Banned opcodes in validation (see `OP-011` above), CREATE/CREATE2 only in the deploy frame, SSTORE only to sender storage in the deploy frame. BALANCE/SELFBALANCE only for staked entities. Fix: move time checks to an expiry_verify frame (0x8141) instead of TIMESTAMP/NUMBER; do state changes in SENDER frames. |
| STORAGE | `storage`, `public-storage` | Sender's own storage always (STORAGE-010). Sender-associated slots in another contract if the sender exists (021) or with a staked factory (022). Staked entity: own storage (031), read-only elsewhere in non-entity contracts (032), slots associated with its address (033). Unstaked non-sender entities: no access. Fix: stake the reading entity, send to the alt mempool. |
| CALLING-010 | `COD-010`, `entrypoint-access` | Calling an address with no code is forbidden. Precompiles 0x01 to 0x11 and P256VERIFY (0x100) are allowed (ecrecover works on the devnet since 2026-11-06). |
| STAKING-010 | `stake` | Staked iff registry stake `>= MIN_STAKE_VALUE` (devnet 0.01 ETH; the BALANCE carve-out needs strictly more), unstake delay `>= MIN_UNSTAKE_DELAY` (draft 86,400 s; devnet config reports 0), and no withdrawal started. `unlockStake()` drops the status immediately. The registry keys on `msg.sender`: a contract must call `addStake` from its own code. |
| REPUTATION | `reputation` | Per entity: seen and included, decayed hourly by 23/24. `max_seen = seen / 10`. BANNED if `max_seen > included + 50`; THROTTLED if `> included + 10` (capped at 4 pending). Devnet: `opsIncluded` can stay 0, so a busy staked sender throttles after about 110 sends; replacements count as seen. Fix: use a fresh entity address for demos. |
| LIFECYCLE-010 | `mempool`, `nonce` | 1 to 16 strictly increasing keys; key 0 only alone. `nonceSeq` equals each key's current sequence. One pending tx per (sender, key); a replacement needs +10% on both fees. Unstaked sender: 4 pending linear txs. |
| SOLVENCY-010 | `execution`, `simulation` | The payer must cover `(all frame limits + intrinsic) x maxFeePerGas`, minus what its other pending txs reserve; re-checked every block, newest dropped first. ethrex reports a missing balance as the ambiguous `validation prefix frame reverted`. Fix: fund the payer (the sender when it self-pays). |
| STATE-GAS | `execution` | Creating an account costs 183,600 state gas, a new storage slot 97,920. A frame with `limits.state = 0` that creates state halts silently and fails the tx. Unused limits are refunded. |
| RECENT-ROOT | `recent-root` | Up to 16 references `{ sourceId, slot, root }` committed in `0x...8272`, usable while `1 <= head_slot + 1 - slot <= 8191`. A root written in slot S is usable from S+1. |

## CLI and MCP reference

### `frame-doctor`

Source: `packages/simulator/src/frame-doctor.ts`. Run with `bun packages/simulator/src/frame-doctor.ts ...` or `bun run --filter @altpool/simulator doctor ...`. The package's `bin` is `frame-doctor`.

```text
frame-doctor <rawTx | txHash> [--node <sidecar url>] [--json] [-v]
frame-doctor --fixture <path under core/fixtures> [--staked] [--json] [-v]
```

| Argument | Meaning |
| --- | --- |
| `<rawTx>` (hex, not 66 chars) | Check against both mempools (ethrex simulate plus the alt sources). Ends with the route: public, alt via gateway or miner, or nowhere with fixes. |
| `<txHash>` (66 chars) | Read the explorer admission record, status and receipt from the gateway and the miner (or one node with `--node`). Public is not re-checked. |
| `--node <url>` | Ask only this sidecar for a hash. |
| `--fixture <path>` | Offline replay of a captured call from `@altpool/core/fixtures` (`ethrex_simulateFrameTransaction`, `skandha_explorer_getTransaction`, or a captured rejection). `--staked` makes every entity staked. |
| `--json` | Print the report as JSON (bigints as strings). |
| `-v`, `--verbose` | Print every rule check. |

Exit codes: `0` when some mempool admits it (raw tx) or the alt mempool did (hash); `1` when none does; `2` on usage or RPC errors (`frame-doctor: <message>` on stderr).

### `watch-entity`

Source: `packages/monitor/src/watch.ts`. `bun run --filter @altpool/monitor watch <address>...`; package `bin` is `watch-entity`.

```text
watch-entity <address>... [options]            watch one or more entities, live
watch-entity <address>... --once [--fail-if ...]  one snapshot; with --fail-if, exit 1 when a condition holds (CI)
```

| Flag | Meaning |
| --- | --- |
| `--node gateway\|miner\|<url>` | Repeatable. Default: both the gateway and the miner's sidecar. |
| `--fee <eth>` | What the entity earns per tx (ExitRelay: 0.01), for the margin line. |
| `--alert-webhook <url>` | Repeatable. POST each alert (Discord, Slack, Telegram `sendMessage?chat_id=...`). |
| `--mute <kind,...>` | Alert kinds to leave out: `throttle unlocking unstaked low-balance stuck evicted rejected` (also `node-down` exists as an `AlertKind`). |
| `--fail-if <cond,...>` | `throttled banned unstaked unlocking low-balance stuck node-down rejections uncovered key-clash`, or `all`. Unknown names exit 2. |
| `--throttle-warn-at <n>` | Sends left that count as near throttling (default 20). |
| `--low-balance-at <n>` | Txs left that count as low balance (default 5). |
| `--interval <ms>` | Fallback poll period (default 10000). |
| `--json` | With `--once`: print the reports as JSON. |

Exit codes: `0` healthy (or watching), `1` a `--fail-if` condition holds, `2` usage error or no node reachable.

### `quietsend`

Source: `apps/quietsend/src/cli.ts`; package `bin` is `quietsend`.

```text
quietsend deposit                       # faucet-funds a key, deposits 0.1 ETH, prints the note
quietsend withdraw <note> [recipient]   # prove, simulator + preflight, submit the exit, wait, print the explorer link
```

The wallet key is `QS_PK` from the environment or `apps/quietsend/.env` (generated on first use, gitignored); notes and generated recipient keys are appended to the same `.env`. With no `recipient` a fresh one is generated. Needs the prover artifacts and `deployments.json` with an `exitRelay`. On failure it prints `quietsend: <message>` and `fix: <e.fix>` and exits 1; bad usage exits 2.

### The demo

`bun run demo` (`apps/demo/src/demo.ts`), against the public devnet and the deployed, staked ExitRelay:

| Command | Does |
| --- | --- |
| `bun run demo` | Live: fresh key, deposit, prove, check (public rejects, alt admits), what-if unstaked (alt rejects), send the exit, recipient 0 to 0.1 minus the fee, explain the replay, show ExitRelay's reputation. |
| `bun run demo --prepare` | The slow half before a talk: fund, deposit, prove (minutes); saves the proof. |
| `bun run demo --stage` | The rest from the prepared proof, in about a minute. |
| `bun run demo --fixture` | Offline backup: the captured paymaster run, unstaked then staked. |
| `--pq` | With the live modes: the recipient is a Falcon-512 wallet that then spends the exit through the SDK. |

### `conformance`

`bun run --filter @altpool/simulator conformance [vectors-dir] [--json] [--strict] [--all]`. Plays the ERC-8421 vectors against the local rule model and prints, per file, agree / differ / not modelled, then each difference. `--all` also lists agreeing cases; `--strict` exits 1 when any case differs (default 0).

### Other scripts

`bun run smoke` (live devnet check), `bun run --filter altpool live` (SDK integration run: `NETWORK=local` for altpool-localnet; writes `live/<network>-latest.json`, uses a fresh in-memory key), `bun run --filter @altpool/contracts abi | deploy | exit` (deploy and exit scripts; `-- --rr`, `-- --weth` variants; `SEND_URL` overrides the submit node), `bun run --filter @altpool/mcp test | smoke | bridge-smoke`, `bun run --filter @altpool/wallet-bridge build:sol | probe | deploy | smoke`.

### MCP server

Start: `bun <path-to-altpool>/packages/mcp/src/server.ts` (stdio; `name: "altpool"`, `version: "0.1.0"`). Client config:

```json
{ "mcpServers": { "altpool": { "command": "bun", "args": ["<path-to-altpool>/packages/mcp/src/server.ts"], "env": { "ALTPOOL_SESSION": "/path/to/session.json" } } } }
```

| Env var | Meaning |
| --- | --- |
| `ALTPOOL_AGENT_PK` | The agent EOA's key (0x + 64 hex). If unset a key is generated once into `packages/mcp/.env` (gitignored). A devnet throwaway; fund it with `fund_from_faucet`. |
| `ALTPOOL_SESSION` | Path to, or inline JSON of, a session file exported by `apps/wallet-bridge-web` ("Export for an agent"). Shape: `{ kind: "altpool-bridge-session", chainId, account, owner, session: { key, validUntil, maxValuePerTx, maxCostPerTx, target }, ownerSignature, sessionPrivateKey }` (numbers are decimal strings). Validated: kind, chain id, owner/account addresses, 65-byte owner signature, `sessionPrivateKey` must match `session.key`. |
| `ETHREX_URL`, `GATEWAY_URL`, `MINER_SIDECAR_URL` | Override the `DEVNET` endpoints (for altpool-localnet). |

The server never asks for or prints a user's wallet key. Write tools submit to the **miner** sidecar (60 s timeouts). Handlers never throw: bad input or an upstream failure returns `{ isError: true }` with a `Fix:` line. Results are `{ content: [{ type: "text", text }, ...] }`; most tools return a human summary first and a JSON string second (bigints as decimal strings).

Common input fragment, `call`:

```json
{ "type": "object", "required": ["to"], "properties": {
  "to":    { "type": "string", "description": "0x target address" },
  "value": { "type": "string", "description": "wei, decimal or 0x hex (default 0)" },
  "data":  { "type": "string", "description": "0x calldata (default empty)" },
  "gas":   { "type": "string", "description": "execution gas limit for this frame (default: estimated / generous)" },
  "state": { "type": "string", "description": "state gas limit (default: enough to create a fresh recipient or new storage)" } } }
```

Tool input schemas (from `packages/mcp/src/server.ts`; zod, shown as JSON Schema):

```json
{
  "check_admission":      { "properties": { "raw": { "type": "string", "description": "0x hex of the encoded frame tx (ethrex-eip8141-tracer profile), or a 0x tx hash" },
                                            "tx":  { "type": "object", "description": "Frame tx in wire JSON (hex-string numbers), as sent to eth_sendFrameTransaction" } },
                            "note": "pass exactly one of raw, tx. A 66-char hash in raw is routed to get_admission_report" },
  "get_admission_report": { "required": ["hash"], "properties": { "hash": { "type": "string" }, "node": { "enum": ["miner", "gateway"], "description": "default miner" } } },
  "entity_status":        { "required": ["address"], "properties": { "address": { "type": "string", "description": "0x 20-byte entity address" } } },
  "explain_rule":         { "required": ["rule"], "properties": { "rule": { "type": "string", "description": "rule id, sidecar check id, or keyword" } } },
  "agent_info":           { "properties": {} },
  "send_calls":           { "required": ["calls"], "properties": { "calls": { "type": "array", "minItems": 1, "maxItems": 6, "items": "<call>" },
                                                                   "via": { "enum": ["agent", "session"] }, "parallel": { "type": "boolean", "description": "agent only: fresh EIP-8250 nonce key" },
                                                                   "dryRun": { "type": "boolean" }, "force": { "type": "boolean", "description": "submit even if frame-doctor predicts a rejection" } } },
  "prepare_owner_tx":     { "required": ["account", "calls"], "properties": { "account": { "type": "string", "description": "the BridgeAccount address" }, "calls": { "type": "array", "minItems": 1, "maxItems": 6, "items": "<call>" } } },
  "submit_frame_tx":      { "properties": { "tx": { "type": "object" }, "raw": { "type": "string" }, "ownerSignature": { "type": "string", "description": "the wallet's 65-byte eth_signTypedData_v4 result" }, "dryRun": { "type": "boolean" }, "force": { "type": "boolean" } } },
  "wait_for_receipt":     { "required": ["hash"], "properties": { "hash": { "type": "string" }, "timeoutSec": { "type": "number", "description": "default 120, max 600" } } },
  "fund_from_faucet":     { "properties": { "address": { "type": "string" } } },
  "stake_entity":         { "properties": { "contract": { "type": "string" }, "amountEth": { "type": "string", "description": "default minStake + 0.002 ETH" }, "unstakeDelaySec": { "type": "number", "description": "default max(node minimum, 86400)" } } }
}
```

| Tool | Does | Notes |
| --- | --- | --- |
| `agent_info` | The signers this server holds: agent EOA (address, balance, stake) and an optional BridgeAccount session (account, limits, expiry), plus staking parameters. | Call first. |
| `check_admission` | Both mempools' verdict, failing rule, fix. Text summary, then the `AdmissionReport` JSON. | Appends "Note: a verdict with source "model" is our local rule model, not the node's own answer (unverified)." when applicable. |
| `get_admission_report` | What a node did with a sent tx: outcome, every rule check, failures with fixes. | Default node `miner`. A miss on one node may hit on the other. |
| `entity_status` | Stake, reputation, headroom, pending, inclusions. | Reads the gateway. |
| `explain_rule` | A rule and its fix (table above). | Unknown rule: `isError` listing the known ids. |
| `send_calls` | Build, sign, run frame-doctor, submit. `via: "agent"` (default) from the agent EOA; `via: "session"` from the user's BridgeAccount. | Refuses a tx predicted to be rejected unless `force`. `session` calls outside the session's target or value limits are refused before signing. |
| `prepare_owner_tx` | Unsigned Mode A tx plus the EIP-712 typed data for the owner's wallet. | The agent never holds the owner's key. |
| `submit_frame_tx` | Attach `ownerSignature` (checked against `OWNER()`), run frame-doctor, submit. | Or pass an already-signed `tx` / `raw`. |
| `wait_for_receipt` | Inclusion plus each frame's status and gas, with an explorer link (miner view). | If the node dropped it, says so and gives the reason. |
| `fund_from_faucet` | Funds an address (default the agent). | Reports the balance change. |
| `stake_entity` | Stakes the agent EOA; with `contract`, calls that contract's payable `stake(address registry, uint32 delay)`. | Contracts must stake from their own code. |

Resource `altpool://rules` (`text/markdown`): the rule table above. Prompt `get_admitted { goal }`: runs the repair loop (`agent_info`, `send_calls` with `dryRun` first, read the failing rule with `explain_rule` / `get_admission_report`, fix with `fund_from_faucet` / `stake_entity` / changing the calls, resend).

Real outputs (2026-11-07, handlers called directly):

```text
entity_status { address: "0x9b1f934ac769ebfa3fec40eb72d2b4c932166ca1" }
-> 0x9b1f…ca1: staked (12000000000000000 wei, unstake delay 86400s); reputation ok (seen 0, included 0); headroom 110 until throttled, 510 until banned; 0 pending, 0 recent inclusions.
   (second content part: the EntityReport JSON)

explain_rule { rule: "storage" }
-> STORAGE: Storage access in validation [sidecar: storage, public-storage]
   Sender's own storage: always (STORAGE-010). ... Fix: Stake the entity that reads (paymaster, relay) with stake_entity, then send to the alt mempool. ...

explain_rule { rule: "zzz" }                  (isError)
-> No rule matches "zzz".
   Fix: Try one of: BUDGET-010, PREFIX-010, SIGNATURE-010, OPCODES, STORAGE, CALLING-010, STAKING-010, REPUTATION, LIFECYCLE-010, SOLVENCY-010, STATE-GAS, RECENT-ROOT; or read the altpool://rules resource.

check_admission { raw: "nothex" }             (isError)
-> `raw` is not hex.
   Fix: Pass the 0x-prefixed, even-length hex of the encoded frame tx (or a 66-char tx hash to read its admission record).

get_admission_report { hash: "0x12" }         (isError)
-> "0x12" is not a transaction hash.
   Fix: Pass a 0x-prefixed 32-byte (66 character) hash.
```

Live evidence in `packages/mcp/README.md` (2026-11-07): `send_calls` from the agent EOA landed in block 11667 (tx `0xd3598e53...`), `send_calls via session` in block 11708, and `prepare_owner_tx` then `submit_frame_tx` in block 11712.

## Devnet facts and gotchas

### Endpoints and chain

| | |
| --- | --- |
| Chain id | 1337 (MetaMask's built-in "Localhost 8545" shares it: remove it or `connectAltDevnet` throws `WrongNetworkError`). |
| ethrex RPC (execution) | `https://altmempool.forshtat.com` |
| Gateway sidecar | `https://altmempoolgateway.forshtat.com/rpc` (v4.1.1, `bundlingMode: "manual"`, explorer and faucet enabled, `validationGasLimit` 10,000,000, `txGasLimit` 25,000,000) |
| Miner sidecar | `https://altmempool.forshtat.com/rpc` |
| Explorer | `https://explorer.altmempool.wtf` (routes `/`, `/activity`, `/peers`, `/reputation`, `/tx/<hash>`) |
| Codec profile | `ethrex-eip8141-tracer`: tx type `0x06`; modes DEFAULT 0, VERIFY 1, SENDER 2; ATOMIC_BATCH flag `0x4`; entry point `0x...00aa`; NONCE_MANAGER `0x...8250`; RECENT_ROOT `0x...8272`; expiry verifier `0x...8141` |

### Gateway vs miner sidecar, and the explorer `?node=` trick

- On Nov 6 the gateway admitted exits but did not gossip them to the miner (`bundlingMode: "manual"`; other teams' txs were stuck too), so QuietSend, Pledge Paid and the MCP write tools submit to the **miner's own sidecar**.
- Admission records, reputation and lifecycle events are **node-local and in memory** (explorer history capacity 10,000; lost on restart; publicly readable). A hash unknown to one node may be known to the other. Every such SDK result carries `node`.
- The explorer defaults to the gateway's view. For a tx sent to the miner, add `?node=` with the URL-encoded miner sidecar: `https://explorer.altmempool.wtf/tx/<hash>?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc` (or pick **Miner** in the explorer's node menu). A replay sent to the gateway shows as "Rejected" there.
- The sidecar can admit a 2-frame contract-sender tx and then cancel it with "relayed 4 times without being included in a block". A resend at the same nonce landed in the observed cases (cause not established).
- The gateway's bundler revalidation drops txs whose prefix uses more than 100,000 gas (`MAX_VERIFY_GAS`) even though admission accepted them; heavy txs (ExitRelay 450k) landed only through the miner. `routeFromReport` encodes this.
- Slow answers: the miner sidecar and explorer calls are heavy (2 to 10 s each on the shared devnet; measured today: `assertCompatible` 1.6 s on the gateway, `entityStatus` 4.5 s). The site uses `timeoutMs: 90_000` for the miner client; the monitor's per-request default is 25 s; MCP uses 60 s. Set `timeoutMs` explicitly; the SDK never retries a submission.

### Validation gas

| Limit | Value | Where from |
| --- | --- | --- |
| Public mempool (ethrex) VERIFY prefix cap | 100,000 (`MAX_VERIFY_GAS`, `prefix gas budget exceeded: N > 100000`) | still enforced |
| Alt sidecar `validationGasLimit` | 10,000,000 | gateway config; the devnet team removed the old 100k cap on Nov 6 and calls the replacement temporary. Other nodes may cap it. |
| ERC-8421 draft budget (BUDGET-010) | 100,000 unstaked, 1,000,000 staked, per entity | the simulator's `budget: "erc-8421"` mode |
| ExitRelay VERIFY | measured 374,217 (frame 1); **pinned at 450,000** | 350k ran out of gas inside VERIFY and was reported as a failed proof |
| PayRelayWETH VERIFY | simulated 550,095; **pinned at 600,000** | 3-frame VERIFY plus about 175k of frame-opcode reads |
| Falcon wallet VERIFY | 3.62M to 3.86M observed; limit 4,500,000 | about 4x the staked budget; alt mempool only |
| BridgeAccount VERIFY | Mode A measured 30,020 (limit 40,000); Mode B 53,818 (limit 60,000 + 4,000 per extra call) | stays under the unstaked 100k cap, so no stake needed |
| Total per tx (`txGasLimit`) | 25,000,000 | gateway config |

The 450k and 600k figures are our own pins (`DEVNET.verifyGasMax`, `PAY_VERIFY_GAS_MAX`), justified by fixed cost, no loops, cheap checks before the pairing, bounded invalidation and a staked entity; they are not protocol limits. Keep a sub-100k fallback design when you choose gas.

### Staking

- Registry `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`, `addStake(uint32 unstakeDelaySec) payable`, keyed on `msg.sender`. Contracts call it from their own code; the MCP `stake_entity { contract }` calls a contract's payable `stake(address registry, uint32 delay)`.
- Stake **strictly more than** 0.01 ETH (`minStake` = 10000000000000000 wei). PayRelayWETH is staked with 0.012 ETH. The sidecar's config reports `minUnstakeDelay` 0 (live, today) while our constants and the rules text use 86,400 s (1 day); using 86,400 satisfies both.
- `unlockStake` drops the staked status immediately; the amount is withdrawable after the delay. A banned entity is reported as unstaked.
- Reputation: throttled when `floor(seen/10) > included + 10`, banned when `> included + 50`. On this devnet `opsIncluded` can stay 0, so a busy staked sender throttles after about 110 sends (`headroom.untilThrottled` 110 for a fresh entity). Replacements count as seen. Use a fresh entity for demos.

### Keyed nonces

`nonceKeys` must have 1 to 16 strictly increasing entries (`[]` is rejected); `[0n]` is the account nonce and only works alone. `nonceSeq` must equal every key's sequence. One pending tx per (sender, key); a replacement needs both fees +10% (+9%, +5% rejected: `cannot be replaced: fee too low`). **QuietSend and Pledge Paid use the note's nullifier hash as the nonce key**: it is consumed at APPROVE (even if a later frame fails), so a replay of a withdrawn note fails with `Nonce mismatch: expected 1, got 0`, and the simulator rewrites that fix. The first use of a fresh key costs extra gas at APPROVE.

### State gas (EIP-8037, 1530 gas per byte on this devnet)

| What | State gas |
| --- | --- |
| New account (120 B) | 183,600 |
| New storage slot (64 B) | 97,920 |

A frame with `limits.state = 0` that creates state halts silently and fails the tx. Unused limits are refunded. Declare about 200,000 on a transfer to a fresh address and 300,000 when a call writes new storage. ExitRelay's exit measured: expiry 3,051; VERIFY 374,217; withdraw 300,069 execution plus 281,520 state; total `gasUsed` 979,542, about 0.00098 ETH at 1 gwei against the 0.01 ETH fee. The estimator under-reports body frames (a transfer that created an account measured 3,000 gas but needed more than 16,000 plus state gas).

### Estimation, signing and the other findings that affect builders

- **No alt-mempool dry run.** `frame_simulateTransactionV1` is not deployed. Before sending, an alt verdict is ethrex's simulation, the gateway estimator (unsigned txs only), or our rule model. Only the node's admission report after submission is its own answer.
- **Estimation needs a signed probe.** The estimator rewrites body-frame limits to 10,000,000 before checking signatures: a tx signed at its real limits fails with `-32507`, and so does an unsigned one. `estimateFrameTransactionGas({ signer })` signs the probe for you. The signed probe is a valid tx: spend the nonce right after. SDK `prepare: true` only raises limits, never lowers them (`margin.allowShrink` opts in). Wallet-popup signers are refused (`InteractiveSignerError`).
- **ethrex cannot estimate from a contract sender** (EIP-3607), so BridgeAccount txs use `bridge.prepareTx` (generous refunded body limits) and a signed `checkAdmission`.
- **The sidecar admits txs that will revert.** If ethrex predicts the tx reverts after validation, admission still passes: it lands reverted and the payer pays. `checkAdmission` adds an `execution` warn check; read it.
- **Validation traps.** Empty VERIFY calldata routes to `receive()`, which returns without APPROVE (send at least 1 byte). An ARBITRARY signature entry must not name a signer. `SIGPARAM(RESOLVED_SIGNER)` on an ARBITRARY entry halts. A VERIFY that trusts SIGPARAM must also check `SIGPARAM(MSG)`, or an old signature by the same key replays. `TIMESTAMP` is banned in validation: use the expiry verifier frame (`0x...8141`, 8-byte deadline). A new HegotaSupport contract's nonce is 8.
- **`GAS` before a non-call opcode is banned** (ERC-7562 OP-012). The devnet Tornado verifier uses `staticcall(sub(gas(), 2000), ...)`, so ExitRelay deploys a verifier copy with 3 sites rewritten.
- **Recent roots** (`0x...8272`) are write-only; a root written in slot S is usable from S+1 for 8191 slots (about 13.6 hours) and until 100 more deposits; at most 16 references.
- **FOCIL.** Inclusion lists draw only on the public mempool, which rejects 450k VERIFY, so these txs get no forced-inclusion guarantee. `AdmissionReport.focil` says so per tx.
- **Estimator echoes.** The gateway estimator can echo the public gas cap or placeholder-limit rejections that say nothing about the alt mempool; the simulator ignores those.

## Limits and honesty

- The demo proves the mechanism, not privacy. Do not read it as a privacy guarantee.
- An alt-mempool verdict before sending is ethrex's simulation, an estimator answer or a rule model (`source: "model"`) and is **unverified** until a node answers; the ERC-8421 draft budgets and our pins are not the same thing.
- ExitRelay VERIFY is about 375k gas pinned at 450k; PayRelayWETH is pinned at 600k; Falcon is about 3.9M. These are admitted by the alt mempool on this devnet; ethrex's public mempool caps VERIFY at 100,000.
- Devnet only. Keys in this repo's scripts are throwaways, never use published devnet keys, and nothing here has had a third-party audit. ZKNOX Falcon is experimental and unaudited.
- Not verified here: other nodes' validation caps; behaviour under a hard-fork change of the frame opcodes; any claim about mainnet. Package versions are `0.0.0` workspace packages except the published `altpool`.
