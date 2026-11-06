export * from "./types";
export * from "./devnet";
export * from "./rpc";

/** Stub marker. Throws so an unfinished path fails loudly instead of returning junk. */
export const todo = (what: string): never => {
  throw new Error(`not implemented yet: ${what}`);
};
