// Reads one included frame transaction: the raw tx (frames, sender) plus the sidecar's per-frame receipt.
// Nothing here is cached or hard-coded beyond hashes and names; every number comes from the devnet.
import { deployments, invoiceBookAbi, settlerAbi, settlerFactoryAbi } from "@altpool/contracts";
import { DEVNET } from "altpool";
import { decodeFunctionData, isAddressEqual, parseAbi, toFunctionSelector, type AbiFunction, type Address, type Hex } from "viem";
import { client } from "./altpool";

export const EXPIRY: Address = "0x0000000000000000000000000000000000008141";

const NAMES: [string, string][] = [
  [deployments.exitRelay, "ExitRelay"],
  [deployments.exitRelayWETH, "ExitRelayToken"],
  [deployments.payRelayWETH, "PayRelayWETH"],
  [deployments.settlerFactory, "SettlerFactory"],
  [deployments.invoiceBook, "InvoiceBook"],
  [DEVNET.pool, "ETH pool (Tornado 0.1 ETH)"],
  [deployments.wethPool, "WETH pool (Tornado 0.1 WETH)"],
  ["0x1b7d32025f7ca633943bbcc9ec61a98ef66187b6", "WETH9"],
  ["0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be", "Uniswap v4 Universal Router"],
  ["0x1f9abb072fe931007f58cd7fc56459615e35b908", "fgUSD"],
  [EXPIRY, "expiry verifier"],
];
export const nameOf = (a: string): string | undefined => NAMES.find(([n]) => n.toLowerCase() === a.toLowerCase())?.[1];

const abi = [...parseAbi([
  "function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
] as const), ...settlerAbi, ...settlerFactoryAbi, ...invoiceBookAbi.filter((f) => f.type === "function")] as readonly AbiFunction[];
const SELECTORS = new Map<string, string>(abi.map((f) => [toFunctionSelector(f), f.name]));

export type Mode = "DEFAULT" | "VERIFY" | "SENDER";
const MODES: Mode[] = ["DEFAULT", "VERIFY", "SENDER"];
const SCOPES = ["none", "execution", "payment", "execution + payment"];
const ATOMIC = 4;

/** Where a frame sits relative to atomic batches: members carry the flag, the next unflagged frame ends the batch. */
export type Batch = "atomic" | "ends batch" | "outside";
/** The receipt status, except that a frame inside a failed batch is "rolled back" although its receipt says success. */
export type FrameStatus = "success" | "reverted" | "rolled back" | (string & {});

export interface FrameRow {
  index: number;
  mode: Mode;
  approves?: string;
  batch: Batch;
  target: Address;
  targetName?: string;
  call: string;
  gasLimit: bigint;
  stateLimit: bigint;
  used?: { execution: bigint; state: bigint };
  status?: FrameStatus;
}
export interface FrameTxView {
  hash: Hex;
  block: number;
  sender: Address;
  status: string;
  frames: FrameRow[];
}

const rpc = <T,>(method: string, params: unknown[]): Promise<T> => (client as unknown as { request(a: { method: string; params: unknown[] }): Promise<T> }).request({ method, params });

interface WireFrame { mode: Hex; flags: Hex; to: Address | null; gasLimit: Hex; stateLimit: Hex; value: Hex; data: Hex }
interface WireTx { sender?: Address; from?: Address; frames: WireFrame[] }

const callOf = (f: WireFrame, mode: Mode, to: Address): string => {
  if (f.data === "0x") return "no calldata";
  if (isAddressEqual(to, EXPIRY)) return `deadline ${new Date(Number(BigInt(f.data)) * 1000).toISOString().replace(".000Z", "Z")}`;
  const name = SELECTORS.get(f.data.slice(0, 10).toLowerCase());
  if (name) {
    try {
      const d = decodeFunctionData({ abi, data: f.data }) as { functionName: string; args: readonly unknown[] };
      if (d.functionName === "transfer") { const [to, amt] = d.args as readonly [Address, bigint]; return `transfer(${to.slice(0, 8)}…, ${amt})`; }
      if (d.functionName === "deploy") { const [t] = d.args as readonly [{ invoiceId: bigint; amount: bigint; change: Address }]; return `deploy(invoice #${t.invoiceId}, ${t.amount} out, change ${t.change.slice(0, 8)}…)`; }
      if (d.functionName === "settle") { const [id, from] = d.args as readonly [bigint, Address]; return `settle(invoice #${id}, from ${from.slice(0, 8)}…)`; }
      if (d.functionName === "execute") { const [cmds, inputs, deadline] = d.args as readonly [Hex, readonly Hex[], bigint]; return `execute(commands ${cmds}, ${inputs.length} input, deadline ${deadline})${BigInt(f.value) > 0n ? ` + ${Number(BigInt(f.value)) / 1e18} ETH` : ""}`; }
    } catch { /* fall through to the bare name */ }
    return `${name}(…)`;
  }
  return mode === "VERIFY" ? `raw ${(f.data.length - 2) / 2} bytes (no selector)` : `selector ${f.data.slice(0, 10)}, ${(f.data.length - 10) / 2} bytes`;
};

export const readFrameTx = async (hash: Hex): Promise<FrameTxView> => {
  const [tx, receipt] = await Promise.all([
    rpc<WireTx | null>("eth_getTransactionByHash", [hash]),
    client.altpool.getFrameTransactionReceipt({ hash }),
  ]);
  if (!tx?.frames || !receipt?.blockNumber) throw new Error(`${hash} is not an included frame transaction on this devnet`);
  const sender = (tx.sender ?? tx.from)!;
  const flagged = tx.frames.map((f) => (Number(f.flags) & ATOMIC) !== 0);
  const batch: Batch[] = flagged.map((on, i) => (on ? "atomic" : i > 0 && flagged[i - 1] ? "ends batch" : "outside"));
  const ok = (i: number) => receipt.frames[i]?.status === "success";
  const failedBatch = new Array<boolean>(tx.frames.length).fill(false);
  for (let end = 0; end < tx.frames.length; end++) {
    if (batch[end] !== "ends batch") continue;
    let start = end;
    while (start > 0 && flagged[start - 1]) start--;
    const bad = Array.from({ length: end - start + 1 }, (_, k) => start + k).some((i) => !ok(i));
    if (bad) for (let i = start; i <= end; i++) failedBatch[i] = true;
  }
  const frames = tx.frames.map((f, index): FrameRow => {
    const mode = MODES[Number(f.mode)] ?? "DEFAULT";
    const target = f.to ?? sender;
    const r = receipt.frames[index];
    return {
      index, mode, batch: batch[index]!, target,
      approves: mode === "VERIFY" ? SCOPES[Number(f.flags) & 3] : undefined,
      targetName: nameOf(target) ?? (f.to === null || isAddressEqual(target, sender) ? "sender" : undefined),
      call: callOf(f, mode, target),
      gasLimit: BigInt(f.gasLimit), stateLimit: BigInt(f.stateLimit),
      used: r?.gasUsed, status: failedBatch[index] && r?.status === "success" ? "rolled back" : r?.status,
    };
  });
  return { hash, block: Number(receipt.blockNumber), sender, status: receipt.status, frames };
};
