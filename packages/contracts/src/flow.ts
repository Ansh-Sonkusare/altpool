// The deposit / send-and-confirm halves of an exit, shared by scripts/exit-smoke.ts and the quietsend CLI.
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, http, parseAbi, type Account, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import { DEVNET, altDevnet, explorerTx, gateway, toWire, type Note } from "@altpool/core";

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

export interface ExitResult {
  hash: Hex;
  status: string;
  blockNumber: number;
  gasUsed: number;
  frames: { status: string; gasUsed: number; stateGasUsed: number }[];
}

export async function sendExit(tx: FrameTx, o: { sendUrl?: string } = {}): Promise<ExitResult> {
  const send = gateway(o.sendUrl ?? process.env.SEND_URL ?? MINER_SIDECAR);
  const hash = await send.sendFrameTransaction(toWire(tx));
  let receipt: unknown = null;
  for (let i = 0; i < 90 && !receipt; i++) {
    await sleep(2000);
    receipt = await send.receipt(hash).catch(() => null);
  }
  if (!receipt) throw new Error(`no receipt for ${hash} after 180 s`);
  // ethrex frame receipt (RPC data): only frameReceipts is structural, so check it before reading.
  const r = receipt as { status: string; gasUsed: string; blockNumber: string; frameReceipts: { status: string; gasUsed: string; stateGasUsed?: string }[] };
  if (!Array.isArray(r.frameReceipts)) throw new Error(`receipt has no frameReceipts: ${JSON.stringify(receipt)}`);
  const failed = r.frameReceipts.findIndex((f) => BigInt(f.status) !== 1n);
  if (BigInt(r.status) !== 1n || failed >= 0) {
    throw new Error(`exit ${hash} failed: tx status ${r.status}${failed >= 0 ? `, frame ${failed} status ${r.frameReceipts[failed]!.status}` : ""}`);
  }
  return {
    hash,
    status: r.status,
    blockNumber: Number(r.blockNumber),
    gasUsed: Number(r.gasUsed),
    frames: r.frameReceipts.map((f) => ({ status: f.status, gasUsed: Number(f.gasUsed), stateGasUsed: Number(f.stateGasUsed ?? 0) })),
  };
}
