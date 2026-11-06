# ExitRelay

ExitRelay is a smart-account sender for EIP-8141 frame transactions on the ERC-8421 alt mempool. It lets a Tornado Cash withdrawal land at a recipient holding 0 ETH: the exit transaction is sent *from* ExitRelay, its VERIFY frame approves execution and payment, and gas is repaid out of the withdrawal fee (`EXIT_FEE` = 0.01 ETH, `relayer = ExitRelay`). Trustless mode only: no co-signer, no attested mode, no admin, no unlock path for stake.

## Transaction layout

`exitTx()` in `src/exit.ts` is the single source for this layout; `ExitRelay.sol` pins the same limits.

| # | Mode | Target | Gas / state limit | Data |
|---|------|--------|-------------------|------|
| 0 | VERIFY (flags 0) | `0x…8141` expiry verifier | 10,000 | 8-byte big-endian deadline, 600 s grid |
| 1 | VERIFY, scope `EXECUTION_AND_PAYMENT` | ExitRelay | 450,000 | `abi.encode(uint256 rootIdx)` |
| 2 | SENDER | Tornado pool | 1,000,000 exec / 300,000 state, value 0 | `withdraw(proof, root, nullifierHash, recipient, exitRelay, fee, 0)` |

Sender = ExitRelay, nonce key = `nullifierHash`, nonce seq 0, no signatures.

## VERIFY check order (cheapest first)

Static, over values read with the frame opcodes (`ExitRelayChecks.checkStatic`):

1. Frame count = 3; shapes of frames 0, 1, 2 (targets, modes, gas/state limits, value 0).
2. `MAX_COST <= FEE`.
3. Withdraw calldata: selector, `relayer == self`, `fee == FEE`, `refund == 0`, proof length 256.
4. Nonce: one key, equal to `nullifierHash`, seq 0; at most one signature (never read).
5. Root index `< 100`, root nonzero.

Then state (`checkState`):

6. `pool.roots(rootIdx) == root` (`UnknownRoot`).
7. `!pool.isSpent(nullifierHash)` (`NullifierSpent`).
8. `verifier.verifyProof(...)` **last**, in try/catch: `false` → `BadProof`, revert → `VerifierReverted`.

Then `APPROVE(EXECUTION_AND_PAYMENT)`. The pool is read only by index: `isKnownRoot`, `currentRootIndex` and `nextIndex` change on every deposit and would invalidate every pending exit (docs/03).

## Patched verifier

The devnet Tornado v2.0 Verifier calls the precompiles with `staticcall(sub(gas(),2000), …)`. ERC-7562 OP-012 bans `GAS` unless directly before a `*CALL`, and the gateway rejected the exit: `payer uses banned opcode: GAS`.

`scripts/deploy.ts` copies the on-chain runtime and rewrites exactly 3 sites, `PUSH2 0x07d0 GAS SUB` → `JUMPDEST ×4 GAS` (`src/verifier-patch.ts`). Same length, so jump offsets and the verifying key are byte-identical; only 15 bytes differ. Deploy then asserts the copy and the original agree on a real proof (true) and on fee+1 (false). The pool still re-verifies with its own, unpatched verifier in the SENDER frame, which is not validation-traced.

## Gas (measured, public devnet, receipt of the exit below)

| Frame | Used | Pin |
|-------|------|-----|
| 0 expiry | 3,051 | 10,000 |
| 1 VERIFY | 374,217 | `VERIFY_GAS_MAX` 450,000 |
| 2 withdraw | 300,069 execution + 281,520 state | 1,000,000 / 300,000 |

State gas is EIP-8037 at 1530 gas/byte: new recipient account 120 B = 183,600, nullifier slot 64 B = 97,920. Total `gasUsed` 979,542; at ~1 gwei that is ~0.00098 ETH real cost against a 0.01 ETH fee. The fee cap is `maxFeePerGas = EXIT_FEE / 1,850,000`, so `max_cost <= FEE`.

The pin is 450k, not the planned 350k: at 350k the verifier ran out of gas inside VERIFY (about 30 hegota-support helper CALLs plus the 63/64 rule), which the try/catch reported as a failed proof.

Why ~375k of validation is acceptable (docs/02): fixed cost, no loops, no input-dependent work; cheap checks run before the pairing, so malformed, spent or stale sends fail cheaply; invalidation is bounded (only the note's own withdrawal or ~100 deposits can invalidate a pending exit); ExitRelay is staked, so reputation can throttle it; and it removes the relayer and co-signer, the only parties who could censor (CROPS). Per docs/01 the alt sidecar has had no validation cap since Nov 6 (per the devnet team); 450k is our self-imposed pin. The public ethrex mempool still caps at 100k, so the public simulate reports invalid, which is expected: `prefix gas budget exceeded: 450000 > 100000`.

## Run it

```
bun run --filter @altpool/contracts abi && bun run --filter @altpool/contracts deploy
bun run --filter @altpool/contracts exit -- --junk   # opcode probe: must end in BadProof
SEND_URL=https://altmempool.forshtat.com/rpc bun run --filter @altpool/contracts exit
```

`SEND_URL`: on Nov 6 the gateway sidecar (`bundlingMode` manual) admitted exits but did not gossip them to the miner sidecar (other teams' txs were stuck too), so we submit to the miner's own sidecar.

## Live evidence (devnet, Nov 6)

**Explorer view:** exits are sent to the miner sidecar, but the explorer defaults to the gateway node, which never received them; for runs that replayed the identical tx to the gateway it shows that rejected replay as "Rejected". Open exit links with `?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc` (or pick **Miner** in the node menu) to see them `OnChain`, e.g. [ExitRelayRR exit, miner view](https://explorer.altmempool.wtf/tx/0xa015c4c7d411030a9fde923866c8773997cd2d17992388735f5cb400a7ed6ee3?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc). Scripts now print miner-view links, and the replay is a distinct tx (priority fee + 1 wei) so it no longer shares the exit's hash.

- ExitRelay: `0x2576dcb7c8dc6c19cd6e39c8d49de03389b0ea6f` (deploy `0x875380e6…b105c`, stake `0xe60f892d…05f07`)
- Patched verifier: `0x43168942ab0d0272c7a7efd6f6540266afb7c1b3`
- [Deposit](https://explorer.altmempool.wtf/tx/0x6ce9723c5994825e8151940e7f90a37df3311b7ff82eba59974cf70972c12da2)
- [Exit](https://explorer.altmempool.wtf/tx/0x5ceab9fd792a5e39a4f74d0a480ca1d8e5f75281510e10f506ac79552b4a9a9c): block 0x1883, all 3 frames status 1, recipient 0 → 0.09 ETH
- Second run ([deposit](https://explorer.altmempool.wtf/tx/0x22e982fb9a267997eaff73094e1ec1a0a3295e7d63284bd74f867c7d1cbb4bc7), [exit](https://explorer.altmempool.wtf/tx/0x3d1c2cebf96ad2502941aaaeb07437cb15ba0be28383f1831b3c3e998d56dfd8)): block 6298, identical per-frame gas (3,051 / 374,217 / 300,069 + 281,520 state).
- Replay of the included exit: rejected by both sidecars at admission (`-32500`, `simulation` rule; the detail text they print is the public-mempool violation, not the cause). Re-simulating the same tx after inclusion gives the cause: `Nonce mismatch: expected 1, got 0`, the nullifier's nonce key is consumed. `exit-smoke` fails unless the replay fails for that reason (third run: [exit](https://explorer.altmempool.wtf/tx/0xbaf4b795d20d8792aeea42876b8deb8c7785d5e19a72e4b6460496f832ca8415), block 6340).

## Trust and limits

- **Funds (I1):** the pool re-verifies the proof; recipient, relayer and fee are public inputs, so a relayer cannot redirect or inflate. Soundness holds given the 2019 setup.
- **Losses (I3):** a junk proof fails VERIFY before payment is approved; at most one loss per real deposit.
- No admin, no unlock path for stake.
- Limits: a fresh ExitRelay per run; reading pool storage is not FOCIL-eligible (ExitRelayRR below removes that read).

## ExitRelayRR: no foreign storage in VERIFY (EIP-8272 recent roots)

A second, separate contract (`src/ExitRelayRR.sol`); ExitRelay above is unchanged. Design and citations: research repo `derisk/notes/r13-recent-roots.md`.

- **Root:** anyone calls `publishRoot()`, which copies `pool.getLastRoot()` into the EIP-8272 predeploy (`0x…8272`) under ExitRelayRR's own `rootSource = keccak256(address(this) ‖ 0)`. The exit tx carries one `recentRootReference { rootSource, slot, root }`; consensus validates it before any frame runs, and VERIFY reads it with `0xB6` through a 12-byte helper (Solidity can't emit `0xB6`), requiring `source == rootSource` (`BadRootSource`) and `root == withdraw root` (`UnknownRoot`).
- **No `isSpent`:** replays are already impossible (nonce key = nullifier, consumed at APPROVE). Cost of dropping it: an owner who withdraws a note directly and then submits an exit for it makes ExitRelayRR pay that exit's gas with no fee, once per note (~0.002 ETH, at most `EXIT_FEE`).
- **Frame 1 data is one ignored byte:** empty calldata would route to `receive()`, which returns without APPROVE (found live: `frame 2 is a SENDER frame but no frame approved execution`).
- **Liveness:** a published root is referenceable from the next slot for 8191 slots (~13.6 h) and until 100 more deposits; someone with ETH must republish (~140k gas).
- **FOCIL:** VERIFY reads no foreign storage, so exits are eligible by construction. Forced inclusion itself can't be shown on this devnet: inclusion lists come only from ethrex's public mempool, which still rejects the 450k VERIFY; one validator. The alt mempool remains required for the gas.

Run: `bun run --filter @altpool/contracts deploy -- --rr`, then `bun run --filter @altpool/contracts exit -- --rr` (deposit → publishRoot → prove against the published root → traced simulate asserting no foreign storage reads in VERIFY → send → balance and replay gates).

Live (Nov 6): ExitRelayRR `0x86ea983cfd294ffa8a67aa353c67054c38e95170`; [publishRoot](https://explorer.altmempool.wtf/tx/0x79ac8cb91951d23e68bd83e0b2975f52293602445d0633dc997097fb4b8464b6) (slot 6552); [exit](https://explorer.altmempool.wtf/tx/0xa015c4c7d411030a9fde923866c8773997cd2d17992388735f5cb400a7ed6ee3) (block 6567): `foreign storage reads in VERIFY: none`, frames 3,051 / 368,270 / 306,969 + 281,520 state, recipient 0 → 0.09 ETH, replay `Nonce mismatch: expected 1, got 0`. VERIFY is 5,947 gas cheaper than ExitRelay; the withdraw frame is ~6.9k dearer because VERIFY no longer warms the pool's slots.

## Other pools: ExitRelay in front of an ERC20 Tornado pool (WETH)

The devnet has one Tornado pool (0.1 ETH). To show ExitRelay is not tied to it, we deployed a second one: tornado-core v2.0 `ERC20Tornado` over the predeployed WETH9 (`0x1b7d…87b6`, "Wrapped Ether"), 0.1 WETH denomination, 20 levels, the same original verifier and MiMC hasher as the ETH pool. Its `withdraw(proof, root, nullifierHash, recipient, relayer, fee, refund)` binds relayer and fee exactly like the ETH pool's, so `ExitRelayToken` (`src/ExitRelayToken.sol`: `ExitRelay` plus `token` and `unwrapFees()`; `ExitRelay.sol` and the live ExitRelay are untouched) uses the same three frames, the same VERIFY and the same patched verifier.

- **Vendored, unmodified:** `vendor/tornado-core-v2.0/` (tag `v2.0`, commit `7033f34`, GPL-3.0) and the one OpenZeppelin 2.4.0 file it imports (`ReentrancyGuard.sol`, commit `cdf655f`, MIT). They need solc 0.5.17, so they build under a separate profile and never enter the 0.8.28 project: `forge build --profile tornado` → `out/tornado/`.
- **Hasher:** v2.0 links `Hasher` as a library; `scripts/deploy-weth-pool.ts` links it to the predeployed hasher `0x4500…75e2` and checks that `hashLeftRight` on the new pool equals the ETH pool's on a probe pair.
- **Fee in a token:** the pool pays the fee as WETH to ExitRelayToken, but the exit's gas is still paid in ETH from the relay's float. `unwrapFees()` (permissionless) calls `WETH.withdraw(balance)` so the fee WETH becomes float again; WETH9 pays with `transfer`, which ExitRelay's empty `receive()` accepts.
- **The recipient gets WETH and holds 0 ETH.** Unwrapping it needs a gas-paying transaction, which a 0-ETH account cannot send: the recipient has to be funded or use another sponsored route.
- **Prover:** `rootFor` / `prove` / `proveForRoot` take an optional pool address (default: the ETH pool).

Run: `forge build --profile tornado`, `bun scripts/deploy-weth-pool.ts`, `bun run --filter @altpool/contracts deploy -- --weth`, `bun run --filter @altpool/contracts exit -- --weth` (fresh faucet depositor: wrap 0.1 ETH, approve, deposit, prove against the WETH pool, exit, assert recipient 0.09 WETH and 0 ETH and relay WETH +0.01, `unwrapFees()`, replay gate). `deployments.json` keys: `wethPool`, `wethPoolTx`, `exitRelayWETH`, `exitRelayWETHDeployTx`, `exitRelayWETHStakedAt`.

Live (Nov 7): pool `0x8b9e63aadfe58e413b0082933f3eaf303c5a4425` ([deploy](https://explorer.altmempool.wtf/tx/0x77d91537d6b0867df6a1065323f70d9cf3d9d3af7e85375daf1d2549cf957cb2), gas used 15,533,909; `denomination()` = 0.1e18, `token()` = WETH9, empty-tree `getLastRoot()` = `0x29d7…96d4`); ExitRelayToken `0x54ab32a58f046330a92891aa6d9e01147b56128a` ([deploy](https://explorer.altmempool.wtf/tx/0x308543e66c01ef43248d3b4522834a3092de205fa18b67b82034c733650fc924), [stake](https://explorer.altmempool.wtf/tx/0xc7c88810d4d05af96647d29ec90457c7fca13e5485594fbbc831a4182858712e)). Exit [`0x96ce2e75…1226`](https://explorer.altmempool.wtf/tx/0x96ce2e7586a445957104bdf22db95e6275e3d97715a8b71ae5d667d6eb911226?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) (block 8269, all 3 frames success): recipient 0 → 0.09 WETH, 0 ETH; relay WETH +0.01; frames 3,051 / 374,325 / 328,225 + 293,760 state (the pin is 300,000, so ~6k of headroom; 293,760 is 3 × the 97,920 a fresh slot cost in the ETH exit). `unwrapFees()` [`0x15e97631…543f`](https://explorer.altmempool.wtf/tx/0x15e976319438ef95e13cea8f5bea8d3b7ce90f8cdbdfaf8814d71f94934b543f): relay WETH 0.01 → 0, relay ETH +0.01, 36,213 gas. Replay re-simulated: `Nonce mismatch: expected 1, got 0`.
