// After a rolled-back send: anyone may deploy the Settler at its fixed address and call refund() (neither checks the caller).
// A fresh faucet-funded key signs both, never the depositor, whose signature on the Settler would link it to the change address.
// refund() needs the invoice paid (Settler.sol). The funds sit at the address as WETH, so they reach `change` as WETH.
import { deployments, settlerAbi, settlerFactoryAbi, WETH9, wethAbi } from "@altpool/contracts";
import { parseEther, type Address, type Hex } from "viem";
import { client } from "../altpool";
import type { Funder } from "../liveExit/funding";
import type { Rescue } from "./steps";

const FACTORY = deployments.settlerFactory as Address;
const GAS_NEED = parseEther("0.02");
const wethOf = (a: Address) => client.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [a] });

export interface Recovered { weth: bigint; settlerLeft: bigint }

/** `onTx` fires with each hash as soon as it is sent, `onMined` when its receipt is in. A reverted tx throws. */
export async function recover(
  f: Funder,
  r: Rescue,
  ui: { onTx(label: string, hash: Hex): void; onMined(hash: Hex, block: bigint, ok: boolean): void },
): Promise<Recovered> {
  const mined = async (label: string, hash: Hex) => {
    ui.onTx(label, hash);
    const rc = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    ui.onMined(hash, rc.blockNumber, rc.status === "success");
    if (rc.status !== "success") throw new Error(`${label} ${hash} reverted`);
  };
  await f.ensureFunds(GAS_NEED, () => {});
  const before = await wethOf(r.change);
  if (((await client.getCode({ address: r.settler })) ?? "0x").length <= 2) {
    await mined("SettlerFactory.deploy(terms)", await f.wallet.writeContract({ address: FACTORY, abi: settlerFactoryAbi, functionName: "deploy", args: [r.terms], type: "legacy" }));
  }
  await mined("Settler.refund()", await f.wallet.writeContract({ address: r.settler, abi: settlerAbi, functionName: "refund", gas: 300_000n, type: "legacy" }));
  const [after, settlerLeft] = await Promise.all([wethOf(r.change), wethOf(r.settler)]);
  return { weth: after - before, settlerLeft };
}
