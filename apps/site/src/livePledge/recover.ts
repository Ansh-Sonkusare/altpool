// After a rolled-back send: anyone may deploy the Settler at its fixed address and call refund() (neither checks the caller).
// A fresh faucet-funded key signs every step, never the depositor, whose signature on the Settler would link it to the change address.
// refund() needs the invoice paid (Settler.sol). When the rollback left it unpaid (the price preset), the rescue key pays it
// first through a second Settler with the same invoice and a fresh quote: InvoiceBook.settle only asks that the payer's
// invoiceId() match, and any Settler for that invoice does. The funds sit at the address as WETH, so they reach `change` as WETH.
import { deployments, invoiceBookAbi, settlerAbi, settlerFactoryAbi, WETH9, wethAbi, type Terms } from "@altpool/contracts";
import { parseEther, type Abi, type Address, type Hex } from "viem";
import { client } from "../altpool";
import type { Funder } from "../liveExit/funding";
import { quote } from "./quote";
import type { Rescue } from "./steps";

const FACTORY = deployments.settlerFactory as Address;
const GAS_NEED = parseEther("0.02");
const wethOf = (a: Address) => client.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [a] });
const hasCode = async (a: Address) => ((await client.getCode({ address: a })) ?? "0x").length > 2;

export interface Recovered { weth: bigint; settlerLeft: bigint }
type Ui = { onTx(label: string, hash: Hex): void; onMined(hash: Hex, block: bigint, ok: boolean): void };

/** `onTx` fires with each hash as soon as it is sent, `onMined` when its receipt is in. Every call is simulated first; a revert throws. */
export async function recover(f: Funder, r: Rescue, ui: Ui): Promise<Recovered> {
  const mined = async (label: string, hash: Hex) => {
    ui.onTx(label, hash);
    const rc = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    ui.onMined(hash, rc.blockNumber, rc.status === "success");
    if (rc.status !== "success") throw new Error(`${label} ${hash} reverted`);
  };
  const call = async (label: string, p: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; gas?: bigint }) => {
    await client.simulateContract({ ...p, account: f.wallet.account } as never);
    await mined(label, await f.wallet.writeContract({ ...p, type: "legacy" } as never));
  };
  const deploy = async (label: string, terms: Terms, at: Address) => {
    if (!(await hasCode(at))) await call(label, { address: FACTORY, abi: settlerFactoryAbi, functionName: "deploy", args: [terms] });
  };

  const unpaid = !(await client.readContract({ address: r.terms.book, abi: invoiceBookAbi, functionName: "paid", args: [r.terms.invoiceId] }));
  const q = unpaid ? await quote(r.terms.amount) : undefined;
  await f.ensureFunds(GAS_NEED + (q?.maxIn ?? 0n), () => {});
  if (q) {
    const terms: Terms = { ...r.terms, maxIn: q.maxIn, change: f.address };
    const payer = await client.readContract({ address: FACTORY, abi: settlerFactoryAbi, functionName: "addressOf", args: [terms] });
    await deploy("SettlerFactory.deploy(terms with a fresh quote)", terms, payer);
    const send = { account: f.wallet.account, to: payer, value: q.maxIn } as const;
    await client.call(send);
    await mined("fund the paying Settler", await f.wallet.sendTransaction({ ...send, type: "legacy" }));
    await call("paying Settler.swap()", { address: payer, abi: settlerAbi, functionName: "swap" });
    await call(`InvoiceBook.settle(${r.terms.invoiceId})`, { address: r.terms.book, abi: invoiceBookAbi, functionName: "settle", args: [r.terms.invoiceId, payer] });
    await call("paying Settler.sweep()", { address: payer, abi: settlerAbi, functionName: "sweep" });
  }
  const before = await wethOf(r.change);
  await deploy("SettlerFactory.deploy(terms)", r.terms, r.settler);
  await call("Settler.refund()", { address: r.settler, abi: settlerAbi, functionName: "refund", gas: 300_000n });
  const [after, settlerLeft] = await Promise.all([wethOf(r.change), wethOf(r.settler)]);
  return { weth: after - before, settlerLeft };
}
