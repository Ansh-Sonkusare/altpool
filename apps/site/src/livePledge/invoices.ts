// The newest invoice an earlier run already paid, read live from InvoiceBook. The book has no length getter, so the
// count comes from probing invoices(i) (an out-of-range index reverts) and the paid flag from the invoices themselves.
import { deployments, invoiceBookAbi } from "@altpool/contracts";
import { BaseError, ContractFunctionRevertedError, type Address } from "viem";
import { client } from "../altpool";
import { MAX_FG, MIN_FG } from "./inputs";
import { FGUSD } from "./quote";
import type { PaidInvoice } from "./presets";

const BOOK = deployments.invoiceBook as Address;
const read = (id: bigint) => client.readContract({ address: BOOK, abi: invoiceBookAbi, functionName: "invoices", args: [id] });
const SCAN = 40n;

/** Only a revert means "no such invoice". A dropped request is rethrown, never read as the end of the book. */
const exists = async (id: bigint): Promise<boolean> => {
  try { await read(id); return true; } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return false;
    throw e;
  }
};

const countInvoices = async (): Promise<bigint> => {
  if (!(await exists(0n))) return 0n;
  let [lo, hi] = [0n, 1n];
  while (await exists(hi)) [lo, hi] = [hi, hi * 2n];
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid; else hi = mid;
  }
  return hi;
};

/** Newest paid fgUSD invoice whose amount a run can swap for, or undefined when none of the last 40 is paid. */
export const newestPaid = async (): Promise<PaidInvoice | undefined> => {
  const n = await countInvoices();
  const from = n > SCAN ? n - SCAN : 0n;
  const ids = Array.from({ length: Number(n - from) }, (_, i) => n - 1n - BigInt(i));
  const rows = await Promise.all(ids.map(async (id) => ({ id, inv: await read(id) })));
  const hit = rows.find(({ inv: [, token, amount, paid] }) => paid && token.toLowerCase() === FGUSD && amount >= MIN_FG && amount <= MAX_FG);
  return hit && { id: hit.id, payee: hit.inv[0], amount: hit.inv[2] };
};
