// Why a frame of a Pledge Paid fails. ethrex_simulateFrameTransaction names the frame (succeeded: false) but returns no revert
// data for it, so the reason is rebuilt from the frame's own calldata and the live state it reads: the same two checks the
// contracts make. A frame this cannot explain gets no reason, never a guessed one.
import { deployments, invoiceBookAbi, settlerAbi, settlerFactoryAbi } from "@altpool/contracts";
import { decodeTx } from "@forshtat/hegota-support/tx";
import { decodeFunctionData, formatEther, type Address, type Hex } from "viem";
import { client, profile } from "../altpool";
import { quote } from "./quote";

const BOOK = deployments.invoiceBook as Address;

export const whyFrameFails = async (raw: Hex, index: number): Promise<string | undefined> => {
  const frames = decodeTx(profile, raw).frames;
  const data = frames[index]?.data;
  if (!data || data === "0x") return undefined;
  try {
    const call = decodeFunctionData({ abi: [...invoiceBookAbi, ...settlerAbi], data: data as Hex });
    if (call.functionName === "settle") {
      const id = call.args[0] as bigint;
      const paid = await client.readContract({ address: BOOK, abi: invoiceBookAbi, functionName: "paid", args: [id] });
      return paid ? `AlreadyPaid(${id}), because InvoiceBook.paid(${id}) is true` : undefined;
    }
    if (call.functionName === "swap") {
      const deploy = frames.map((f) => f.data && decodeFunctionData({ abi: settlerFactoryAbi, data: f.data as Hex })).find((d) => d && d.functionName === "deploy");
      const t = deploy && (deploy.args[0] as { amount: bigint; maxIn: bigint });
      if (!t) return undefined;
      const q = await quote(t.amount);
      return q.amountIn > t.maxIn ? `InputTooHigh, because the v4 swap costs ${formatEther(q.amountIn)} ETH and maxIn is ${formatEther(t.maxIn)} ETH` : undefined;
    }
  } catch { /* not a call this explains */ }
  return undefined;
};
