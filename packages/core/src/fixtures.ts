// Node-only (uses fs). Import as "@altpool/core/fixtures"; never from browser code.
import { readFileSync, readdirSync } from "node:fs";
import type { WithdrawProof } from "./types";

const ROOT = new URL("../fixtures/", import.meta.url);

export interface Captured {
  file: string;
  endpoint?: string;
  request: { method: string; params: unknown[] };
  response: { result?: any; error?: { code: number; message: string; data?: unknown } };
}

/** Any fixture file as plain JSON (some captures are notes, not single calls, e.g. local/r5-stake). */
export const raw = (path: string): any => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));

/** One captured call, e.g. fixture("public/29-ethrex_simulateFrameTransaction.json"). */
export const fixture = (path: string): Captured => ({ file: path, ...raw(path) });

/** The captured calls in a folder, in file order (a replayable scenario), e.g. scenario("r9-demo"). Skips non-call notes. */
export const scenario = (dir: string): Captured[] =>
  readdirSync(new URL(`${dir}/`, ROOT))
    .filter((f) => /^\d.*\.json$/.test(f))
    .sort()
    .map((f) => fixture(`${dir}/${f}`))
    .filter((c) => typeof c.request?.method === "string");

/** Folders of {request, response} calls. Notes-only folders: local/r5-stake (stake lifecycle), local/r11-burst (throttle timeline).
 *  local/workshop: workshop steps 1-13 on altpool-localnet (step summaries in local/workshop/results); local/rpc: one rejection per rule;
 *  local/ws-explorer-events: skandha_subscribe stream (events.jsonl). */
export const scenarios = [
  "public", "public-r9", "r9-demo", "local/smoke", "local/r6-nonces",
  "local/workshop", "local/rpc", "local/simulate-traced", "local/cancelled", "local/ws-explorer-events",
] as const;

/** Stand-in until gate G1. Values are not a valid proof. */
export const mockWithdrawProof = (): WithdrawProof => {
  const raw = JSON.parse(readFileSync(new URL("quietsend/withdraw-proof.mock.json", ROOT), "utf8"));
  return { ...raw, fee: BigInt(raw.fee), refund: BigInt(raw.refund) };
};
