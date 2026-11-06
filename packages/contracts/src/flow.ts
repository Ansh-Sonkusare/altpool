// The deposit half of an exit and the miner-sidecar constants, shared by scripts/exit-smoke.ts and the quietsend CLI.
import { createPublicClient, http, parseAbi, type Account, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import { DEVNET, altDevnet, explorerTx, type Note } from "@altpool/core";

/** The miner's own sidecar. The gateway admits exits but does not gossip them to it. */
export const MINER_SIDECAR = "https://altmempool.forshtat.com/rpc";

/** Explorer link on the miner node's view: the explorer defaults to the gateway, which never sees exits sent here. */
export const explorerExit = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(MINER_SIDECAR)}`;

const poolAbi = parseAbi(["function deposit(bytes32 _commitment) payable"]);

export async function depositNote(wallet: WalletClient<Transport, Chain, Account>, note: Note): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: DEVNET.pool,
    abi: poolAbi,
    functionName: "deposit",
    args: [note.commitment],
    value: DEVNET.denomination,
    gas: 2_000_000n,
    type: "legacy",
  });
  const receipt = await createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`deposit ${hash} reverted`);
  return hash;
}
