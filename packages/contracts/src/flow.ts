// The deposit and send halves of an exit, shared by scripts/exit-smoke.ts, the quietsend CLI and apps/demo.
import { createPublicClient, http, parseAbi, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET, altDevnet, explorerTx, type Note } from "@altpool/core";
import { WETH9, erc20PoolAbi, wethAbi } from "./pools";

/** The miner's own sidecar (core's DEVNET.minerSidecarUrl, env MINER_SIDECAR_URL). The gateway admits exits but does not gossip them to it. */
export const MINER_SIDECAR = DEVNET.minerSidecarUrl;

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

/** Wrap one denomination of ETH, approve the ERC20 pool, and deposit the note: the WETH-pool counterpart of depositNote. */
export async function depositNoteWeth(wallet: WalletClient<Transport, Chain, Account>, note: Note, pool: Address): Promise<Hex> {
  const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const step = async (hash: Hex, what: string) => {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${what} ${hash} reverted`);
    return hash;
  };
  const tx = { gas: 2_000_000n, type: "legacy" } as const;
  await step(await wallet.writeContract({ address: WETH9, abi: wethAbi, functionName: "deposit", value: DEVNET.denomination, ...tx }), "WETH deposit");
  await step(await wallet.writeContract({ address: WETH9, abi: wethAbi, functionName: "approve", args: [pool, DEVNET.denomination], ...tx }), "WETH approve");
  return step(await wallet.writeContract({ address: pool, abi: erc20PoolAbi, functionName: "deposit", args: [note.commitment], ...tx }), "pool deposit");
}

export interface ExitResult {
  hash: Hex;
  status: string;
  blockNumber: number;
  gasUsed?: number;
  frames: { status: string; gasUsed: number; stateGasUsed: number }[];
}

/** Submit through the altpool SDK and wait for inclusion; throws unless the tx and every frame succeeded. */
export async function sendExit(tx: FrameTx, o: { sendUrl?: string } = {}): Promise<ExitResult> {
  const sidecar = createAltMempoolClient({ httpUrl: o.sendUrl ?? process.env.SEND_URL ?? MINER_SIDECAR, profile: getProfile(DEVNET.profile), name: "send", timeoutMs: 90_000 }); // the miner sidecar often takes >20 s to answer a send
  const sdk = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar }));
  // submit, not send: the exit sender is the ExitRelay contract (zero signatures) and ExitRelay pins frame gas.
  const { hash } = await sdk.altpool.submitFrameTransaction({ transaction: tx });
  const { receipt: r } = await sdk.altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 180_000, throwOnRevert: true });
  // throwOnRevert checks only the tx status; a frame can fail inside a successful tx.
  const failed = r.frames.find((f) => f.status !== "success");
  if (failed) throw new Error(`exit ${hash} frame ${failed.index} ${failed.status}`);
  return {
    hash,
    status: r.status,
    blockNumber: Number(r.blockNumber),
    gasUsed: r.gasUsed === undefined ? undefined : Number(r.gasUsed),
    frames: r.frames.map((f) => ({ status: f.status, gasUsed: Number(f.gasUsed.execution), stateGasUsed: Number(f.gasUsed.state) })),
  };
}
