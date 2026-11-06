// circomlib's mimcsponge uses web3-utils for five helpers when it derives its round constants. The real package pulls in
// @ethereumjs/util, which needs Node's events module. This is the subset used, on native bigint.
import { isHex, keccak256 as keccak, stringToBytes, hexToBytes, type Hex } from "viem";

class BN {
  constructor(readonly v: bigint) {}
  mod = (o: BN) => new BN(this.v % o.v);
  toString = () => this.v.toString();
}

/** web3 hashes a 0x string as bytes and anything else as UTF-8. */
export const keccak256 = (x: string): Hex => keccak(isHex(x) ? hexToBytes(x) : stringToBytes(x));
export const toBN = (x: string | BN): BN => (x instanceof BN ? x : new BN(BigInt(x)));
export const toHex = (x: BN): Hex => `0x${x.v.toString(16)}`;
export const padLeft = (x: string, chars: number) => `0x${x.replace(/^0x/, "").padStart(chars, "0")}`;
