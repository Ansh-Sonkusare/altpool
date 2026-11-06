// What a Pledge Paid run shows. Light on purpose: the component imports this, and run.ts (with the prover) loads on click.
import type { Terms } from "@altpool/contracts";
import type { Address, Hex } from "viem";
import type { StepState } from "../liveExit/steps";

export const STEPS = [
  { id: "keys", title: "Fresh depositor key and note", sub: "in memory only, never stored or shown" },
  { id: "faucet", title: "Fund the depositor", sub: "gateway faucet" },
  { id: "deposit", title: "Wrap and deposit 0.1 WETH", sub: "wrap, approve, pool.deposit" },
  { id: "wait", title: "Wait for later deposits", sub: "watches the pool for 2 deposits after yours, up to 90 s" },
  { id: "tree", title: "Rebuild the Merkle tree", sub: "from the WETH pool's Deposit logs" },
  { id: "invoice", title: "The fund creates the invoice; quote the swap", sub: "InvoiceBook.create by the fund key, Uniswap v4 quoter" },
  { id: "settler", title: "Fix the Settler address", sub: "CREATE2 of the terms, the proof's recipient" },
  { id: "prove", title: "Prove the withdrawal", sub: "Groth16, in this browser" },
  { id: "simulate", title: "Build the 9 frames and simulate", sub: "ethrex_simulateFrameTransaction, before any send" },
  { id: "check", title: "checkAdmission", sub: "will each mempool admit it?" },
  { id: "submit", title: "Submit to the miner's sidecar", sub: "zero signatures, no relayer" },
  { id: "receipt", title: "Wait for inclusion", sub: "up to 180 s" },
  { id: "outcome", title: "Read the outcome back", sub: "fund, invoice, Settler, change, relay fee" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];
export type Steps = Record<StepId, StepState>;
/** What a rolled-back run needs to recover its parked funds: the terms fix the Settler's address. */
export interface Rescue { terms: Terms; settler: Address; change: Address; invoicePaid: boolean }
/** The note's leaf, and the root it proved against: its leaves, the deposits after the note's, the notes in it nobody has withdrawn. */
export interface Anonymity { leaf: number; root: Hex; rootIdx: number; leaves: number; after: number; set: number; later: Later[] }
/** A deposit that landed after the visitor's, seen while the run waited. */
export interface Later { leaf: number; block: number; hash: Hex }
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

export const blankSteps = (): Steps => {
  const steps = {} as Steps;
  for (const s of STEPS) steps[s.id] = { status: "idle", facts: [] };
  return steps;
};
