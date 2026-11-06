// Pools besides the devnet's 0.1 ETH Tornado: the WETH9 predeploy and an ERC20Tornado over it (scripts/deploy-weth-pool.ts).
import { parseAbi } from "viem";
import type { Address } from "viem";

/** WETH9 predeployed on the devnet (name "Wrapped Ether", 18 decimals). */
export const WETH9: Address = "0x1b7d32025f7ca633943bbcc9ec61a98ef66187b6";

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const erc20PoolAbi = parseAbi([
  "function deposit(bytes32 _commitment) payable",
  "function denomination() view returns (uint256)",
  "function token() view returns (address)",
  "function verifier() view returns (address)",
  "function operator() view returns (address)",
  "function levels() view returns (uint32)",
  "function getLastRoot() view returns (bytes32)",
  "function hashLeftRight(bytes32 _left, bytes32 _right) view returns (bytes32)",
]);
