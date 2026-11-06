// The three things a visitor may edit, validated before anything is sent.
import { getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const FG_DECIMALS = 6;
export const MIN_FG = 1_000_000n;
/** 50 fgUSD costs ~0.023 ETH, ~2% of the ~1 ETH fgUSD pool: the size the first measured run used. */
export const MAX_FG = 50_000_000n;
export const DEFAULT_FG = "10";

export interface Inputs { amount: bigint; payee: Address; change: Address }
export type Raw = { amount: string; payee: string; change: string };
export type Errors = Partial<Record<keyof Raw, string>>;

/** Its private key is dropped here: nobody can spend from the address afterwards. */
export const freshAddress = (): Address => privateKeyToAccount(generatePrivateKey()).address;

const addressError = (v: string): string | undefined => {
  if (!isAddress(v, { strict: false })) return "Not an address: expected 0x and 40 hex characters.";
  if (!isAddress(v)) return "Checksum mismatch: check the capitalisation, or paste it all lowercase.";
  if (getAddress(v) === zeroAddress) return "The zero address would burn the funds.";
  return undefined;
};

const amountOf = (s: string): bigint | string => {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return "Enter a number with at most 6 decimals.";
  const x = parseUnits(s, FG_DECIMALS);
  if (x < MIN_FG || x > MAX_FG) return "Between 1 and 50 fgUSD: the swap must fit the pool's ~1 ETH of liquidity.";
  return x;
};

export const validate = (raw: Raw): { ok: true; value: Inputs } | { ok: false; errors: Errors } => {
  const [payee, change] = [raw.payee.trim(), raw.change.trim()];
  const amount = amountOf(raw.amount.trim());
  const errors: Errors = {
    ...(typeof amount === "string" && { amount }),
    ...(addressError(payee) && { payee: addressError(payee) }),
    ...(addressError(change) && { change: addressError(change) }),
  };
  if (Object.keys(errors).length || typeof amount === "string") return { ok: false, errors };
  return { ok: true, value: { amount, payee: getAddress(payee), change: getAddress(change) } };
};
