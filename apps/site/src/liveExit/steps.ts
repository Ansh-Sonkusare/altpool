// What a run shows. Light on purpose: the component imports this, and run.ts (with the prover) loads only on click.
export const STEPS = [
  { id: "keys", title: "Fresh keys and note", sub: "in memory only, never stored or shown" },
  { id: "faucet", title: "Fund the depositor", sub: "gateway sidecar faucet" },
  { id: "deposit", title: "Deposit 0.1 ETH into the pool", sub: "pool.deposit(commitment)" },
  { id: "tree", title: "Rebuild the Merkle tree", sub: "from the pool's Deposit logs" },
  { id: "prove", title: "Prove the withdrawal", sub: "Groth16, in this browser" },
  { id: "frames", title: "Build the exit transaction", sub: "3 frames, no signatures" },
  { id: "check", title: "checkAdmission", sub: "will each mempool admit it?" },
  { id: "submit", title: "Submit to the miner's sidecar", sub: "no relayer" },
  { id: "receipt", title: "Wait for inclusion", sub: "up to 180 s" },
  { id: "balance", title: "Recipient balance", sub: "0 ETH before, payout after" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];
export interface Fact { k: string; v: string; href?: string; tone?: "ok" | "bad" | "warn" }
export interface StepState {
  status: "idle" | "running" | "done" | "error";
  /** Date.now() when it started, for the running timer. */
  startedAt?: number;
  ms?: number;
  facts: Fact[];
  /** A full text report (checkAdmission), shown collapsed. */
  detail?: string;
  /** A sentence under the facts, e.g. that the server prover was used. */
  note?: string;
  error?: string;
}
export type Steps = Record<StepId, StepState>;
export interface RunResult { exitHash: string; totalMs: number }

export const blankSteps = (): Steps => {
  const steps = {} as Steps;
  for (const s of STEPS) steps[s.id] = { status: "idle", facts: [] };
  return steps;
};
