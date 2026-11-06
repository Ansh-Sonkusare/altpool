// Untyped CommonJS from the circuit tooling. Typed here only as far as liveExit uses it.
declare module "circomlib/src/babyjub.js" {
  const babyJub: { unpackPoint(buf: Uint8Array): unknown[] };
  export default babyJub;
}
declare module "circomlib/src/pedersenHash.js" {
  const pedersenHash: { hash(msg: Uint8Array): Uint8Array };
  export default pedersenHash;
}
declare module "circomlib/src/mimcsponge.js" {
  const mimcsponge: { multiHash(xs: bigint[]): unknown };
  export default mimcsponge;
}
declare module "websnark/src/groth16.js" {
  export interface Groth16 { terminate(): void }
  const buildGroth16: () => Promise<Groth16>;
  export default buildGroth16;
}
declare module "websnark/src/utils.js" {
  interface Proved { publicSignals: string[] }
  const utils: {
    genWitnessAndProve(g: unknown, input: Record<string, string | string[]>, circuit: unknown, pk: ArrayBuffer): Promise<Proved>;
    toSolidityInput(p: Proved): { proof: `0x${string}` };
  };
  export default utils;
}
declare module "snarkjs/src/bigint.js" {
  const bigInt: (x: string | number) => unknown;
  export default bigInt;
}
