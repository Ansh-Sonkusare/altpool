// Falcon-512 keys and signatures in the exact encoding FalconWallet.sol / ZKNOX_falcon.verify consume.
import { falcon512 } from "@noble/post-quantum/falcon.js";
import { bytesToHex, concatHex, encodeFunctionData, hexToBytes, keccak256, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { frame, newTx, sigHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET } from "@altpool/core";

const Q = 12289n;
const N = 512;
const PSI = 49n; // primitive 1024th root of unity mod q; psirev[i] = PSI^bitrev9(i) reproduces ZKNOX's 512-entry table
export const SALT_LEN = 40;
export const POLY_BYTES = 1024; // 32 words x 32 bytes
export const SIG_LEN = SALT_LEN + 2 * POLY_BYTES;

export interface FalconKey {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export const falconKeygen = (seed?: Uint8Array): FalconKey => falcon512.keygen(seed);

const powMod = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= Q; e > 0n; e >>= 1n, b = (b * b) % Q) if (e & 1n) r = (r * b) % Q;
  return r;
};
const bitrev9 = (x: number) => {
  let r = 0;
  for (let i = 0; i < 9; i++) r |= ((x >> i) & 1) << (8 - i);
  return r;
};
const PSIREV = Array.from({ length: N }, (_, i) => powMod(PSI, BigInt(bitrev9(i))));

/** 16 coefficients per word, coefficient i at bit 16*(i%16) of word i>>4: ZKNOX `_ZKNOX_NTT_Compact`. */
const compact = (c: bigint[]): bigint[] =>
  Array.from({ length: N / 16 }, (_, w) => c.slice(w * 16, w * 16 + 16).reduce((acc, v, j) => acc | (v << BigInt(16 * j)), 0n));

/** Public key (897 bytes: 0x09 header, 512 x 14-bit coefficients) -> NTT domain, packed: ZKNOX `_ZKNOX_NTTFW_vectorized`. */
export function pubkeyToNtt(publicKey: Uint8Array): bigint[] {
  if (publicKey.length !== 897 || publicKey[0] !== 0x09) throw new Error("not a Falcon-512 public key");
  const a: bigint[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 1; a.length < N; i++) {
    acc = ((acc << 8) | publicKey[i]!) >>> 0;
    bits += 8;
    if (bits >= 14) {
      bits -= 14;
      const w = (acc >>> bits) & 0x3fff;
      if (w >= Q) throw new Error("public key coefficient out of range");
      a.push(BigInt(w));
    }
  }
  for (let t = N, m = 1; m < N; m <<= 1) {
    t >>= 1;
    for (let i = 0; i < m; i++) {
      const s = PSIREV[m + i]!;
      for (let j = 2 * i * t; j < 2 * i * t + t; j++) {
        const u = a[j]!;
        const v = (a[j + t]! * s) % Q;
        a[j + t] = (u + Q - v) % Q;
        a[j] = (u + v) % Q;
      }
    }
  }
  return compact(a);
}

const wordsToBytes = (words: bigint[]): Hex => concatHex(words.map((w) => pad(toHex(w), { size: 32 })));

/** The 1024 bytes the wallet commits to and every signature carries. */
export const nttKeyBytes = (publicKey: Uint8Array): Hex => wordsToBytes(pubkeyToNtt(publicKey));

/** FalconWallet's `pkHash` immutable: keccak256 of the NTT-domain key as 32 big-endian words. */
export const pkHashOf = (publicKey: Uint8Array): Hex => keccak256(nttKeyBytes(publicKey));

/** Falcon compressed s2 (after the 1-byte header and 40-byte nonce) -> 512 coefficients mod q. */
function decompressS2(comp: Uint8Array): bigint[] {
  const out: bigint[] = [];
  let bit = 0;
  const take = () => {
    if (bit >= comp.length * 8) throw new Error("truncated Falcon signature");
    const b = (comp[bit >> 3]! >> (7 - (bit & 7))) & 1;
    bit++;
    return b;
  };
  while (out.length < N) {
    const neg = take() === 1;
    let low = 0;
    for (let k = 0; k < 7; k++) low = (low << 1) | take();
    let high = 0;
    while (take() === 0) if (++high > 15) throw new Error("bad Falcon signature encoding");
    const v = (high << 7) | low;
    if (neg && v === 0) throw new Error("bad Falcon signature encoding (negative zero)");
    out.push(neg ? (Q - BigInt(v)) % Q : BigInt(v));
  }
  for (; bit < comp.length * 8; bit++) if ((comp[bit >> 3]! >> (7 - (bit & 7))) & 1) throw new Error("non-zero Falcon signature padding");
  return out;
}

/** Sign a 32-byte digest; returns the wallet's signature bytes: salt(40) || s2(32 words) || ntth(32 words), 2088 bytes. */
export function falconSign(digest: Hex, key: FalconKey): Hex {
  const msg = hexToBytes(digest);
  if (msg.length !== 32) throw new Error("digest must be 32 bytes");
  const sig = falcon512.sign(msg, key.secretKey);
  if (sig[0] !== 0x39) throw new Error(`unexpected Falcon signature header 0x${sig[0]!.toString(16)}`);
  if (!falcon512.verify(sig, msg, key.publicKey)) throw new Error("noble rejected its own signature");
  const salt = bytesToHex(sig.slice(1, 1 + SALT_LEN));
  return concatHex([salt, wordsToBytes(compact(decompressS2(sig.slice(1 + SALT_LEN)))), nttKeyBytes(key.publicKey)]);
}

const walletAbi = parseAbi(["function execute(address to, uint256 value, bytes data) returns (bytes)"]);

// Measured with ethrex_simulateFrameTransaction on the live devnet (README): VERIFY used 3.62M-3.86M over 25 random
// signatures (the spread is hash-to-point rejection sampling), so 4.5M is +16% over the observed max. Unused gas is
// not charged. The SENDER frame used 13k execution gas but halted at 150k and passed at 200k (a value call into a fresh
// account); 250k leaves margin. State gas for the new recipient account passed at 200k.
export const FALCON_VERIFY_GAS = 4_500_000n;
export const FALCON_SPEND_GAS = 250_000n;
export const FALCON_SPEND_STATE_GAS = 250_000n;

export interface SpendOpts {
  wallet: Address;
  key: FalconKey;
  nonce: bigint;
  to: Address;
  value: bigint;
  data?: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  verifyGas?: bigint;
  spendGas?: bigint;
  spendStateGas?: bigint;
  /** Replace the signature bytes after signing (tamper tests). */
  tamper?: (sig: Hex) => Hex;
}

/** Frames: 0 VERIFY wallet (data 0x00: empty calldata would hit receive()), 1 SENDER wallet.execute(to, value, data). */
export function falconSpendTx(o: SpendOpts): FrameTx {
  const profile = getProfile(DEVNET.profile);
  const unsigned = newTx({
    chainId: DEVNET.chainId,
    sender: o.wallet,
    nonceSeq: o.nonce,
    fees: { maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? 10n ** 9n },
    signatures: [{ scheme: 0, signer: "0x", msg: "0x", signature: "0x" }],
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: o.verifyGas ?? FALCON_VERIFY_GAS, data: "0x00" }),
      frame(profile, "SENDER", {
        target: o.wallet,
        execution: o.spendGas ?? FALCON_SPEND_GAS,
        state: o.spendStateGas ?? FALCON_SPEND_STATE_GAS,
        data: encodeFunctionData({ abi: walletAbi, functionName: "execute", args: [o.to, o.value, o.data ?? "0x"] }),
      }),
    ],
  });
  let signature = falconSign(sigHash(profile, unsigned), o.key);
  if (o.tamper) signature = o.tamper(signature);
  return { ...unsigned, signatures: [{ scheme: 0, signer: "0x", msg: "0x", signature }] };
}
