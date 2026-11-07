# Live devnet suite

> Model fixed after this run; see RESULTS.md. The prediction column below is the original live run, not re-predicted (live-suite.ts has no offline re-predict). Fixed: stake delay is compared with the node minimum (0), not our 86400, so case 4 alt is now predicted admitted; the rule parser now names signature, expiry and atomic-batch errors.

Run: 2026-11-07T17:15:02.438Z to 2026-11-07T17:19:36.889Z (274s), chain 1337.

Each tx is predicted by `createSimulator({ explorer: false, estimate: false })` on the signed raw tx before it is sent, so the node has no record of it. It is then sent (public: ethrex `eth_sendRawTransaction`; alt: the miner sidecar) and the node's answer is recorded.

Prediction source: `simulate` = ethrex's own simulation (verified). `model` = our local alt rule model (unverified).

**Matched 16 of 17 attempts.** Predicted by ethrex: 9 of 9 matched. Predicted by the model: 7 of 8 matched. Skipped: 1.

| Case | Mempool | Prediction (source) | Node outcome | Match | Tx |
| --- | --- | --- | --- | --- | --- |
| 1. plain self-paid frame tx (VERIFY 60k) | public | admitted (simulate, verified) | admitted, included in block 20781 | yes | [0x174e06af…98e63d](https://explorer.altmempool.wtf/tx/0x174e06afd24bf517bf0d602866b71d5a28446f0cddce53f26883b8db5798e63d?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 1. plain self-paid frame tx (VERIFY 60k) | alt | admitted (model, unverified) | admitted, not included within the wait (sidecar status New) | yes | [0x80c24c77…416cf9](https://explorer.altmempool.wtf/tx/0x80c24c777b0ed53f368e422d57ee994c461c6f43803aebba7d7df70fba416cf9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 2. VERIFY gas 150k, over the 100k public cap | public | rejected [public-gas-cap] (simulate, verified) | rejected [public-gas-cap] -32000: Invalid params: Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS | yes | [0xa7a6d46c…2e5644](https://explorer.altmempool.wtf/tx/0xa7a6d46c58b2cce61f695dd1e00267117d473cb041cd3802bd4e9c00742e5644?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 2. VERIFY gas 150k, over the 100k public cap | alt | admitted (model, unverified) | admitted, not included within the wait (sidecar status New) | yes | [0x4a002274…defbf9](https://explorer.altmempool.wtf/tx/0x4a0022744be619099ee1e07a439ca76093bf6915905a7a0cde637c6821defbf9?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 3. unstaked contract whose VERIFY reads another contract's storage | public | rejected [public-storage] (simulate, verified) | rejected [public-storage] -32000: Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender | yes | [0x281eb048…773cfe](https://explorer.altmempool.wtf/tx/0x281eb048d081fe5699e5489c18541cc3ec840ee87ac878daa8f2468eda773cfe?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 3. unstaked contract whose VERIFY reads another contract's storage | alt | rejected [storage] (model, unverified) | rejected [storage] -32502: unstaked payer accessed 0xaf1675799c967019034b1808919f27cc6cd29d30 slot 0x0000000000000000000000000000000000000000000000000000000000000000 | yes | [0xfc916dbb…3ab4ac](https://explorer.altmempool.wtf/tx/0xfc916dbb1787bf102867773495ffb7e53cac88eb83d9932fd76278ded63ab4ac?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 4. the same contract, staked | public | rejected [public-storage] (simulate, verified) | rejected [public-storage] -32000: Invalid params: Frame transaction validation-prefix simulation failed: StorageReadNonSender | yes | [0xcb9ebe4d…7636ec](https://explorer.altmempool.wtf/tx/0xcb9ebe4dd8fec05353750e855d9c53bbc7a292cf813c9aa76ec6ad1c2c7636ec?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 4. the same contract, staked | alt | rejected [storage] (model, unverified) | admitted, not included within the wait (sidecar status New) | no | [0x5b7a6f0d…9dfcd5](https://explorer.altmempool.wtf/tx/0x5b7a6f0d5cb36e21dd1a1254560438b89c5dab0bbf44f6040a207928599dfcd5?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 5. bad signature | public | rejected [unknown] (simulate, verified) | rejected [signature] -32000: Invalid params: Invalid frame transaction signature | yes | [0xee198501…7e536e](https://explorer.altmempool.wtf/tx/0xee198501217aeeba524243b527437ac388ef88799a1431af08a252c8737e536e?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 5. bad signature | alt | rejected [unknown] (model, unverified) | rejected [signature] -32507: Invalid frame transaction signature | yes | [0x14644529…550431](https://explorer.altmempool.wtf/tx/0x146445298a3449950c803000c07171c07a92e059f258508dde16452bc6550431?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 6. ATOMIC_BATCH flag on the last frame | public | rejected [unknown] (simulate, verified) | rejected [unknown] -32000: Invalid params: Invalid frame transaction: Frame 1: atomic batch flag on last frame | yes | [0x4f3fa488…503942](https://explorer.altmempool.wtf/tx/0x4f3fa488b28a56b4fca9dda466078c2fcec0e5e58c8f60c5e1911c9b71503942?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 6. ATOMIC_BATCH flag on the last frame | alt | rejected [unknown] (model, unverified) | rejected [unknown] -32500: Frame 1: atomic batch flag on last frame | yes | [0x3cdee6b1…4f621f](https://explorer.altmempool.wtf/tx/0x3cdee6b199ea81a4bef24b0ee35b173f3a82a35be7546c11531f87b30d4f621f?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 7. nonce replay of an included tx | public | rejected [simulation] (simulate, verified) | rejected [simulation] -32000: Invalid params: Frame transaction validation-prefix simulation failed: Invalid Transaction: Nonce mismatch: expected 1, got 0 | yes | [0x174e06af…98e63d](https://explorer.altmempool.wtf/tx/0x174e06afd24bf517bf0d602866b71d5a28446f0cddce53f26883b8db5798e63d?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 8. expiry deadline in the past | public | rejected [simulation] (simulate, verified) | rejected [unknown] -32000: Invalid params: Frame transaction expiry deadline has passed | yes | [0x868eb24e…1bc173](https://explorer.altmempool.wtf/tx/0x868eb24ece4b0c17d7d9fd8c92f9b7c99b1343be68d4c0a7dfb6d66de51bc173?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 8. expiry deadline in the past | alt | rejected [simulation] (model, unverified) | rejected [simulation] -32500: validation frame 0: reverted | yes | [0x1e5bccae…726dd2](https://explorer.altmempool.wtf/tx/0x1e5bccae8e08e2c39cc5e27ba891c15d7c2e8aaa31fa96d5f1b6e42b75726dd2?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 9. double-spend: newest included ExitRelay exit, re-sent (block 8545, original 0x77092af5c049ccb645a2ae535475ee751107f019e472ca1d7441d12c3d57db25) | public | rejected [simulation] (simulate, verified) | rejected [unknown] -32000: Invalid params: Frame transaction expiry deadline has passed | yes | [0x77092af5…57db25](https://explorer.altmempool.wtf/tx/0x77092af5c049ccb645a2ae535475ee751107f019e472ca1d7441d12c3d57db25?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |
| 9. double-spend: newest included ExitRelay exit, re-sent (block 8545, original 0x77092af5c049ccb645a2ae535475ee751107f019e472ca1d7441d12c3d57db25) | alt | rejected [simulation] (model, unverified) | rejected [structure] -32500: prefix gas budget exceeded: 450000 > 100000 (MAX_VERIFY_GAS) | yes | [0x77092af5…57db25](https://explorer.altmempool.wtf/tx/0x77092af5c049ccb645a2ae535475ee751107f019e472ca1d7441d12c3d57db25?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) |

Rejected txs never reach a block. Their links use the locally computed hash and may show no record on the explorer.

## Notes

Match means the predicted verdict (admitted or rejected) equals the node's. `[rule]` is our rule id, derived from the node's own error text for the outcome. Rejections whose rule ids differ:

- Case 5 public: predicted unknown, node signature.
- Case 5 alt: predicted unknown, node signature.
- Case 8 public: predicted simulation, node unknown.
- Case 9 public: predicted simulation, node unknown.
- Case 9 alt: predicted simulation, node structure.

Verdict mismatches:

- Case 4 alt: predicted rejected [storage] (model); node admitted. Stake sender 0x242b11e48466a63171d1027cc33ad834db4eb5ba in the staking registry (> 0.01 ETH, 1-day unstake delay), then resend to the alt mempool. If it is already staked, check its reputation: a banned entity is reported as unstaked.


## Skipped

- Case 7, nonce replay of an included tx (alt): the case-1 alt tx was not included within the wait, so there is no included tx to replay

## Entities

- Violating wallet: `0x242b11e48466a63171d1027cc33ad834db4eb5ba`, Foreign: `0xaf1675799c967019034b1808919f27cc6cd29d30`
- Wallet stake tx: [0xb6e816bc…10b952](https://explorer.altmempool.wtf/tx/0xb6e816bc643b723c25edf950c945f878ea5ee54bd59e09a18666de710810b952?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc); stake 12000000000000000 wei, unstake delay 0s, state staked, node says staked: true

Reproduce: `bun run --filter @altpool/simulator live-suite`. It uses a fresh key each run.
