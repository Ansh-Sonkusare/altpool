// Owner: Dev C. checkAdmission: will each mempool admit this tx, and why not?
//   public: ethrex_simulateFrameTransaction (source "simulate"): ethrex's own canonical-mempool verdict.
//   alt:    1. the explorer's admission record when the tx was already sent (source "explorer");
//           2. for a tx with no signatures (ExitRelay), the gateway's eth_estimateFrameTransactionGas, which runs the
//              sidecar's full rule engine with stake lookups but not reputation (research notes r3-r5 §2.1) (source "simulate");
//           3. otherwise our local rule model over the ethrex trace plus live stake and reputation (source "model", unverified).
//           frame_simulateTransactionV1 is not deployed (fixture public/22).
import { decodeAbiParameters, encodeFunctionData } from "viem";
import { decodeTx, encodeTx, txHash as hashTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import {
  DEVNET, ethrex as ethrexClient, gateway as gatewayClient, toWire,
  type AdmissionChecker, type AdmissionReport, type FrameTx, type Hex, type MempoolVerdict, type RuleCheck, type RuleId,
} from "@altpool/core";
import { decodeRevert, diagnoseAdmission, diagnoseError, diagnoseSimulation, type Diagnosis } from "./rules";
import { entitiesOf, runModel, verifyGasOf, type Entity, type Reputation, type StakeInfo, type TraceFrame } from "./model";

export const profile = getProfile(DEVNET.profile);

export interface SimulatorOptions {
  ethrex?: ReturnType<typeof ethrexClient>;
  gateway?: ReturnType<typeof gatewayClient>;
  /** Our self-imposed VERIFY gas pin (default DEVNET.verifyGasMax). */
  verifyGasMax?: bigint;
  /** Look the tx up on the explorer first (default true). */
  explorer?: boolean;
  /** Ask the gateway's estimator (the sidecar's rule engine) for unsigned txs (default true). */
  estimate?: boolean;
  /** What-if: treat every entity as unstaked (skips the estimator, which reads the real stake). */
  assumeUnstaked?: boolean;
}

/** ethrex verdicts that say nothing about the alt mempool: the alt rule model decides those. */
const PUBLIC_ONLY = new Set<RuleId>(["public-storage", "public-gas-cap", "OP-011", "COD-010"]);

const depositInfoAbi = [{
  type: "function", name: "getDepositInfo", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
}] as const;

const errOf = (e: unknown) => {
  const x = e as { code?: number | string; message?: string; data?: unknown };
  return { code: x.code ?? "unknown", message: x.message ?? String(e), data: x.data };
};
const numCode = (c: number | string) => (typeof c === "number" ? c : Number(String(c).replace(/^RPC_/, "")) || 0);

const verdictOf = (mempool: "public" | "alt", source: MempoolVerdict["source"], d: Diagnosis | undefined, extra: Partial<MempoolVerdict> = {}): MempoolVerdict =>
  d
    ? {
        mempool, source, verdict: "rejected",
        failed: { rule: d.rule, ercRule: d.ercRule, frameIndex: d.frameIndex, entity: d.entity?.address ? { role: d.entity.role, address: d.entity.address } : undefined },
        fix: d.fix, ...extra,
      }
    : { mempool, source, verdict: "admitted", ...extra };

/** A nonce mismatch on a non-zero nonce key means that key is used up. ExitRelay keys exits by nullifier hash. */
const keyedNonce = (d: Diagnosis | undefined, tx: FrameTx): Diagnosis | undefined => {
  if (!d || d.rule !== "simulation" || !/Nonce mismatch/.test(d.detail)) return d;
  const key = tx.nonceKeys.find((k) => k !== 0n);
  if (key === undefined) return d;
  return { ...d, fix: `Nonce key 0x${key.toString(16)} is already used. For an ExitRelay exit the key is the note's nullifier hash, so this note was already withdrawn: use a fresh note.` };
};

/** Fill a role-only entity from the tx (e.g. "payer uses banned opcode" names no address). */
const withAddress = (d: Diagnosis | undefined, entities: Entity[]): Diagnosis | undefined => {
  if (!d?.entity || d.entity.address) return d;
  const e = entities.find((x) => x.role === d.entity!.role);
  return e ? { ...d, entity: { role: e.role, address: e.address } } : d;
};

/** ethrex predicts the tx reverts after validation (docs/10 finding 9). The sidecar still admits it, so this warns and
 *  never flips a verdict: the tx lands reverted and its payer pays the gas. */
const executionWarning = (sim: any): RuleCheck | undefined => {
  if (sim?.executionStatus !== "reverted") return undefined;
  const frames: { gasUsed?: string; succeeded?: boolean }[] = sim.frames ?? [];
  const frameIndex = frames.findIndex((f) => f.succeeded === false);
  const reason = decodeRevert(sim.revertData ?? undefined) ?? sim.executionError ?? undefined;
  const gas = frameIndex >= 0 && frames[frameIndex]!.gasUsed !== undefined ? ` after ${Number(frames[frameIndex]!.gasUsed).toLocaleString("en-US")} gas` : "";
  return {
    rule: "execution", verdict: "warn", ...(frameIndex >= 0 && { frameIndex }),
    detail: `${frameIndex >= 0 ? `frame ${frameIndex}` : "the tx"} reverts in execution${gas}${reason ? `: ${reason}` : ""}. Admission still passes, so it would land reverted and the payer pays the gas.`,
  };
};
const warnOn = (v: MempoolVerdict, w: RuleCheck | undefined): MempoolVerdict =>
  w && v.verdict === "admitted" ? { ...v, checks: [...(v.checks ?? []), w] } : v;

/** Estimator answers that say nothing: ones that depend on the placeholder limits it swaps into body frames, and the
 *  public-mempool gas cap it echoes (the alt sidecar has no cap; live Nov 6, a replayed exit came back with it). */
const INCONCLUSIVE_ESTIMATE = /BadWithdrawFrame|CostTooHigh|BadFrameCount|per-transaction gas cap|Invalid frame transaction signature|prefix gas budget exceeded/;

export const createSimulator = (opts: SimulatorOptions = {}) => {
  const node = opts.ethrex ?? ethrexClient();
  const gw = opts.gateway ?? gatewayClient();

  const stakeOf = async (address: Hex): Promise<StakeInfo> => {
    if (opts.assumeUnstaked) return { staked: false, stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n };
    const data = encodeFunctionData({ abi: depositInfoAbi, functionName: "getDepositInfo", args: [address] });
    const out: Hex = await node.call("eth_call", [{ to: DEVNET.stakingRegistry, data }, "latest"]);
    const [stake, delay, withdrawTime] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], out);
    const unstakeDelaySec = Number(delay);
    return { stake, unstakeDelaySec, withdrawTime, staked: stake > DEVNET.minStakeWei && unstakeDelaySec >= DEVNET.unstakeDelaySec && withdrawTime === 0n };
  };

  const reputations = async (): Promise<Map<string, Reputation>> => {
    try {
      const r = await gw.listReputation(1000);
      return new Map((r?.items ?? []).map((i: any) => [String(i.address).toLowerCase(), { status: i.status, opsSeen: Number(i.opsSeen), opsIncluded: Number(i.opsIncluded) }]));
    } catch {
      return new Map();
    }
  };

  const explorerVerdict = async (hash: Hex): Promise<MempoolVerdict | undefined> => {
    try {
      const rec = await gw.admission(hash);
      if (!rec?.admission) return undefined;
      const d = diagnoseAdmission(rec.admission);
      return verdictOf("alt", "explorer", d, { checks: rec.admission.checks, error: d ? { code: rec.admission.errorCode ?? 0, message: d.detail, revertReason: d.revertReason } : undefined });
    } catch {
      return undefined; // not sent yet, or the explorer doesn't know it
    }
  };

  /** The sidecar's own rule engine, via the estimator. Undefined when its answer can't be trusted for this tx. */
  const estimateVerdict = async (tx: FrameTx, entities: Entity[]): Promise<MempoolVerdict | undefined> => {
    if (tx.signatures.length || opts.estimate === false || opts.assumeUnstaked) return undefined; // the estimator rewrites limits, breaking signatures
    try {
      await gw.estimateFrameTransactionGas(toWire(tx));
    } catch (e) {
      const err = errOf(e);
      const d = withAddress(diagnoseError(err, "alt"), entities);
      // The revert reason is decoded from data, so test it too: the message only carries the selector.
      if (INCONCLUSIVE_ESTIMATE.test(`${err.message} ${d?.revertReason ?? ""}`) || /RPC_UNREACHABLE|RPC_BAD_RESPONSE|-32601/.test(String(err.code))) return undefined;
      return verdictOf("alt", "simulate", d, { error: { code: numCode(err.code), message: err.message, revertReason: d?.revertReason } });
    }
    // The estimator skips reputation: a banned entity is still refused on send.
    const rep = await reputations();
    const banned = entities.find((e) => rep.get(e.address.toLowerCase())?.status === "banned");
    if (banned) {
      const d = diagnoseError({ code: -32504, message: `${banned.role} ${banned.address} is banned`, data: { [banned.role]: banned.address } }, "alt");
      return verdictOf("alt", "simulate", { ...d, entity: { role: banned.role, address: banned.address } });
    }
    return { mempool: "alt", source: "simulate", verdict: "admitted" };
  };

  const check = async (input: FrameTx | Hex): Promise<AdmissionReport> => {
    const tx = typeof input === "string" ? decodeTx(profile, input) : input;
    const raw = typeof input === "string" ? input : encodeTx(profile, tx);
    const txHash = hashTx(profile, tx);
    const entities = entitiesOf(tx);
    const explain = (d: Diagnosis | undefined) => withAddress(keyedNonce(d, tx), entities);

    // Public: ethrex's canonical-mempool simulation, with the ERC-7562 trace the alt model needs.
    let pub: MempoolVerdict;
    let pubDiag: Diagnosis | undefined;
    let trace: TraceFrame[] | undefined;
    let warning: RuleCheck | undefined;
    try {
      const sim = await node.simulateFrameTransaction(raw, true);
      warning = executionWarning(sim);
      trace = (sim.erc7562Trace ?? undefined) as TraceFrame[] | undefined;
      pubDiag = explain(diagnoseSimulation(sim));
      pub = verdictOf("public", "simulate", pubDiag, pubDiag ? { error: { code: 0, message: pubDiag.detail, revertReason: pubDiag.revertReason } } : {});
    } catch (e) {
      const err = errOf(e);
      pubDiag = explain(diagnoseError(err, "public"));
      pub = verdictOf("public", "simulate", pubDiag, { error: { code: numCode(err.code), message: err.message, revertReason: pubDiag?.revertReason } });
    }

    // Alt: the explorer if the tx was sent, else the model.
    const seen = (opts.explorer === false ? undefined : await explorerVerdict(txHash)) ?? (await estimateVerdict(tx, entities));
    let alt: MempoolVerdict;
    if (seen) {
      alt = seen;
    } else if (pubDiag && !PUBLIC_ONLY.has(pubDiag.rule)) {
      // The tx fails before any alt-only rule matters (bad signature, revert, nonce, decode, ...): alt rejects it too.
      alt = verdictOf("alt", "model", pubDiag, { error: pub.error });
    } else if (!trace) {
      alt = { mempool: "alt", source: "model", verdict: "rejected", failed: { rule: "unknown" }, fix: "ethrex returned no trace, so the alt rules could not be modelled. Send it, then run frame-doctor on the hash." };
    } else {
      const [stakeList, reputation] = await Promise.all([
        Promise.all(entities.map(async (e) => [e.address.toLowerCase(), await stakeOf(e.address)] as const)),
        reputations(),
      ]);
      const m = runModel({ tx, trace, stakes: new Map(stakeList), reputation, verifyGasMax: opts.verifyGasMax });
      let d: Diagnosis | undefined;
      if (m.failed) {
        const f = m.failed;
        d = diagnoseError({ code: 0, message: f.detail, data: { [f.entity.role]: f.entity.address } }, "alt");
        d = { ...d, rule: f.rule, frameIndex: f.frameIndex, entity: { role: f.entity.role, address: f.entity.address } };
        if (f.rule === "gas-limit") d.fix = `Lower the VERIFY limits to at most ${opts.verifyGasMax ?? DEVNET.verifyGasMax}, or justify raising the pin (docs/01).`;
      }
      alt = verdictOf("alt", "model", d, { checks: m.checks });
    }

    return { txHash, verdicts: { public: warnOn(pub, warning), alt: warnOn(alt, warning) }, verifyGas: verifyGasOf(tx) };
  };

  const checker: AdmissionChecker & { check: typeof check } = { check };
  return checker;
};

let defaultSimulator: ReturnType<typeof createSimulator> | undefined;

/** Check a frame tx (or its raw bytes) against both mempools on the public devnet. */
export const checkAdmission = (tx: FrameTx | Hex): Promise<AdmissionReport> =>
  (defaultSimulator ??= createSimulator()).check(tx);
