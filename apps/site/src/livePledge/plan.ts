// The nine frames as FrameRail rows before any receipt exists (status undefined = pending). pay.ts lays the real ones out.
import { deployments } from "@altpool/contracts";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import type { Address } from "viem";
import { EXPIRY, nameOf, type FrameRow } from "../frames";

const [PAY_RELAY, POOL, FACTORY, BOOK] = [deployments.payRelayWETH, deployments.wethPool, deployments.settlerFactory, deployments.invoiceBook] as Address[];
const SETTLER_UNKNOWN: Address = "0x0000000000000000000000000000000000000000";

const ROWS: Pick<FrameRow, "mode" | "approves" | "batch" | "call">[] = [
  { mode: "VERIFY", approves: "none", batch: "outside", call: "deadline" },
  { mode: "VERIFY", approves: "execution + payment", batch: "outside", call: "Groth16 proof check, the relay pays gas" },
  { mode: "SENDER", batch: "outside", call: "withdraw(…, Settler, relay, 0.01 WETH)" },
  { mode: "DEFAULT", batch: "atomic", call: "deploy(terms)" },
  { mode: "SENDER", batch: "atomic", call: "unwrap()" },
  { mode: "SENDER", batch: "atomic", call: "swap()" },
  { mode: "SENDER", batch: "atomic", call: "settle(invoice, Settler)" },
  { mode: "SENDER", batch: "atomic", call: "sweep()" },
  { mode: "DEFAULT", batch: "ends batch", call: "assertSettled()" },
];

/** `settler` once the terms are fixed; `tx` once built, for the real gas limits. */
export const plannedRows = (settler?: Address, tx?: FrameTx): FrameRow[] => {
  const target = (i: number): Address => [EXPIRY, PAY_RELAY, POOL, FACTORY, settler ?? SETTLER_UNKNOWN, settler ?? SETTLER_UNKNOWN, BOOK, settler ?? SETTLER_UNKNOWN, settler ?? SETTLER_UNKNOWN][i]!;
  return ROWS.map((r, index) => ({
    ...r,
    index,
    target: target(index),
    targetName: index >= 4 && index !== 6 ? (settler ? "Settler" : "Settler (address fixed in a later step)") : nameOf(target(index)),
    gasLimit: tx?.frames[index]?.limits.execution ?? 0n,
    stateLimit: tx?.frames[index]?.limits.state ?? 0n,
  }));
};
