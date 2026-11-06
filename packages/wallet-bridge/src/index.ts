// @altpool/wallet-bridge: the BridgeAccount contract (ABI + creation code) and its deploy helper.
// The client API (bridgeAccount, typedDataSigner) lives in the SDK: `import { bridgeAccount } from "altpool"`.
import type { Address, Hex } from "viem";
import { bridgeAccountAbi, bridgeAccountBytecode } from "./generated/bridgeAccount";
import deployments from "../deployments.json";

export { bridgeAccountAbi, bridgeAccountBytecode };

/** BridgeAccount deployments on chain 1337, keyed by owner. */
export const bridgeDeployments = deployments as { chainId: number; accounts: Record<Address, { address: Address; deployTx: Hex; deployedAt: string }>; smoke?: unknown };

/** Selector-free tags of the VERIFY frame data; see BridgeAccount.sol. */
export const VERIFY_TAGS = { owner: 0x01, session: 0x02 } as const;

/**
 * Creation gas for BridgeAccount. The HegotaSupport constructor CREATEs 7 opcode helpers and this devnet prices code
 * deposit as state gas: measured 9,667,691 gas used. Wallets that cannot estimate frame-devnet state gas need it given.
 */
export const BRIDGE_DEPLOY_GAS = 12_000_000n;
