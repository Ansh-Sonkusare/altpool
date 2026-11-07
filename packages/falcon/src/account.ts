// Optional post-quantum accounts for the altpool SDK. A FalconWallet's only authority is a Falcon-512 signature; it
// plugs into the SDK through the `signFrame` slot of FrameSigner, so nothing in `altpool` changes:
//
//   const pq = falconAccount({ key: falconKeygen() });          // pq.address exists before the wallet does
//   // fund pq.address (a QuietSend exit can pay it), then deploy it once from any funded account:
//   await wallet.sendTransaction(pq.deployCall());
//   const tx = pq.buildTx({ to, value, nonce: await pq.getNonce(client), maxFeePerGas });
//   await client.altpool.sendFrameTransaction({ transaction: tx, signer: pq.signer, mempool: "alt" });
//
// VERIFY costs ~3.6M-3.9M gas: only the alt mempool admits it (ethrex's public mempool caps VERIFY at 100k).
import { encodeFunctionData, parseAbi, type Address, type Client, type Hex } from "viem";
import { getCode, getTransactionCount } from "viem/actions";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import type { FrameSigner } from "altpool";
import deployments from "../deployments.json";
import { attachFalconSignature, buildFalconSpendTx, pkHashOf, type FalconKey, type SpendOpts } from "./falcon";
import { predictWalletAddress } from "./factory";

/** The shared ZKNOX verifier and the CREATE2 factory on the devnet (deployments.json). */
export const FALCON_DEPLOYMENTS = { verifier: deployments.verifier as Address, factory: deployments.factory as Address };

const factoryAbi = parseAbi(["function deploy(bytes32 pkHash) returns (address)"]);

/** A FrameSigner that fills an ARBITRARY entry with a Falcon-512 signature. Not interactive: it is safe for estimation probes. */
export const falconSigner = (key: FalconKey): FrameSigner => ({
  signFrame: async ({ profile, tx, index }) => attachFalconSignature(profile, tx, key, index),
});

export interface FalconAccountConfig {
  key: FalconKey;
  factory?: Address;
  verifier?: Address;
}

export type FalconTxArgs = Omit<SpendOpts, "wallet" | "key" | "tamper">;

export interface FalconAccount {
  /** CREATE2 address: final before deployment, so it can be paid first. */
  address: Address;
  pkHash: Hex;
  factory: Address;
  verifier: Address;
  signer: FrameSigner;
  /** Unsigned spend from the wallet (sign with `signer`, or let sendFrameTransaction do it). */
  buildTx: (args: FalconTxArgs) => FrameTx;
  /** The factory call that deploys the wallet; send it from any funded account (a balance already at the address stays). */
  deployCall: () => { to: Address; data: Hex };
  isDeployed: (client: Client) => Promise<boolean>;
  /** The wallet's next nonce. Read it, never assume it: a fresh wallet's nonce is 8 (HegotaSupport CREATEs helpers). */
  getNonce: (client: Client) => Promise<bigint>;
}

export function falconAccount(cfg: FalconAccountConfig): FalconAccount {
  const factory = cfg.factory ?? FALCON_DEPLOYMENTS.factory;
  const verifier = cfg.verifier ?? FALCON_DEPLOYMENTS.verifier;
  const pkHash = pkHashOf(cfg.key.publicKey);
  const address = predictWalletAddress({ factory, verifier, publicKey: cfg.key.publicKey });
  return {
    address, pkHash, factory, verifier,
    signer: falconSigner(cfg.key),
    buildTx: (args) => buildFalconSpendTx({ ...args, wallet: address }),
    deployCall: () => ({ to: factory, data: encodeFunctionData({ abi: factoryAbi, functionName: "deploy", args: [pkHash] }) }),
    isDeployed: async (client) => (await getCode(client, { address })) !== undefined,
    getNonce: async (client) => BigInt(await getTransactionCount(client, { address })),
  };
}
