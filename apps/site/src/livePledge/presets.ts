// What a run is meant to do. Light on purpose: the component and the Doctor import this, and run.ts loads on click.
import { decodeErrorResult, parseAbi, type Hex } from "viem";

export type PresetId = "pay" | "paid" | "price";
export interface PaidInvoice { id: bigint; payee: `0x${string}`; amount: bigint }
/** `invoice` is set when the run reuses an invoice that is already paid; `lowMaxIn` when the swap's cap is below the quote. */
export interface Intent { id: PresetId; invoice?: PaidInvoice; lowMaxIn: boolean }

export const PAY: Intent = { id: "pay", lowMaxIn: false };
export const expectsRevert = (i: Intent) => i.id !== "pay";
/** The fix for either revert is the happy path: a fresh invoice, a fresh quote. */
export const fixOf = (_: Intent): Intent => PAY;

export interface PresetDef { id: PresetId; label: string; frame?: number; headline: string; why: string; fix?: string }
export const PRESETS: PresetDef[] = [
  { id: "pay", label: "Pays the invoice", headline: "All nine frames land.", why: "A fresh invoice and a fresh quote. The simulation passes, so the run sends without asking." },
  {
    id: "paid", label: "Revert: invoice already paid", frame: 6,
    headline: "Frame 6 should fail: InvoiceBook.settle.",
    why: "The run reuses the newest invoice an earlier run already paid. An invoice settles once, so settle reverts AlreadyPaid and the atomic batch (frames 3 to 8) rolls back. The withdraw in frame 2 stays final.",
    fix: "Create a fresh invoice and point the Settler's terms at it.",
  },
  {
    id: "price", label: "Revert: price moved", frame: 5,
    headline: "Frame 5 should fail: Settler.swap.",
    why: "maxIn is set to half the fresh quote, as if the price had moved after you quoted. The v4 swap then costs more than maxIn, so swap reverts InputTooHigh and the atomic batch rolls back. The withdraw in frame 2 stays final.",
    fix: "Re-quote with the v4 quoter and set maxIn to the fresh amountIn plus 3 percent.",
  },
];
export const presetOf = (i: Intent) => PRESETS.find((p) => p.id === i.id)!;

const errors = parseAbi([
  "error AlreadyPaid(uint256 id)",
  "error InputTooHigh(uint256 owed)",
  "error ShortOutput(uint256 out)",
  "error NotSettled()",
  "error NotPaid()",
  "error SweepFailed()",
  "error WrongPayer()",
]);

/** Settler and InvoiceBook custom errors in a frame's revert data, e.g. `AlreadyPaid(7)`. */
export const pledgeRevert = (data: string | undefined): string | undefined => {
  if (!data || data === "0x") return undefined;
  try {
    const e = decodeErrorResult({ abi: errors, data: data as Hex });
    return `${e.errorName}(${(e.args ?? []).join(", ")})`;
  } catch {
    return undefined;
  }
};

/** The fix line for a reverted frame, from the decoded reason. */
export const fixFor = (reason: string | undefined): string | undefined =>
  reason?.startsWith("AlreadyPaid") ? PRESETS[1]!.fix
    : reason?.startsWith("InputTooHigh") ? PRESETS[2]!.fix
    : reason?.startsWith("NotSettled") ? "Settle the invoice and leave nothing in the Settler: check every earlier frame's effect."
    : undefined;
