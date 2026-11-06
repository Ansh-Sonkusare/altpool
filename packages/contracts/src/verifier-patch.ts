// The devnet Tornado verifier calls precompiles as `staticcall(sub(gas(), 2000), …)`, which the alt mempool bans in
// validation (OP-012: GAS must directly precede a *CALL). ExitRelay checks proofs against a byte-patched copy.
import { bytesToHex, hexToBytes, type Hex } from "viem";

const GAS = 0x5a;
const SITE = [0x61, 0x07, 0xd0, GAS, 0x03, 0xfa]; // PUSH2 2000, GAS, SUB, STATICCALL
const PATCH = [0x5b, 0x5b, 0x5b, 0x5b, GAS]; // JUMPDEST x4, GAS; same length so every jump target holds
const SITES = 3;

/** Rewrites every `sub(gas(), 2000)` STATICCALL to forward `gas()` directly. */
export function patchVerifierRuntime(code: Hex): Hex {
  const input = hexToBytes(code);
  const out = input.slice();
  const patched: number[] = [];
  for (let pc = 0; pc < input.length; pc++) {
    const op = input[pc];
    if (op === GAS) {
      const start = pc - 3;
      if (start < 0 || SITE.some((b, k) => input[start + k] !== b)) {
        throw new Error(`GAS at ${pc} is not PUSH2 07d0 GAS SUB STATICCALL`);
      }
      out.set(PATCH, start);
      patched.push(start);
    }
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  if (patched.length !== SITES) throw new Error(`expected ${SITES} GAS sites, found ${patched.length} at ${patched}`);
  const diff = input.reduce((n, b, i) => n + (b === out[i] ? 0 : 1), 0);
  if (diff !== SITES * PATCH.length) throw new Error(`patch changed ${diff} bytes, expected ${SITES * PATCH.length}`);
  return bytesToHex(out);
}

/** Creation code that returns `runtime` unchanged: CODECOPY the bytes after this 12-byte header, then RETURN. */
export function initcodeFor(runtime: Hex): Hex {
  const len = hexToBytes(runtime).length;
  if (len > 0xffff) throw new Error(`runtime is ${len} bytes, over PUSH2`);
  const header = [0x61, len >> 8, len & 0xff, 0x80, 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, 0x00, 0xf3];
  return `0x${bytesToHex(new Uint8Array(header)).slice(2)}${runtime.slice(2)}`;
}
