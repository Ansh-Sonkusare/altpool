# @altpool/wallet-bridge

An EIP-8141 account that any browser wallet (MetaMask, Rabby) can control. No wallet can sign a type-0x06 frame
transaction, and `eth_sign` is disabled, but every wallet can sign EIP-712 typed data. `BridgeAccount`'s VERIFY frame
recovers that signature with the `ecrecover` precompile and approves. The account's own code decides what is valid.

Owner: Dev B. The client API lives in the SDK (`import { bridgeAccount, typedDataSigner } from "altpool"`). The demo
page is `apps/wallet-bridge-web`.

## Proof on the live devnet (chain 1337)

Each tx was admitted by the sidecar (`eth_sendFrameTransaction` on `DEVNET.minerSidecarUrl`) and included with every
frame succeeding. The owner signs with a viem local account's `signTypedData`, which produces the same bytes as
MetaMask's `eth_signTypedData_v4`. The SDK test also exercises the EIP-1193 JSON path.

| | Tx | Block |
| --- | --- | --- |
| BridgeAccount deploy | [0xa9a12645…](https://explorer.altmempool.wtf/tx/0xa9a12645d3d4ef970751bcc86ad77c727b0aba2107ee1e5d67919964ed492f3d) | |
| **Mode A** (owner signs EIP-712 per tx) | [0x0060822c…](https://explorer.altmempool.wtf/tx/0x0060822c51248172ea2764e96b4b0a9bc3bff6b8bd79e372f1144bb6a41e8638?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 8742 |
| Mode A, first run (60k VERIFY limit) | [0x6e29f987…](https://explorer.altmempool.wtf/tx/0x6e29f987aa8034714e23738baf42e68cc8c0de9cd9950b46f0d5d25fb8ef5519?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 8705 |
| **Mode B** #1 (session key) | [0xbc784182…](https://explorer.altmempool.wtf/tx/0xbc784182f821f02f1f8d03957a7914314f6ee1427fbf31cd23ab472b58363642?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 8747 |
| Mode B #2 | [0x41e6111a…](https://explorer.altmempool.wtf/tx/0x41e6111a26976ccded3fba1b08ca00b89a52cf401b06d2f6d45a2520d87a16c9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 8754 |
| Mode B #3 | [0x2107b5cc…](https://explorer.altmempool.wtf/tx/0x2107b5ccd553a5bbdc9e8a8b5061f879db659dd6a5c25e8502ad18b1837a152f?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 8757 |

Account `0x9f1331A6E016620Bab4674ECf3e233E72A92862a`, owner `0xEae72d881c92712a0EA33E95cB64F6CdCD45B444`. The explorer
links carry `?node=` because the explorer defaults to the gateway, which does not see txs sent to the miner's sidecar.

## Run it

```bash
bun run --filter @altpool/wallet-bridge build:sol   # solc-js 0.8.28, via-IR, cancun → out/ + src/generated/
bun run --filter @altpool/wallet-bridge probe       # Gate 0 (below)
bun run --filter @altpool/wallet-bridge deploy      # owner = OWNER_PK (.env, generated); or: bun scripts/deploy.ts --owner 0xYourMetaMask
bun run --filter @altpool/wallet-bridge smoke -- --all   # digest parity via eth_call, Mode A, then 3 Mode B txs
bun run --filter @altpool/wallet-bridge forge:test  # pure-logic vectors (needs forge)
bun run --filter @altpool/wallet-bridge-web dev     # the demo page
```

Keys: `DEPLOYER_PK` and `OWNER_PK` are generated into `packages/wallet-bridge/.env`, which is gitignored, and funded
from the faucet. They are never the published devnet key.

Compiling uses solc-js because forge is optional, and the settings match `foundry.toml`. `src/generated/bridgeAccount.ts`
is committed so the web page can deploy an account for a MetaMask owner without a compiler.

## Gate 0 results (`scripts/probe.ts`, live `ethrex_simulateFrameTransaction`, 2026-11-07)

`Gate0Probe` sits in a VERIFY frame and reverts with one opcode answer per simulation, so an opcode that halts is
pinned to a single read.

| Question | Answer |
| --- | --- |
| `SIGDATACOPY` (0xb5) on `ERC8421_WORKSHOP` | **Works.** Lengths 0, 32 and 65 return the exact entry bytes, for entry 0 and entry 1. hegota-support lists it as "from the EIP text". It is now verified. |
| `TXPARAM(SIG_HASH)` vs the codec's `sigHash()` | **Equal** in every shape tried: ARBITRARY with msg `0x`, ARBITRARY with a 32-byte msg, SECP256K1 + ARBITRARY, and no signatures. |
| `SIGPARAM(MSG)` for msg `0x` | `0`. For a 32-byte msg it returns the msg. |
| `SIGPARAM(RESOLVED_SIGNER)` on an ARBITRARY entry | **Halts.** The frame reverts with empty revert data. |
| ARBITRARY entry with `signer = sender` | **Rejected before execution**: "Signature 0: ARBITRARY signatures must not name a signer". The entry must use `signer: "0x"`. |
| SECP256K1 entry with `signer ≠ sender` (the session key) | Accepted. The protocol verifies it, and SIGPARAM returns that signer. |
| `TXPARAM(MAX_COST)` | Equals the simulator's `maxCost`. It is `(frame limits + intrinsic) × maxFeePerGas`, and intrinsic includes calldata gas over the signature bytes (65 zero bytes vs 65 `0xff` bytes: 780 gas apart). |
| New HegotaSupport contract nonce | 8 (1 + 7 helper CREATEs). |

## Design

### Mode A: the wallet approves each tx

```
signatures[0] = { scheme: ARBITRARY, signer: "0x", msg: "0x", signature: r||s||v }   (eth_signTypedData_v4 bytes, as returned)
frames        = [ VERIFY self  flags=3  data=0x01 ] [ SENDER call ] [ SENDER call ]…
                (an expiry_verify frame 0 should also work, because the account reads CURRENT_FRAME_INDEX; not yet tested live)
```

Because `msg == "0x"`, the codec elides the entry's bytes from SIG_HASH, so a signature can cover SIG_HASH and still
live inside the tx. The wallet signs:

```
domain  { name: "AltpoolBridge", version: "1", chainId: 1337, verifyingContract: account }
FrameTx { bytes32 sigHash; address to; uint256 value; uint256 nonce; uint256 frameCount; uint256 maxFeePerGas }
```

VERIFY rebuilds the struct from the tx itself: `TXPARAM(SIG_HASH, NONCE, FRAME_COUNT, MAX_FEE)`, plus the target and
value of the frame right after it via `FRAMEPARAM`. It then runs `ecrecover` and approves `EXECUTION_AND_PAYMENT` only
when the owner signed. It also requires `TXPARAM(SENDER) == this`, exactly one signature entry, scheme ARBITRARY, and
length 65. It rejects high-s, `v ∉ {27,28}` (0/1 is tolerated) and `address(0)`.

### Mode B: the wallet approves a session once (the agent / chatbot path)

```
Session { address key; uint64 validUntil; uint256 maxValuePerTx; uint256 maxCostPerTx; address target (0 = any) }
signatures[0] = { scheme: SECP256K1, signer: session.key, msg: "0x", signature }   (the protocol verifies it over SIG_HASH)
frames        = [ VERIFY 0x8141 deadline (≤10k gas) ] [ VERIFY self data=0x02‖abi.encode(Session, ownerSig) ] [ SENDER… ≤ 6 ]
```

VERIFY checks the following:
- The owner's EIP-712 Session signature recovers `OWNER`.
- Entry 0 is SECP256K1 with an **empty msg**, signed by `session.key`. Checking the msg matters: SIGPARAM returns the
  signer but not what was signed, so without it any old signature by the key would pass (finding #6).
- Frame 0 is the expiry verifier: VERIFY mode, ≤ 10k gas, 8 data bytes, and a deadline ≤ `validUntil`. TIMESTAMP is
  banned in validation, so expiry has to come from this frame.
- Each SENDER frame's target and value are within the session limits.
- `MAX_COST ≤ maxCostPerTx`.

The session txs use separate EIP-8250 nonce keys, so several can be pending at once (the sidecar keeps one per
`(sender, key)`). `maxCostPerTx` is an addition to the original Session spec. Without it a leaked session key could
spend the account's balance on fees.

### Why it needs no stake

Validation reads only immutables (`OWNER`, `DOMAIN_SEPARATOR`, the helper addresses), the tx (through the frame
opcodes), and the stateless `ecrecover` precompile. It reads no storage and no BALANCE, and it never calls an address
without code: the opcode helpers are the account's own CREATEd contracts. That is the simplest rule class. The account
also stays under the 100k unstaked verify cap.

### Gas (live, `ethrex_simulateFrameTransaction` and `eth_estimateFrameTransactionGas`)

The cap counts **declared** `limits.execution` per entity, plus the signatures' intrinsic cost for the sender. Used
gas does not count, so the SDK defaults are kept tight.

| | VERIFY gas used | Declared (SDK default) | Total gas, estimator |
| --- | --- | --- | --- |
| Mode A | 29,994 | 40,000 | 53,148 |
| Mode B, 1 call | 3,051 (expiry) + 53,844 | 10,000 + 60,000 (+4,000 per extra call) | ~86,690 |
| Deploy (CREATE, 7 helpers, code deposit priced as state gas) | | | 9,667,691 |

frame-doctor reports 40,000 for Mode A and 70,000 for Mode B against the 100,000 cap. Both modes are also valid on
ethrex's **public** mempool (`canonicalMempoolValid: true`).

## Preparing a tx without a second popup (SDK `bridge.prepareTx`)

A wallet-controlled account cannot be gas-estimated before it signs. The sidecar estimator needs a signature over
its own probe, which is a valid tx with larger limits, and a person must never be asked to sign that. ethrex refuses
`eth_estimateGas`/`eth_call` from a contract sender, and it has no state override.

`prepareTx` and `prepareSessionTx` therefore fill the nonce, the fees (sidecar gas price × 2) and the call limits
without signing:
- 100k execution per call.
- 200k state gas for a value transfer that creates its recipient.
- 300k state gas for any call with data, since a state limit of 0 silently halts a frame that writes fresh storage.

Body-frame limits are only a balance reservation: only the VERIFY limits count toward the 100k cap. Explicit
`gas`/`state` on a call always win. `typedDataSigner` is marked `interactive`, so `estimate`/`prepare` throw
`InteractiveSignerError` instead of asking for a second signature, and `preflight` checks the signed tx as given.

Live: [0x0fe30bd5…](https://explorer.altmempool.wtf/tx/0x0fe30bd5ce6c906aa15177c3605767a1f16bd608bc24d10b678131331e57df26?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc)
(block 10428). It made one signature, sent 1 wei to a fresh address, and both frames succeeded. The call used
3,000 execution gas of 100,000 declared and 183,600 state gas of 200,000 declared.

## Threat model and trade-offs

- **What MetaMask shows and what the contract enforces.** The wallet shows `to`, `value`, `nonce`, `frameCount`,
  `maxFeePerGas`, and an opaque `sigHash`. Every one is re-derived on-chain, so a page cannot show one transfer and get
  a signature for another. `sigHash` commits to everything else: every frame, including any frame after the first call
  (the user sees `frameCount`, not their contents), the gas limits, the fees and the nonce keys. A malicious dapp could
  still hide extra calls behind frames 2 and later, and the user would only see the count. Treat `frameCount > 2` as a
  warning in the UI. The fields are not `maxCost`: `MAX_COST` changes when the signature bytes are attached, so it
  cannot be signed.
- **Replay.** SIG_HASH covers the chain id and the nonce (key and sequence), and the domain pins the chain and this
  account. A signature is good for one tx on one account on one chain. EIP-1271 uses `Message(bytes32 hash)` under the
  same domain, so signatures for this account cannot be replayed on another account with the same owner.
- **Malleability.** High-s signatures are rejected, so there is a single valid signature per tx. A different tx hash
  could not move the nonce anyway.
- **Mode B has no revocation.** A session stays valid until `validUntil`, and the expiry frame bounds each tx. Revoking
  early would need a storage write in a SENDER frame (an `execute` path that bumps an epoch) and a storage read in
  VERIFY. That moves the account out of the immutables-only class, and admission is still allowed for own storage. Not
  done: keep sessions short. A leaked key can spend at most `maxValuePerTx` value plus `maxCostPerTx` fees per tx,
  only to `target`, until `validUntil`.
- **One owner, no rotation.** `OWNER` is immutable. Deploy a new account to rotate.
- **Chain-id clash.** MetaMask's built-in "Localhost 8545" is also 1337. The page compares the wallet's block height
  with the devnet's before signing.

## Rule findings (for `docs/10-rule-findings.md` in the research repo)

1. **ARBITRARY entries must not name a signer.** The node rejects one before execution with "Signature 0: ARBITRARY
   signatures must not name a signer", even when `signer == sender`. The docs say nothing about this. Use `signer: "0x"`.
2. **`SIGPARAM(RESOLVED_SIGNER)` halts on an ARBITRARY entry.** The result is "validation prefix frame reverted" with
   empty revert data. Read only SCHEME, MSG and SIGNATURE_LENGTH on such an entry.
3. **`SIGDATACOPY` works on the ERC-8421 devnet.** It is verified for entries 0 and 1 at lengths 0, 32 and 65.
   hegota-support still marks it as unverified.
4. **`TXPARAM(MAX_COST)` depends on the signature bytes.** Intrinsic gas includes calldata over the signature, so a
   signature cannot commit to it. Sign `maxFeePerGas` (TXPARAM 0x04) instead.
5. **`SIGPARAM(MSG)` reads 0 for an empty msg.** It cannot tell an empty msg from a 32-byte zero msg. This is harmless
   for us, because a key would have to have signed the zero digest.
6. **A SECP256K1 entry may be signed by a key other than the sender**, and both mempools accept it. This is what makes
   session keys possible without a protocol change.
7. A contract funded through its creation `value` needs an explicit `payable` constructor. The probe's first deploy
   reverted because the implicit constructor is non-payable. This is obvious, but cost a deploy.
8. **ethrex refuses `eth_estimateGas`/`eth_call` from a contract sender**: "Sender account … shouldn't be a
   contract" (an EIP-3607 check). It also rejects the state-override parameter. A frame-tx account's calls cannot be
   estimated through the execution RPC.
9. **The sidecar's receipt lags the chain.** The miner sidecar answered "not found" to
   `eth_getFrameTransactionReceipt` and `skandha_frameTransactionStatus` for more than 2 minutes after ethrex had
   the receipt. The SDK's `waitForFrameTransactionReceipt` now falls back to ethrex's `eth_getTransactionReceipt`,
   which carries `frameReceipts`.
