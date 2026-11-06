// Uniswap v4 ETH/fgUSD (0.3%, no hooks) is third-party liquidity: read it fresh every time and price the invoice with the v4 quoter.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseEther, type Address } from "viem";
import { client } from "../altpool";

const STATE_VIEW: Address = "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB";
const QUOTER: Address = "0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D";
/** fgUSD ("FrameGas USD", 6 decimals): another team's test token. */
export const FGUSD: Address = "0x1f9abb072fe931007f58cd7fc56459615e35b908";
const ETH: Address = "0x0000000000000000000000000000000000000000";
const POOL_KEY = [ETH, FGUSD, 3000, 60, ETH] as const;
export const SLIPPAGE_PCT = 3n;
/** The Settler holds 0.09 ETH after the relay's fee; the swap may spend most of it and still leave change. */
const MAX_ETH_IN = parseEther("0.08");

const stateView = parseAbi(["function getLiquidity(bytes32) view returns (uint128)", "function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)"]);
const quoterAbi = parseAbi(["function quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256 amountIn, uint256 gasEstimate)"]);
const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], POOL_KEY));

export interface Quote { amountIn: bigint; maxIn: bigint; liquidity: bigint; fgPerEth: number; at: Date }

export async function quote(amount: bigint): Promise<Quote> {
  const [liquidity, [sqrtP]] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getLiquidity", args: [poolId] }),
    client.readContract({ address: STATE_VIEW, abi: stateView, functionName: "getSlot0", args: [poolId] }),
  ]);
  if (liquidity === 0n) throw new Error("The fgUSD pool has no liquidity right now.");
  const r = await client.call({ to: QUOTER, data: encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactOutputSingle", args: [[POOL_KEY, true, amount, "0x"]] }) });
  const [amountIn] = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactOutputSingle", data: r.data! });
  const maxIn = (amountIn * (100n + SLIPPAGE_PCT)) / 100n;
  if (maxIn > MAX_ETH_IN) throw new Error("The pool is too thin for this amount right now: try a smaller invoice.");
  return { amountIn, maxIn, liquidity, fgPerEth: (Number(sqrtP) / 2 ** 96) ** 2 * 1e12, at: new Date() };
}
