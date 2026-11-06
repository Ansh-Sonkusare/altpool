// What a Pledge Paid run shows. Light on purpose: the component imports this, and run.ts (with the prover) loads on click.
import type { Terms } from "@altpool/contracts";
import type { Address, Hex } from "viem";
import type { StepState } from "../liveExit/steps";

export const STEPS = [
  { id: "keys", part: "deposit", title: "Fresh note", sub: "made in this tab, shown to you once" },
  { id: "faucet", part: "deposit", title: "Fund the depositor", sub: "gateway faucet, only if the balance is low" },
  { id: "deposit", part: "deposit", title: "Wrap and deposit 0.1 WETH", sub: "wrap, approve, pool.deposit" },
  { id: "wait", part: "pay", title: "Wait for the crowd", sub: "later deposits and withdrawals, counted live" },
  { id: "tree", part: "pay", title: "Rebuild the Merkle tree", sub: "from the WETH pool's Deposit logs" },
  { id: "invoice", part: "pay", title: "The fund creates the invoice; quote the swap", sub: "InvoiceBook.create by the fund key, Uniswap v4 quoter" },
  { id: "settler", part: "pay", title: "Fix the Settler address", sub: "CREATE2 of the terms, the proof's recipient" },
  { id: "prove", part: "pay", title: "Prove the withdrawal", sub: "Groth16, in this browser" },
  { id: "simulate", part: "pay", title: "Build the 9 frames and simulate", sub: "ethrex_simulateFrameTransaction, before any send" },
  { id: "check", part: "pay", title: "checkAdmission", sub: "will each mempool admit it?" },
  { id: "submit", part: "pay", title: "Submit to the miner's sidecar", sub: "zero signatures, no relayer" },
  { id: "receipt", part: "pay", title: "Wait for inclusion", sub: "up to 180 s" },
  { id: "outcome", part: "pay", title: "Read the outcome back", sub: "fund, invoice, Settler, change, relay fee" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];
export type Part = (typeof STEPS)[number]["part"];
export type Steps = Record<StepId, StepState>;
/** What a rolled-back run needs to recover its parked funds: the terms fix the Settler's address. */
export interface Rescue { terms: Terms; settler: Address; change: Address; invoicePaid: boolean }
/** The crowd the proof hid in: its root's leaves, the deposits after the note's, and the notes in it nobody has withdrawn. */
export interface Anonymity { root: Hex; leaves: number; after: number; set: number }
/** `reverted` is set when the run was sent on purpose and the receipt shows a failed frame. */
export interface RunResult { hash: string; totalMs: number; block: number; gasUsed?: bigint; frames: number; reverted?: { frame: number; status: string }; rescue: Rescue; anonymity: Anonymity }

/** One transaction the run put on the chain. It appears as "pending" the moment its hash is known. */
export interface ChainTx {
  step: StepId;
  label: string;
  hash: Hex;
  state: "pending" | "confirmed" | "failed";
  sentAt: number;
  doneAt?: number;
  block?: number;
}

/** One change the sidecar reported for the 9-frame transaction. `at` is Date.now(). */
export interface LifeEvent { status: string; at: number; note?: string }

/** What the polling of skandha_frameTransactionStatus saw so far. */
export interface Lifecycle {
  hash: Hex;
  sentAt: number;
  events: LifeEvent[];
  polls: number;
  failedPolls: number;
  lastPollAt?: number;
  intervalMs: number;
  /** Still polling. */
  live: boolean;
  /** The L1 transaction that carried it, once the sidecar names it. */
  carriedBy?: Hex;
  reason?: string;
}

/** Every step idle, or only the steps of `part`, keeping the others as they are. */
export const blankSteps = (keep?: Steps, part?: Part): Steps => {
  const steps = { ...keep } as Steps;
  for (const s of STEPS) if (!keep || s.part === part) steps[s.id] = { status: "idle", facts: [] };
  return steps;
};
