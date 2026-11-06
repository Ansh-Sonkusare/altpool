// Owner: Dev C. checkAdmission: will each mempool admit this tx, and why not?
//   public: ethrex_simulateFrameTransaction (source "simulate"): ethrex's own canonical-mempool verdict.
//   alt:    the explorer's admission record when the tx was already sent (source "explorer"); otherwise our
//           local rule model over the same ethrex trace plus live stake and reputation (source "model", unverified).
//           There is no alt dry-run: frame_simulateTransactionV1 is not deployed (fixture public/22).
import { decodeAbiParameters, encodeFunctionData } from "viem";
import { decodeTx, encodeTx, txHash as hashTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import {
  DEVNET, ethrex as ethrexClient, gateway as gatewayClient,
  type AdmissionChecker, type AdmissionReport, type FrameTx, type Hex, type MempoolVerdict, type RuleId,
} from "@altpool/core";
import { diagnoseAdmission, diagnoseError, diagnoseSimulation, type Diagnosis } from "./rules";
import { entitiesOf, runModel, verifyGasOf, type Entity, type Reputation, type StakeInfo, type TraceFrame } from "./model";

export const profile = getProfile(DEVNET.profile);

export interface SimulatorOptions {
  ethrex?: ReturnType<typeof ethrexClient>;
  gateway?: ReturnType<typeof gatewayClient>;
  /** Our self-imposed VERIFY gas pin (default DEVNET.verifyGasMax). */
  verifyGasMax?: bigint;
  /** Look the tx up on the explorer first (default true). */
  explorer?: boolean;
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

/** Fill a role-only entity from the tx (e.g. "payer uses banned opcode" names no address). */
const withAddress = (d: Diagnosis | undefined, entities: Entity[]): Diagnosis | undefined => {
  if (!d?.entity || d.entity.address) return d;
  const e = entities.find((x) => x.role === d.entity!.role);
  return e ? { ...d, entity: { role: e.role, address: e.address } } : d;
};

export const createSimulator = (opts: SimulatorOptions = {}) => {
  const node = opts.ethrex ?? ethrexClient();
  const gw = opts.gateway ?? gatewayClient();

  const stakeOf = async (address: Hex): Promise<StakeInfo> => {
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

  const check = async (input: FrameTx | Hex): Promise<AdmissionReport> => {
    const tx = typeof input === "string" ? decodeTx(profile, input) : input;
    const raw = typeof input === "string" ? input : encodeTx(profile, tx);
    const txHash = hashTx(profile, tx);
    const entities = entitiesOf(tx);

    // Public: ethrex's canonical-mempool simulation, with the ERC-7562 trace the alt model needs.
    let pub: MempoolVerdict;
    let pubDiag: Diagnosis | undefined;
    let trace: TraceFrame[] | undefined;
    try {
      const sim = await node.simulateFrameTransaction(raw, true);
      trace = (sim.erc7562Trace ?? undefined) as TraceFrame[] | undefined;
      pubDiag = withAddress(diagnoseSimulation(sim), entities);
      pub = verdictOf("public", "simulate", pubDiag, pubDiag ? { error: { code: 0, message: pubDiag.detail, revertReason: pubDiag.revertReason } } : {});
    } catch (e) {
      const err = errOf(e);
      pubDiag = withAddress(diagnoseError(err, "public"), entities);
      pub = verdictOf("public", "simulate", pubDiag, { error: { code: numCode(err.code), message: err.message, revertReason: pubDiag?.revertReason } });
    }

    // Alt: the explorer if the tx was sent, else the model.
    const seen = opts.explorer === false ? undefined : await explorerVerdict(txHash);
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

    return { txHash, verdicts: { public: pub, alt }, verifyGas: verifyGasOf(tx) };
  };

  const checker: AdmissionChecker & { check: typeof check } = { check };
  return checker;
};

let defaultSimulator: ReturnType<typeof createSimulator> | undefined;

/** Check a frame tx (or its raw bytes) against both mempools on the public devnet. */
export const checkAdmission = (tx: FrameTx | Hex): Promise<AdmissionReport> =>
  (defaultSimulator ??= createSimulator()).check(tx);
