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
- Limits: a fresh ExitRelay per run; reading pool storage is not FOCIL-eligible.
