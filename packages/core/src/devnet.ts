// Mirrors docs/01 in the research repo. Change a value there first.
import { defineChain } from "viem";
import type { Address } from "./types";

const env = (k: string): string | undefined => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[k] || undefined;

export const DEVNET = {
  chainId: 1337,
  gatewayUrl: env("GATEWAY_URL") ?? "https://altmempoolgateway.forshtat.com/rpc",
  ethrexUrl: env("ETHREX_URL") ?? "https://altmempool.forshtat.com",
  explorerUrl: "https://explorer.altmempool.wtf",
  profile: "ethrex-eip8141-tracer",
  pool: "0xF8d72424D07721aB219cdbd2852657F3301673fC" as Address,          // Tornado 0.1 ETH, unmodified
  verifier: "0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01" as Address,      // verifyProof(bytes,uint256[6])
  hasher: "0x4500a5B572903a1DE1615d13A366cF2B324675E2" as Address,        // MiMCSponge
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f" as Address, // addStake(uint32) payable
  withdrawSelector: "0x21a0adb6",
  denomination: 10n ** 17n,
  treeLevels: 20,
  rootHistorySize: 100,
  minStakeWei: 10n ** 16n,   // stake STRICTLY more than this
  unstakeDelaySec: 86_400,
  publicVerifyGasCap: 100_000n, // ethrex MAX_VERIFY_GAS, still enforced
  verifyGasMax: 350_000n,       // our self-imposed pin for ExitRelay VERIFY (alt has no cap since Nov 6)
  reputation: { minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50 },
} as const;

export const altDevnet = defineChain({
  id: DEVNET.chainId,
  name: "Alt mempool devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEVNET.ethrexUrl] } },
  blockExplorers: { default: { name: "Alt mempool explorer", url: DEVNET.explorerUrl } },
});

export const explorerTx = (hash: string) => `${DEVNET.explorerUrl}/tx/${hash}`;
