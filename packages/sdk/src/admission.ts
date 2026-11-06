// Admission diagnostics. Four different things, never mixed up:
//   1. structure   - local checks, no RPC
//   2. estimate    - sidecar eth_estimateFrameTransactionGas: runs the alt rule engine (signature, simulation, storage,
//                    opcodes, stake) but skips gas-limit, recent-root, reputation and mempool limits
//   3. simulate    - ethrex_simulateFrameTransaction: the PUBLIC mempool's gates; valid=true is necessary, not sufficient
//   4. report      - the explorer's admission record, available only after a node processed a real submission
// A preflight is a prediction. Only (4) says what a node actually did.
import type { AdmissionChecker, Address, EntityRole, Hex, RuleId } from "@altpool/core";
import { encodeTx, txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import type { Client } from "viem";
import { AltpoolSdkError, decodeRpcError, ruleFromMessage } from "./errors";
import { parseSimulation, type AdmissionRecord, type CheckStatus, type ExplorerInfo, type ExplorerRuleCheck, type LifecycleEvent, type NodeIdentity, type PublicSimulation, type SidecarConfig } from "./normalize";
import { prepareNonceKeys, validateNonceKeys } from "./nonces";
import type { Profile } from "./profiles";
import { validateRecentRootReferences } from "./recentRoots";
import type { AltMempoolClient } from "./sidecar";
import { getEntityStake, stakingParameters } from "./staking";
import { estimationProbe, gasReport, signFrameTransaction, validationPrefixLength, type FrameGasReport, type FrameSigner, type GasMargin } from "./transaction";

export type CheckSource = "local" | "sidecar-estimate" | "ethrex-simulate" | "contract" | "node-reputation" | "node-mempool" | "precheck" | "explorer";
export type PreflightStage = "structure" | "estimate" | "simulate" | "stake" | "reputation" | "mempool" | "recent-root" | "precheck";

export interface PreflightCheck {
  stage: PreflightStage;
  rule: RuleId | string;
  status: CheckStatus;
  entity?: { role: EntityRole; address?: Address };
  frameIndex?: number;
  message: string;
  fix?: string;
  source: CheckSource;
  /** Which node answered (node-local facts such as reputation). */
  node?: string;
}

export interface MempoolPrediction {
  mempool: string;
  /** Always "prediction": nothing was submitted. */
  kind: "prediction";
  status: "likely-admitted" | "likely-rejected" | "unknown";
  checks: PreflightCheck[];
}

export interface PreflightResult {
  transactionHash: Hex;
  profile: string;
  public: MempoolPrediction;
  alternative: MempoolPrediction;
  gas?: FrameGasReport;
  simulation?: PublicSimulation;
  notes: string[];
}

export interface PreflightArgs {
  transaction: FrameTx;
  /** Signs the estimation probe and the simulate copy locally. Without it, estimate/simulate use the tx as given. */
  signer?: FrameSigner;
  /** Extra checker (e.g. @altpool/simulator). Its verdicts are attached with source "precheck". */
  precheck?: AdmissionChecker;
  margin?: GasMargin;
  /** Look up node-local reputation for the sender/payer (scans up to this many pages of 200). Default 3; 0 skips. */
  reputationPages?: number;
}

const verdict = (checks: PreflightCheck[]): MempoolPrediction["status"] =>
  checks.some((c) => c.status === "fail") ? "likely-rejected" : checks.some((c) => c.stage !== "precheck" && c.status === "unknown") ? "unknown" : "likely-admitted";

/** Never submits. Signs copies locally only when a signer is given. */
export async function preflightFrameTransaction(client: Client, sidecar: AltMempoolClient, args: PreflightArgs): Promise<PreflightResult> {
  const profile = sidecar.profile;
  const tx = args.transaction;
  const notes: string[] = ["Preflight is a prediction. Admission is decided by the node at submission; read it with getAdmissionReport(hash)."];
  const pub: PreflightCheck[] = [];
  const alt: PreflightCheck[] = [];
  const node = sidecar.node.name;

  // 1. structure (local)
  const config = await sidecar.getConfig();
  const structure: PreflightCheck[] = [];
  const push = (c: Omit<PreflightCheck, "stage" | "source"> & Partial<Pick<PreflightCheck, "stage" | "source">>) => structure.push({ stage: "structure", source: "local", ...c });
  push({ rule: "chain-id", status: Number(tx.chainId) === config.chainId ? "pass" : "fail", message: `tx chainId ${tx.chainId}, node ${config.chainId}`, fix: "Build the tx for the node's chain." });
  const modes = new Set(Object.values(profile.frameModes));
  const badMode = tx.frames.findIndex((f) => !modes.has(f.mode));
  push({ rule: "frame-modes", status: badMode < 0 ? "pass" : "fail", frameIndex: badMode < 0 ? undefined : badMode, message: badMode < 0 ? "all modes exist in the profile" : `frame ${badMode} has a mode ${profile.id} does not have` });
  const prefix = validationPrefixLength(profile, tx);
  push({ rule: "prefix", status: prefix > 0 ? "pass" : "fail", message: prefix > 0 ? `validation prefix = frames 0..${prefix - 1}` : "no VERIFY frame: nothing approves execution or payment", fix: "Add a VERIFY frame that APPROVEs." });
  for (const c of validateNonceKeys(profile, tx.nonceKeys)) push({ rule: c.rule, status: c.status, message: c.message });
  const total = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
  if (config.txGasLimit !== undefined) push({ rule: "gas-limit", status: total <= config.txGasLimit ? "pass" : "fail", message: `total limits ${total} vs node cap ${config.txGasLimit}` });
  push({ rule: "fees", status: tx.fees.maxFeePerGas > 0n && tx.fees.maxPriorityFeePerGas <= tx.fees.maxFeePerGas ? "pass" : "fail", message: `maxFee ${tx.fees.maxFeePerGas}, priority ${tx.fees.maxPriorityFeePerGas}` });
  pub.push(...structure.map((c) => ({ ...c })));
  alt.push(...structure);

  // 2. estimate (alt rule engine)
  let gas: FrameGasReport | undefined;
  try {
    const probe = args.signer ? await signFrameTransaction(profile, estimationProbe(profile, tx), args.signer) : tx;
    const est = await sidecar.estimateFrameTransactionGas(probe);
    gas = gasReport(profile, tx, est, args.margin);
    alt.push({ stage: "estimate", rule: "simulation", status: "pass", message: "sidecar rule engine accepted the tx (signature, simulation, storage, opcodes, stake)", source: "sidecar-estimate", node });
    for (const f of gas.frames) {
      if (f.inPrefix && f.headroom !== undefined && f.headroom < 0n) {
        alt.push({ stage: "estimate", rule: "out-of-gas", status: "fail", frameIndex: f.index, message: `prefix frame ${f.index} declares ${f.declared.execution} but used ${f.measured.execution}`, fix: "Raise the VERIFY frame's execution limit: prefix limits are not auto-estimated.", source: "sidecar-estimate", node });
      }
    }
  } catch (e) {
    const err = e instanceof AltpoolSdkError ? e : undefined;
    const sigWithoutSigner = err?.detail?.kind === "signature" && !args.signer;
    const x = err ? explainAdmissionFailure(err) : undefined;
    alt.push({
      stage: "estimate", rule: x?.rule ?? "unknown", status: sigWithoutSigner ? "unknown" : "fail", entity: x?.entity, frameIndex: x?.frameIndex,
      message: sigWithoutSigner ? "estimate needs a signature made over the estimator's placeholder limits; pass a signer" : (err?.message ?? String(e)),
      fix: x?.fix, source: "sidecar-estimate", node,
    });
  }

  // 3. public simulate (ethrex)
  let simulation: PublicSimulation | undefined;
  try {
    const signed = args.signer ? await signFrameTransaction(profile, tx, args.signer) : tx;
    simulation = await simulateFrameTransaction(client, profile, signed);
    const rule = simulation.violation ? ruleFromMessage(simulation.violation, "public") ?? "unknown" : undefined;
    pub.push({
      stage: "simulate", rule: rule ?? "public-rules", status: simulation.valid ? "pass" : "fail",
      message: simulation.valid ? `ethrex accepts the prefix (${simulation.prefixShape ?? "?"})` : `ethrex: ${simulation.violation}`,
      fix: rule ? decodeRpcError({ method: "ethrex_simulateFrameTransaction", url: "", code: -32000, message: simulation.violation ?? "" }, "public").fix : undefined,
      entity: simulation.payer ? { role: "payer", address: simulation.payer } : undefined, source: "ethrex-simulate",
    });
    if (simulation.executionStatus && simulation.executionStatus !== "success") {
      notes.push(`Execution after the prefix ended "${simulation.executionStatus}"${simulation.executionError ? `: ${simulation.executionError}` : ""}. Admission can still succeed; the body may revert on chain.`);
    }
  } catch (e) {
    const err = e instanceof AltpoolSdkError ? e : undefined;
    pub.push({ stage: "simulate", rule: ruleFromMessage(err?.message ?? "", "public") ?? "unknown", status: "fail", message: err?.message ?? String(e), fix: err?.fix, source: "ethrex-simulate" });
  }

  // 4. stake (contract view) for the payer and a contract sender
  const entities: { role: EntityRole; address: Address }[] = [{ role: "sender", address: tx.sender }];
  if (simulation?.payer && simulation.payer.toLowerCase() !== tx.sender.toLowerCase()) entities.push({ role: "payer", address: simulation.payer });
  try {
    const params = stakingParameters(config, sidecar.node);
    for (const ent of entities) {
      const s = await getEntityStake(client, params, ent.address);
      const needs = !simulation?.valid && simulation?.violation && /StorageReadNonSender/i.test(simulation.violation);
      alt.push({
        stage: "stake", rule: "stake", entity: ent, source: "contract",
        status: s.meetsMinimum ? "pass" : needs && (ent.role === "payer" || s.isContract) ? "fail" : "unknown",
        message: s.meetsMinimum ? `${ent.role} staked ${s.amount} wei (delay ${s.unstakeDelaySec}s)` : `${ent.role} ${s.state === "none" ? "not staked" : s.state}; only needed if its validation touches non-sender storage`,
        fix: s.meetsMinimum ? undefined : `Stake the ${ent.role} from its own address (> ${params.minStake} wei).`,
      });
    }
  } catch (e) {
    alt.push({ stage: "stake", rule: "stake", status: "unknown", message: `stake lookup failed: ${(e as Error).message}`, source: "contract" });
  }

  // 5. reputation (node-local)
  const pages = args.reputationPages ?? 3;
  if (pages > 0) {
    const found = new Map<string, { status: string; opsSeen: number; opsIncluded: number }>();
    try {
      let cursor: string | undefined;
      for (let i = 0; i < pages && found.size < entities.length; i++) {
        const r = await sidecar.listReputation({ cursor, limit: 200 });
        for (const x of r.items) if (entities.some((e) => e.address.toLowerCase() === x.address.toLowerCase())) found.set(x.address.toLowerCase(), x);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      for (const ent of entities) {
        const x = found.get(ent.address.toLowerCase());
        alt.push({
          stage: "reputation", rule: "reputation", entity: ent, source: "node-reputation", node,
          status: !x ? "unknown" : x.status === "ok" ? "pass" : "fail",
          message: !x ? `no reputation entry for the ${ent.role} on ${node} (node-local)` : `${x.status} on ${node}: seen ${x.opsSeen}, included ${x.opsIncluded} (node-local)`,
        });
      }
    } catch (e) {
      alt.push({ stage: "reputation", rule: "reputation", status: "unknown", message: `reputation unavailable: ${(e as Error).message}`, source: "node-reputation", node });
    }
  }

  // 6. mempool: keys held by another pending tx on this node
  try {
    const k = await prepareNonceKeys(client, profile, { sender: tx.sender, keys: tx.nonceKeys, pending: sidecar });
    const seqOk = k.nonceSeq === tx.nonceSeq;
    alt.push({ stage: "mempool", rule: "nonce", status: seqOk ? "pass" : "fail", message: seqOk ? `nonceSeq ${tx.nonceSeq} matches chain` : `nonceSeq ${tx.nonceSeq}, chain expects ${k.nonceSeq}`, source: "contract" });
    const pend = k.checks.find((c) => c.rule === "nonce-key-pending")!;
    alt.push({ stage: "mempool", rule: "mempool", status: pend.status === "fail" ? "unknown" : pend.status, message: pend.status === "fail" ? `${pend.message}: a replacement needs +10% on both fees` : pend.message, source: "node-mempool", node });
  } catch (e) {
    alt.push({ stage: "mempool", rule: "nonce", status: "fail", message: (e as Error).message, source: "contract" });
  }

  // 7. recent roots
  if (tx.recentRootReferences.length) {
    try {
      const v = await validateRecentRootReferences(client, profile, tx.recentRootReferences);
      for (const c of v.checks) alt.push({ stage: "recent-root", rule: "recent-root", status: c.status, frameIndex: undefined, message: `${c.index !== undefined ? `ref ${c.index} ` : ""}${c.rule}: ${c.message}`, source: "contract" });
    } catch (e) {
      alt.push({ stage: "recent-root", rule: "recent-root", status: "unknown", message: (e as Error).message, source: "contract" });
    }
  }

  // 8. external checker
  if (args.precheck) {
    try {
      const rep = await args.precheck.check(tx);
      for (const [mempool, v] of Object.entries(rep.verdicts)) {
        const c: PreflightCheck = {
          stage: "precheck", rule: v.failed?.rule ?? "precheck", status: v.verdict === "admitted" ? "pass" : "fail",
          entity: v.failed?.entity, frameIndex: v.failed?.frameIndex, message: `${v.source}${v.source === "model" ? " (unverified model)" : ""}: ${v.verdict}${v.error ? ` - ${v.error.message}` : ""}`,
          fix: v.fix, source: "precheck",
        };
        (mempool === "public" ? pub : alt).push(c);
      }
    } catch (e) {
      notes.push(`precheck failed: ${(e as Error).message}`);
    }
  }

  return {
    transactionHash: txHash(profile, tx),
    profile: profile.id,
    public: { mempool: "public", kind: "prediction", status: verdict(pub), checks: pub },
    alternative: { mempool: node, kind: "prediction", status: verdict(alt), checks: alt },
    gas,
    simulation,
    notes,
  };
}

/** `ethrex_simulateFrameTransaction` on the execution client (public-mempool gates + full execution). Takes a signed tx. */
export async function simulateFrameTransaction(client: Client, profile: Profile, tx: FrameTx, opts: { trace?: boolean; block?: string } = {}): Promise<PublicSimulation> {
  try {
    const r = await client.request({ method: "ethrex_simulateFrameTransaction" as any, params: [encodeTx(profile, tx), opts.block ?? "latest", { trace: !!opts.trace }] as any });
    return parseSimulation(r);
  } catch (e: any) {
    const inner = e?.cause ?? e;
    throw decodeRpcError({ method: "ethrex_simulateFrameTransaction", url: "execution", code: inner?.code ?? -32000, message: inner?.details ?? inner?.message ?? String(e), data: inner?.data, raw: e }, "public");
  }
}

// ---------------------------------------------------------------- after submission

export interface AdmissionReportView {
  hash: Hex;
  /** "actual": what this node did with a real submission. */
  kind: "actual";
  outcome: AdmissionRecord["outcome"] | "unknown";
  errorCode?: number;
  source?: string;
  at?: Date;
  checks: ExplorerRuleCheck[];
  failed: ExplorerRuleCheck[];
  events: LifecycleEvent[];
  frameStatuses?: AdmissionRecord["frameStatuses"];
  explanation?: Explanation;
  /** Admission records are node-local and kept in memory on the public devnet (lost on restart). */
  node: NodeIdentity;
  explorerUrl?: string;
  raw: unknown;
}

export async function getAdmissionReport(sidecar: AltMempoolClient, hash: Hex, opts: { explorerUrl?: string } = {}): Promise<AdmissionReportView | null> {
  const t = await sidecar.getExplorerTransaction(hash);
  if (!t) return null;
  const a = t.admission;
  const failed = a?.checks.filter((c) => c.status === "fail") ?? [];
  return {
    hash,
    kind: "actual",
    outcome: a?.outcome ?? "unknown",
    errorCode: a?.errorCode,
    source: a?.source,
    at: a?.at,
    checks: a?.checks ?? [],
    failed,
    events: t.events,
    frameStatuses: a?.frameStatuses,
    explanation: failed.length ? explainAdmissionFailure(a!) : undefined,
    node: t.node,
    explorerUrl: opts.explorerUrl ? `${opts.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : undefined,
    raw: t.raw,
  };
}

export interface Explanation {
  rule: RuleId | string;
  status: "fail";
  entity?: { role: EntityRole; address?: Address };
  frameIndex?: number;
  message: string;
  revertReason?: string;
  fix?: string;
  source: "rpc-error" | "explorer";
}

/** Turn a thrown SDK error or an explorer admission record into one explanation with a fix. */
export function explainAdmissionFailure(input: AltpoolSdkError | AdmissionRecord): Explanation {
  if (input instanceof AltpoolSdkError) {
    const d = input.detail;
    const base = { status: "fail" as const, message: input.message, fix: input.fix, source: "rpc-error" as const };
    switch (d?.kind) {
      case "ruleViolation": return { ...base, rule: d.rule, entity: d.entity };
      case "validationReverted": return { ...base, rule: "simulation", frameIndex: d.frameIndex, revertReason: d.revertReason };
      case "reputation": return { ...base, rule: "reputation", entity: { role: d.role, address: d.address } };
      case "signature": return { ...base, rule: "signature" };
      case "nonceKeyHeld": case "replacementUnderpriced": return { ...base, rule: "mempool" };
      case "recentRoot": return { ...base, rule: "recent-root" };
      case "decode": return { ...base, rule: "structure" };
      default: return { ...base, rule: ruleFromMessage(input.message) ?? "unknown" };
    }
  }
  const f = input.checks.find((c) => c.status === "fail");
  const detail = f?.detail ?? `outcome ${input.outcome}${input.errorCode ? ` (code ${input.errorCode})` : ""}`;
  const decoded = decodeRpcError({ method: "explorer", url: "", code: input.errorCode ?? -32000, message: detail });
  return {
    rule: f?.rule ?? "admission",
    status: "fail",
    entity: f?.entity ? { role: f.entity } : undefined,
    frameIndex: f?.frameIndex,
    message: detail,
    revertReason: decoded.detail?.kind === "validationReverted" ? decoded.detail.revertReason : undefined,
    fix: decoded.fix,
    source: "explorer",
  };
}

// ---------------------------------------------------------------- node comparison

export interface NodeProfile { name: string; config: SidecarConfig; info?: ExplorerInfo }
export interface ProfileDiffRow { parameter: string; a: unknown; b: unknown; same: boolean }

/** Side-by-side of two nodes' admission-relevant configuration. */
export function compareMempoolProfiles(a: NodeProfile, b: NodeProfile): { a: string; b: string; rows: ProfileDiffRow[]; differences: number } {
  const pick = (n: NodeProfile) => ({
    chainId: n.config.chainId,
    version: n.info?.version,
    protocolVersion: n.info?.protocolVersion,
    p2pEnabled: n.info?.p2pEnabled,
    mempoolIds: n.config.supportedMempools.map((m) => m.mempoolId).join(","),
    entryPoint: n.config.canonicalEntryPoint,
    stakingRegistry: n.config.stakingRegistry,
    minStake: n.config.minStake,
    minUnstakeDelaySec: n.config.minUnstakeDelaySec,
    validationGasLimit: n.config.validationGasLimit,
    txGasLimit: n.config.txGasLimit,
    precompiles: n.config.precompiles.length,
    throttlingSlack: n.config.reputation.throttlingSlack,
    banSlack: n.config.reputation.banSlack,
    minInclusionDenominator: n.config.reputation.minInclusionDenominator,
  });
  const pa = pick(a), pb = pick(b);
  const rows = Object.keys(pa).map((k) => {
    const x = (pa as any)[k], y = (pb as any)[k];
    return { parameter: k, a: x, b: y, same: String(x) === String(y) };
  });
  return { a: a.name, b: b.name, rows, differences: rows.filter((r) => !r.same).length };
}
