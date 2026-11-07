// Browser-wallet plumbing (MetaMask, Rabby): put the wallet on the devnet and prove it really is the devnet.
//
//   const wallet = createWalletClient({ transport: custom(window.ethereum) });
//   await connectAltDevnet(wallet, { client: publicClient });   // switch or add chain 1337, then compare heads
//
// MetaMask ships "Localhost 8545" with chain id 1337, the same as the devnet. Matching chain ids prove nothing, so
// the check compares the wallet's head with the devnet's.
import type { Chain, Client } from "viem";
import { getBlockNumber } from "viem/actions";
import { altDevnet } from "@altpool/core";
import { WrongNetworkError } from "./errors";

/** The slice of a viem WalletClient (or anything EIP-1193-backed) these helpers use. */
export interface NetworkWallet {
  /** EIP-1193 request. Loosely typed so viem's method-typed WalletClient.request fits; only eth_chainId and eth_blockNumber are called. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: (args: any) => Promise<unknown>;
  switchChain: (args: { id: number }) => Promise<void>;
  addChain: (args: { chain: Chain }) => Promise<void>;
}

export interface WalletNetwork {
  chainId: number;
  walletBlock: bigint;
  devnetBlock: bigint;
}

export interface NetworkCheckOptions {
  /** A client on the devnet's execution RPC. */
  client: Client;
  chain?: Chain;
  /** Heads further apart than this mean a different chain (default 20 blocks, 2 minutes at 6 s). */
  maxBlockDrift?: bigint;
}

/** Read-only: throws WrongNetworkError unless the wallet's active chain is the devnet. */
export async function checkWalletNetwork(wallet: Pick<NetworkWallet, "request">, opts: NetworkCheckOptions): Promise<WalletNetwork> {
  const chain = opts.chain ?? altDevnet;
  const chainId = Number(BigInt((await wallet.request({ method: "eth_chainId" })) as string));
  if (chainId !== chain.id) {
    throw new WrongNetworkError(`The wallet is on chain ${chainId}, not ${chain.id}.`, { fix: "Call connectAltDevnet(wallet, ...) or switch networks in the wallet." });
  }
  const [walletBlock, devnetBlock] = await Promise.all([
    wallet.request({ method: "eth_blockNumber" }).then((h) => BigInt(h as string)),
    getBlockNumber(opts.client, { cacheTime: 0 }),
  ]);
  const drift = walletBlock > devnetBlock ? walletBlock - devnetBlock : devnetBlock - walletBlock;
  if (drift > (opts.maxBlockDrift ?? 20n)) {
    throw new WrongNetworkError(
      `The wallet's chain ${chainId} is at block ${walletBlock}, the devnet at ${devnetBlock}: it is a different network with the same chain id.`,
      { fix: `In the wallet, remove or rename the other chain-${chainId} network (MetaMask's "Localhost 8545"), then add ${chain.rpcUrls.default.http[0]}.` },
    );
  }
  return { chainId, walletBlock, devnetBlock };
}

/** Switch the wallet to the devnet (adding the network if the wallet does not know it), then checkWalletNetwork. */
export async function connectAltDevnet(wallet: NetworkWallet, opts: NetworkCheckOptions): Promise<WalletNetwork> {
  const chain = opts.chain ?? altDevnet;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    // 4902 "unrecognized chain" on MetaMask; other wallets use other codes, so any failure falls through to add.
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
  return checkWalletNetwork(wallet, opts);
}
