# Uniswap feedback

Notes from building Altpool on Uniswap v4 on a custom devnet (chain 1337). Every point below comes from our own code or runs.

## What we built with Uniswap

- Settler swaps ETH for fgUSD on a v4 ETH/fgUSD pool (0.3%, no hooks) inside one EIP-8141 transaction: [packages/contracts/src/Settler.sol](packages/contracts/src/Settler.sol), driven by [packages/contracts/scripts/pledge.ts](packages/contracts/scripts/pledge.ts).
- The site prices an invoice live from pool state with StateView and V4Quoter: [apps/site/src/livePledge/quote.ts](apps/site/src/livePledge/quote.ts).
- An earlier spike drove the same swap through the Universal Router: [../derisk/spikes/r15-v4-frame-swap/spike.ts](../derisk/spikes/r15-v4-frame-swap/spike.ts).

## What worked well

- The singleton PoolManager made the Settler small. One `unlock`, one `swap`, one `settle`, one `take`, all in a single callback ([Settler.sol](packages/contracts/src/Settler.sol), `unlockCallback`).
- Exact-output swaps fit our case. An invoice needs an exact token amount, so `amountSpecified` is the invoice amount and `maxIn` bounds the cost. The Settler reverts with `InputTooHigh` or `ShortOutput` if the result is off.
- Native ETH in v4 removed the WETH wrap step. `settle{value: owed}()` pays the input directly.
- StateView gave us cheap reads of `getLiquidity` and `getSlot0` for a "pool is empty" guard and a price display ([quote.ts](apps/site/src/livePledge/quote.ts)).
- The v4 quoter returns `amountIn`, so slippage is one line: `maxIn = amountIn * (100 + SLIPPAGE_PCT) / 100`.

## Friction we hit

- **The Quoter is not `view`.** `quoteExactOutputSingle` is non-view, so [quote.ts](apps/site/src/livePledge/quote.ts) (lines 16, 27-28) sends it with `client.call` (an `eth_call`) and decodes the result by hand with `decodeFunctionResult`. The ABI struct is `((address,address,uint24,int24,address),bool,uint128,bytes)`.
- **Computing the poolId.** StateView reads take a `bytes32` pool id, not a key. [quote.ts](apps/site/src/livePledge/quote.ts) line 17 computes it as `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))` by hand, and the pool key is a hardcoded tuple at line 10.
- **Exact-in vs exact-out sign convention.** The Settler passes a positive `amountSpecified` for exact-output ([Settler.sol](packages/contracts/src/Settler.sol), line 109). The spike used the exact-in action `SWAP_EXACT_IN_SINGLE` ([spike.ts](../derisk/spikes/r15-v4-frame-swap/spike.ts), line 47), so our two code paths use two different conventions.
- **BalanceDelta packing.** `swap` returns a packed `int256`. [Settler.sol](packages/contracts/src/Settler.sol) lines 111-112 unpack it by hand: `owed = uint128(-int128(delta >> 128))` and `out = uint128(int128(delta))`. Our own `IPoolManager` interface (line 42) declares the return as a raw `int256`.
- **Native ETH settle semantics.** For native ETH the Settler calls `settle{value: owed}()` with no `sync` call ([Settler.sol](packages/contracts/src/Settler.sol), line 115), then `take` (line 116).
- **Price limit.** For a zero-for-one swap with no limit, the Settler hardcodes `PRICE_LIMIT = 4295128740`, commented as `MIN_SQRT_PRICE + 1` ([Settler.sol](packages/contracts/src/Settler.sol), lines 62-63). `maxIn` bounds the cost instead (line 113).
- **Devnet addresses and the pool.** StateView, Quoter and the fgUSD pool key (fee 3000, tick spacing 60, no hooks) are hardcoded constants ([quote.ts](apps/site/src/livePledge/quote.ts), lines 5-10).
- **Universal Router action encoding.** In the spike, `execute` takes command `0x10` (V4_SWAP) with input `abi.encode(bytes actions, bytes[] params)`. Actions are `0x060c0f`: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, each with its own param encoding ([spike.ts](../derisk/spikes/r15-v4-frame-swap/spike.ts), lines 47-59). We wrote this encoding by hand.

## Docs or tooling we wished for

- A short page of copyable v4 recipes: exact-out swap through `unlock`, with native ETH settle, and the BalanceDelta unpack.
- A documented `poolId` helper in viem or the SDK, plus a note that StateView needs the id.
- A view-style quoter wrapper, or a clear note that the Quoter must be called with `eth_call`.
- A table of Universal Router V4 action bytes with the param encoding for each.
- A canonical way to list deployed v4 addresses for custom chains.

## EIP-8141 atomic batches and swaps

A rolled-back swap frame keeps `status` success with empty logs. This is from our r15 Universal Router spike, run C ([derisk/spikes/r15-v4-frame-swap/out/C.json](../derisk/spikes/r15-v4-frame-swap/out/C.json), whose `hash` matches the tx below). The tx receipt is `reverted`. Its frames report `success`, `success`, `reverted`, and every frame shows `logs: 0`. In C.json the second frame (execution gas 106791) is the swap frame and the third is the failing transfer. Tools that read frame status alone cannot tell whether the swap's effects were kept. Evidence: https://explorer.altmempool.wtf/tx/0x9f9bdc6bcff9db868ea9bc7f0403baee9771b520020c176e883e74a966c6d39d?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc
