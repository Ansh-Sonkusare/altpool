// The site's domain model: what an exit is, how each is read from the devnet, and frame-doctor's jobs.
// Everything returns plain values or plain text; components decide how to show them.
import { deployments, EXIT_FEE } from "@altpool/contracts";
import { createSimulator, decodeRevert, diagnoseAdmission, renderReport, renderVerdict } from "@altpool/simulator";
import { ethrex, type AdmissionReport, type MempoolVerdict, type RuleId } from "@altpool/core";
import { entityStatus } from "@altpool/monitor";
import { decodeTx, encodeTx } from "@forshtat/hegota-support/tx";
import { DEVNET, validationPrefixLength } from "altpool";
import type { Address, Hex } from "viem";
import { client, MEMPOOLS, minerGateway, profile, simulator } from "./altpool";
import { pledgeRevert } from "./livePledge/presets";
import { whyFrameFails } from "./livePledge/why";
import type { CurrentRun, PledgeRun } from "./pledge";

export type Live<T> =
  | { status: "loading" }
  | { status: "live"; value: T; at: Date }
  | { status: "error"; error: string; snapshot?: T };

export const EXIT_RELAY = deployments.exitRelay as Address;
/** The staked relay that pays gas for the Pledge Paid nine-frame payment. */
export const PAY_RELAY = deployments.payRelayWETH as Address;
/** What a recipient receives: one pool denomination minus ExitRelay's fee. */
export { EXIT_FEE };
export const PAYOUT = DEVNET.denomination - EXIT_FEE;

/** Read from the chain on 2026-11-07 ~00:55 IST; shown only if the devnet is unreachable, and labelled as such. */

/** Sidecar admission outcomes. dropped/replaced left the pool after it admitted them. */
export const OUTCOME: Record<string, { admitted: boolean; label: string }> = {
  accepted: { admitted: true, label: "accepted" },
  included: { admitted: true, label: "admitted, included" },
  rejected: { admitted: false, label: "rejected" },
  dropped: { admitted: true, label: "admitted, then dropped" },
  replaced: { admitted: true, label: "admitted, then replaced" },
};
export const outcomeOf = (o: string) => OUTCOME[o] ?? { admitted: false, label: o };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase() as Address;
interface WireLog { topics?: Hex[]; data: Hex }


// ---------------------------------------------------------------- frame-doctor

export type FrameState = "ok" | "failed" | "skipped" | "unknown";
export interface FrameRow { index: number; mode: string; target?: string; limit: bigint; state: FrameState; gasUsed?: bigint; note?: string }
/** What the panes, rule grid and frame list draw. Every field is read from checkAdmission, the sidecar or the node; none is invented. */
export interface DoctorView {
  txHash?: Hex;
  public?: MempoolVerdict;
  alt?: MempoolVerdict;
  /** Why a pane has no verdict. */
  notes: { public?: string; alt?: string };
  frames?: { rows: FrameRow[]; source: string };
  verifyGas?: bigint;
  node?: string;
}
/** ms: time the node took, measured inside the job, so a cached result keeps its real timing. */
export interface DoctorResult { text: string; ok: boolean; ms?: number; view: DoctorView }
export type PresetId = "run" | "latest" | "revert" | "mine" | "replay";
export interface DoctorJob { title: string; preset?: PresetId; run: () => Promise<DoctorResult> }

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const n = (x: number | bigint) => x.toLocaleString("en-US");
const MODES = ["DEFAULT", "VERIFY", "SENDER"];

/** Explain a sent tx from the sidecars' admission records, as `frame-doctor <txHash>` does. */
export const doctorHash = async (hash: Hex): Promise<DoctorResult> => {
  const candidates = await Promise.all(MEMPOOLS.map(async ({ name, url }) => {
    const [report, receipt, status] = await Promise.all([
      client.altpool.getAdmissionReport({ hash, mempool: name }).catch(() => null),
      client.altpool.getFrameTransactionReceipt({ hash, mempool: name }).catch(() => null),
      client.altpool.getTransactionStatus({ hash, mempool: name }).catch(() => null),
    ]);
    const rec = report && report.outcome !== "unknown" ? report : null;
    return { rec, receipt, status, url };
  }));
  // Prefer a node whose record says admitted (the gateway may hold only a rejected replay), then any record, then a receipt.
  const score = (c: (typeof candidates)[number]) => (c.rec && outcomeOf(c.rec.outcome).admitted ? 4 : 0) + (c.rec ? 2 : 0) + (c.receipt?.blockNumber ? 1 : 0);
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  const { rec, receipt, status, url } = best;
  // getFrameTransactionReceipt throws for a plain tx, so ask the chain directly before calling the hash unknown.
  const plain = rec || receipt?.blockNumber ? null : await client.getTransactionReceipt({ hash }).catch(() => null);
  const lines = [`frame-doctor ${hash}`];
  const view: DoctorView = { txHash: hash, notes: {}, node: url };
  if (rec) {
    const d = diagnoseAdmission({ outcome: rec.outcome, checks: rec.checks });
    const v: MempoolVerdict = {
      mempool: "alt", source: "explorer", verdict: outcomeOf(rec.outcome).admitted ? "admitted" : "rejected", checks: rec.checks,
      ...(d && { failed: { rule: d.rule, ercRule: d.ercRule, frameIndex: d.frameIndex }, fix: d.fix, error: { code: rec.errorCode ?? 0, message: d.detail } }),
    };
    view.alt = v;
    lines.push(...renderVerdict(v));
  } else if (receipt?.blockNumber) {
    view.notes.alt = "The tx is on chain, but the sidecar no longer has its admission record.";
    lines.push("  alt    ? no admission record  the tx is on chain, but the sidecar no longer has its record.");
  } else if (plain) {
    view.notes.alt = `On chain in block ${plain.blockNumber}, but not a frame transaction.`;
    lines.push(`  status on chain in block ${plain.blockNumber}, not a frame transaction`);
  } else {
    view.notes.alt = "Unknown hash: neither the sidecars nor the chain know it. Paste the raw tx to simulate it.";
    lines.push("  alt    ? unknown hash  neither the sidecars nor the chain know it. Paste the raw tx to simulate it.");
  }
  // A sent tx can't be re-simulated (its nonce key is spent), but the public gas cap is readable from the tx itself.
  const prefix = status?.tx ? validationPrefixLength(profile, status.tx) : 0;
  const limit = status?.tx ? status.tx.frames.slice(0, prefix).reduce((s, f) => s + f.limits.execution, 0n) : 0n;
  if (limit > DEVNET.publicVerifyGasCap) {
    const pub: MempoolVerdict = {
      mempool: "public", source: "model", verdict: "rejected",
      failed: { rule: "public-gas-cap", ercRule: "BUDGET-010" },
      error: { code: 0, message: `validation prefix limits ${n(limit)} > ${n(DEVNET.publicVerifyGasCap)} public cap, read from the tx` },
      fix: "The public mempool caps the validation prefix at 100k gas. This tx needs the alt mempool.",
    };
    view.public = pub;
    lines.push(...renderVerdict(pub));
  } else {
    view.notes.public = "A sent tx can't be re-simulated, because its nonce key is now spent. Its prefix fits the public gas cap, so only a simulation before sending could say more.";
    lines.push("  public · not re-checked: a sent tx's nonce key is spent, so the node can't simulate it again");
  }
  if (status) {
    const frames = receipt?.frames.map((f) => (f.status === "success" ? "ok" : f.status));
    lines.push(`  status ${status.status}${receipt?.blockNumber ? ` in block ${receipt.blockNumber}` : ""}${frames?.length ? `, frames: ${frames.join(", ")}` : ""}`);
  }
  const p = status?.tx ? validationPrefixLength(profile, status.tx) : 0;
  if (receipt && p) {
    view.verifyGas = receipt.frames.slice(0, p).reduce((s, f) => s + f.gasUsed.execution, 0n);
    lines.push(`  VERIFY gas used ${n(view.verifyGas)}`);
  }
  if (receipt && status?.tx) {
    const tx = status.tx;
    view.frames = {
      source: "frame receipt from the sidecar",
      rows: receipt.frames.map((f) => {
        const fr = tx.frames[f.index];
        return {
          index: f.index, mode: MODES[fr?.mode ?? -1] ?? "?", target: fr?.target ?? undefined, limit: fr?.limits.execution ?? 0n, gasUsed: f.gasUsed.execution,
          state: f.status === "success" ? "ok" : f.status === "skipped" ? "skipped" : "failed",
        };
      }),
    };
  }
  lines.push(`  node ${url}`);
  return { text: lines.join("\n"), ok: !!rec || !!receipt?.blockNumber || !!plain, view };
};

/** ethrex's own run of each frame (ethrex_simulateFrameTransaction), laid over the tx's frames. */
const frameRows = async (raw: Hex): Promise<DoctorView["frames"]> => {
  const tx = decodeTx(profile, raw);
  const sim = (await ethrex().simulateFrameTransaction(raw, false)) as unknown as {
    executionError?: string | null; failedFrameIndex?: number | null; revertData?: string | null; frames?: { status?: unknown; succeeded?: boolean; gasUsed?: unknown }[] | null;
  };
  const failedAt = sim.executionError ? (sim.failedFrameIndex ?? -1) : undefined;
  const big = (x: unknown) => { try { return x === undefined || x === null ? undefined : BigInt(x as string); } catch { return undefined; } };
  const rows = tx.frames.map((f, index): FrameRow => {
    const base = { index, mode: MODES[f.mode] ?? "?", target: f.target ?? undefined, limit: f.limits.execution };
    if (failedAt !== undefined) {
      if (index === failedAt) {
        const why = decodeRevert(sim.revertData ?? undefined) ?? pledgeRevert(sim.revertData ?? undefined);
        return { ...base, state: "failed", note: why ? `reverted: ${why}` : sim.executionError!.replace(/^Invalid Transaction: Invalid frame transaction: /, "") };
      }
      if (failedAt < 0) return { ...base, state: "unknown", note: index === 0 ? `no frame ran: ${sim.executionError!.replace(/^Invalid Transaction: /, "")}` : undefined };
      return index > failedAt ? { ...base, state: "skipped", note: "not run, an earlier frame failed" } : { ...base, state: "ok" };
    }
    const r = sim.frames?.[index];
    if (!r) return { ...base, state: "unknown" };
    // The node reports `succeeded` per frame. The first failure is the frame that reverts; the frames after it never ran.
    const ok = r.succeeded === true || r.status === "success" || r.status === 1 || r.status === "0x1";
    return { ...base, state: ok ? "ok" : "failed", gasUsed: big(r.gasUsed) };
  });
  const first = rows.findIndex((r) => r.state === "failed");
  if (first >= 0) {
    rows.forEach((r, i) => { if (i > first && r.state === "failed") Object.assign(r, { state: "skipped", note: "not run, an earlier frame failed" }); });
    const why = pledgeRevert(sim.revertData ?? undefined) ?? (await whyFrameFails(raw, first));
    if (why) rows[first]!.note = `reverted: ${why}`;
  }
  return { rows, source: "ethrex_simulateFrameTransaction" };
};

/** Pledge Paid pins its VERIFY gas at 600k (PayChecks.PAY_VERIFY_GAS_MAX), not the simulator's 450k exit default. */
export const pledgeSimulator = createSimulator({ verifyGasMax: 600_000n, gateway: minerGateway, explorer: false });

const viewOf = (r: AdmissionReport, frames: DoctorView["frames"]): DoctorView =>
  ({ txHash: r.txHash, public: r.verdicts.public, alt: r.verdicts.alt, notes: {}, frames, verifyGas: r.verifyGas });

/** Run the real checkAdmission, plus the per-frame simulation (best effort: the verdicts stand without it). */
const checkView = async (input: Parameters<typeof simulator.check>[0] | Hex, raw: Hex, title?: string, sim?: typeof simulator): Promise<DoctorResult> => {
  // The model's VERIFY pin is our own per-relay limit, not a mempool rule: PayRelayWETH's is 600k, the exits' 450k.
  sim ??= decodeTx(profile, raw).sender?.toLowerCase() === PAY_RELAY.toLowerCase() ? pledgeSimulator : simulator;
  const [report, frames] = await Promise.all([sim.check(input as never), frameRows(raw).catch(() => undefined)]);
  return { text: renderReport(report, { title }), ok: report.verdicts.public.source === "simulate", view: viewOf(report, frames) };
};

/** Re-check a sent exit now: rebuild it from the sidecar's record and run the real checkAdmission. */
export const doctorReplay = async (hash: Hex): Promise<DoctorResult> => {
  const t0 = performance.now();
  const tx = (await client.altpool.getTransactionStatus({ hash }))?.tx;
  if (!tx) throw new Error(`the miner's sidecar no longer has ${short(hash)}`);
  const r = await checkView(tx, encodeTx(profile, tx), `frame-doctor: replay of ${short(hash)}, checked against the node now`);
  return { ...r, ms: Math.round(performance.now() - t0) };
};

export const runRawTx = (raw: Hex): Promise<DoctorResult> => checkView(raw, raw);

/** A raw Pledge Paid payment, checked as the live sender checks it (600k VERIFY pin). */
export const runPledgeTx = (raw: Hex): Promise<DoctorResult> => checkView(raw, raw, "frame-doctor: the Pledge Paid you built, checked now", pledgeSimulator);

/** The newest exit ExitRelay sent, read live from the miner sidecar's entity report. */
const newestExit = async (): Promise<Hex> => {
  const inc = (await entityStatus(EXIT_RELAY, minerGateway)).inclusions;
  const newest = inc.reduce<(typeof inc)[number] | undefined>((a, b) => (!a || b.block > a.block ? b : a), undefined);
  if (!newest) throw new Error("ExitRelay has no inclusions on the miner sidecar yet");
  return newest.hash;
};

export interface Preset { id: PresetId; label: string; job: DoctorJob }
/** The example buttons, in order. Pledge presets come from PayRelayWETH's live report (`runs`); a missing run hides its button. */
export const presetsFor = (runs: readonly PledgeRun[], mine: Hex | undefined, current?: CurrentRun): Preset[] => {
  const latest = runs.find((r) => r.outcome === "included");
  const revert = runs.find((r) => r.outcome === "reverted");
  const out: Preset[] = [];
  // Sent: the sidecar's record and the receipt. Not sent yet: the node simulates the raw tx now.
  if (current?.hash || current?.raw) {
    const { hash, raw } = current;
    out.push({ id: "run", label: "The run you just built / sent", job: { preset: "run", title: hash ? `Your run ${short(hash)} (${current.preset})` : `Your built run (${current.preset})`, run: () => (hash ? doctorHash(hash) : runPledgeTx(raw!)) } });
  }
  if (latest) out.push({ id: "latest", label: `Latest Pledge Paid on chain${latest.block ? ` (block ${latest.block})` : ""}`, job: { preset: "latest", title: `Pledge Paid ${short(latest.hash)}`, run: () => doctorHash(latest.hash) } });
  if (revert) out.push({ id: "revert", label: "Latest reverted Pledge Paid", job: { preset: "revert", title: `Reverted Pledge Paid ${short(revert.hash)}`, run: () => doctorHash(revert.hash) } });
  // A rejection on purpose: the newest exit sent again. Its note is withdrawn, so both mempools must refuse it, and the fix says why.
  out.push({ id: "replay", label: "Double-spend: resend a withdrawn exit", job: { preset: "replay", title: "Double-spend attempt: the newest ExitRelay exit, sent again (should be rejected)", run: async () => doctorReplay(await newestExit()) } });
  if (mine) out.push({ id: "mine", label: "Check the tx you just sent", job: { preset: "mine", title: `Your tx ${short(mine)}`, run: () => doctorHash(mine) } });
  return out;
};

/** The input box: a 32-byte hash is looked up, anything longer is simulated as a raw tx. A string is a usage error. */
export const jobForInput = (input: string): DoctorJob | string => {
  const v = input.trim();
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(v)) return "Paste a 0x-prefixed tx hash or raw frame transaction (even-length hex).";
  return v.length === 66 ? { title: `Hash ${short(v)}`, run: () => doctorHash(v as Hex) } : { title: "Raw tx", run: () => runRawTx(v as Hex) };
};

// ---------------------------------------------------------------- the rule grid

type Scope = "alt" | "public" | "both";
/** Every rule checkAdmission can name, in display order, each with the one-line reason it exists. */
export const RULES: { id: RuleId; scope: Scope; info: string }[] = [
  { id: "gas-limit", scope: "both", info: "Frame gas must stay under the per-tx cap, and under our VERIFY pin on the alt mempool." },
  { id: "prefix", scope: "both", info: "The validation prefix must be a recognised shape: self_verify, or only_verify then pay (PREFIX-010)." },
  { id: "structure", scope: "both", info: "VERIFY frames target the sender or null, sit only in the prefix, and never set ATOMIC_BATCH_FLAG." },
  { id: "signature", scope: "both", info: "Signatures must cover the final tx. Gas estimation changes the limits, so sign after filling in gas (SIGNATURE-010)." },
  { id: "simulation", scope: "both", info: "Running the validation prefix must succeed: nonce, payer balance, and no VERIFY revert." },
  { id: "trace-alignment", scope: "alt", info: "Sidecar invariant: the ERC-7562 trace must line up with the validation prefix." },
  { id: "OP-011", scope: "alt", info: "VERIFY may not use banned opcodes such as TIMESTAMP or NUMBER. A staked entity may use BALANCE (OPCODES-010)." },
  { id: "OP-061", scope: "alt", info: "VERIFY runs static: no nested CALL with value." },
  { id: "out-of-gas", scope: "alt", info: "An entity's VERIFY frame may not revert on out-of-gas (OPCODES-040)." },
  { id: "create", scope: "alt", info: "Only the deploy frame may CREATE, once, at tx.sender (CREATION-010)." },
  { id: "storage", scope: "alt", info: "VERIFY may read another account's storage only if that entity is staked (STORAGE-031..033)." },
  { id: "COD-010", scope: "alt", info: "VERIFY may not touch an address with no code." },
  { id: "entrypoint-access", scope: "alt", info: "VERIFY may not read the EntryPoint sentinel's code." },
  { id: "recent-root", scope: "alt", info: "A recent-root reference must be committed in the predeploy and inside its window." },
  { id: "mempool", scope: "alt", info: "Reputation and pool policy: banned entities, throttle limits, nonce-key holds, fee bumps." },
  { id: "admission", scope: "alt", info: "Not a check of its own. It lights when the sidecar rejects a tx without naming the failed check. Read the tx's record on the explorer." },
  { id: "execution", scope: "alt", info: "Whether the frames after validation succeed in the node's simulation. The sidecar admits a tx that will revert (finding 9), so a predicted revert is a warning, not a rejection." },
  { id: "nullifier-spent", scope: "both", info: "The relay's VERIFY (ExitRelay or PayRelayWETH) rejects a note that was already withdrawn, so a spent note can never be paid twice." },
  { id: "public-storage", scope: "public", info: "The public mempool lets VERIFY read only the sender's own storage (STORAGE-010)." },
  { id: "public-gas-cap", scope: "public", info: "The public mempool caps the whole validation prefix at 100k gas (BUDGET-010)." },
];

export type RuleState = "pass" | "fail" | "unchecked";
export interface RuleCell { state: RuleState; why?: string }

/** Light each rule for this input. Only what a verdict or a check record says: a rule nobody reported stays "unchecked". */
export const ruleCells = (v: DoctorView | undefined): Map<RuleId, RuleCell> => {
  const out = new Map<RuleId, RuleCell>();
  if (!v) return out;
  const set = (rule: RuleId, c: RuleCell) => { if (out.get(rule)?.state !== "fail") out.set(rule, c); };
  for (const m of [v.public, v.alt]) {
    if (!m) continue;
    const via = `${m.mempool} mempool, ${m.source === "model" ? "local model" : m.source === "explorer" ? "sidecar record" : "node simulation"}`;
    for (const c of m.checks ?? []) if (c.verdict === "pass") set(c.rule, { state: "pass", why: `Passed (${via}).` });
    for (const c of m.checks ?? []) if (c.verdict === "fail") set(c.rule, { state: "fail", why: c.detail ?? `Failed (${via}).` });
    if (m.verdict === "rejected" && m.failed) set(m.failed.rule, { state: "fail", why: m.error?.revertReason ?? m.error?.message ?? `Failed (${via}).` });
  }
  if (v.public?.verdict === "admitted" && v.public.source === "simulate") {
    for (const r of ["public-gas-cap", "public-storage", "simulation"] as RuleId[]) set(r, { state: "pass", why: "ethrex admitted the tx to the public mempool." });
  }
  return out;
};
