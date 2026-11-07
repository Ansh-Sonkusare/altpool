// Offline accuracy benchmark: does the simulator PREDICT what the nodes did?
// Prediction runs with every lookup off (no explorer record, no estimator), over a captured ethrex_simulateFrameTransaction
// response plus captured stake and reputation reads. The nodes' own outcomes for the same tx (sidecar send/estimate result,
// ethrex send result, explorer admission record) are held out and only compared afterwards.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { encodeAbiParameters, type Hex } from "viem";
import { decodeTx, txHash as hashTx } from "@forshtat/hegota-support/tx";
import { type FrameTx, type Mempool, type gateway } from "@altpool/core";
import { createSimulator, profile } from "./check";
import { diagnoseAdmission, diagnoseError } from "./rules";

export const CORE_FIXTURES = new URL("../../core/fixtures/", import.meta.url);
/** Extra captures in the same {request, response} format (e.g. a live pre-send simulate paired with its later send). */
export const EXTRA_FIXTURES = new URL("../accuracy/fixtures/", import.meta.url);

export interface Capture {
  file: string;
  request: { method: string; params: unknown[] };
  response: { result?: any; error?: { code: number; message: string; data?: unknown } };
}

export type OutcomeSource = "sidecar-send" | "ethrex-send" | "sidecar-estimate" | "explorer-admission";

export interface Outcome {
  mempool: Mempool;
  source: OutcomeSource;
  file: string;
  admitted: boolean;
  /** Our rule id for the rejection, from the node's own text. Undefined when admitted. */
  rule?: string;
  detail?: string;
}

/** What a capture says about the node's verdict: an outcome, or why it says nothing. */
export type Extracted = { outcome: Outcome } | { inconclusive: string };

// ---- fixture parsing -------------------------------------------------------------------------------------------------

const walk = (dir: URL): URL[] => {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.sort().flatMap((n) => {
    const u = new URL(n, dir);
    return statSync(u).isDirectory() ? walk(new URL(`${n}/`, dir)) : [u];
  });
};

/** Every {request:{method,params}, response} JSON file under the roots. Notes, event logs and non-call JSON are skipped. */
export const loadCaptures = (roots: URL[] = [CORE_FIXTURES, EXTRA_FIXTURES]): Capture[] => {
  const out: Capture[] = [];
  for (const root of roots) {
    for (const u of walk(root)) {
      if (!u.pathname.endsWith(".json")) continue;
      const c = parseCapture(readFileSync(u, "utf8"), u.pathname.slice(root.pathname.length), root === CORE_FIXTURES ? "" : "accuracy/fixtures/");
      if (c) out.push(c);
    }
  }
  return out;
};

export const parseCapture = (text: string, file: string, prefix = ""): Capture | undefined => {
  let d: any;
  try { d = JSON.parse(text); } catch { return undefined; }
  if (typeof d?.request?.method !== "string" || !Array.isArray(d.request.params) || typeof d.response !== "object" || d.response === null) return undefined;
  return { file: prefix + file, request: { method: d.request.method, params: d.request.params }, response: d.response };
};

const big = (x: unknown): bigint => BigInt(x as string | number);

/** Identity of a tx that ignores signatures and fees: estimates rewrite limits only on the wire, and are sent unsigned. */
export const identityOfFrameTx = (t: { sender: string; nonceKeys: readonly bigint[]; nonceSeq: bigint; frames: readonly { mode: number | bigint; flags: number | bigint; target: string | null; limits: { execution: bigint; state: bigint }; value: bigint; data: string }[] }): string =>
  JSON.stringify([
    t.sender.toLowerCase(), t.nonceKeys.map(String), String(t.nonceSeq),
    t.frames.map((f) => [String(f.mode), String(f.flags), (f.target ?? "").toLowerCase(), String(f.limits.execution), String(f.limits.state), String(f.value), f.data.toLowerCase()]),
  ]);

/** The JSON form of eth_sendFrameTransaction / eth_estimateFrameTransactionGas. Undefined when it isn't a full frame tx. */
export const identityOfWire = (w: any): string | undefined => {
  try {
    if (!w || typeof w.sender !== "string" || !Array.isArray(w.frames) || !Array.isArray(w.nonceKeys) || w.nonceSeq === undefined) return undefined;
    return identityOfFrameTx({
      sender: w.sender, nonceKeys: w.nonceKeys.map(big), nonceSeq: big(w.nonceSeq),
      frames: w.frames.map((f: any) => ({ mode: big(f.mode), flags: big(f.flags), target: f.target ?? null, limits: { execution: big(f.limits.execution), state: big(f.limits.state) }, value: big(f.value ?? 0), data: f.data ?? "0x" })),
    });
  } catch { return undefined; }
};

export const decodeRaw = (raw: unknown): FrameTx | undefined => {
  if (typeof raw !== "string" || !/^0x06/.test(raw)) return undefined;
  try { return decodeTx(profile, raw as Hex); } catch { return undefined; }
};

export const identityOfRaw = (raw: unknown): string | undefined => {
  const tx = decodeRaw(raw);
  return tx && identityOfFrameTx(tx);
};

// ---- outcome extraction ----------------------------------------------------------------------------------------------

/** Estimator answers that say nothing about the sidecar's verdict (same set check.ts refuses to trust): placeholder-limit
 *  rewrites, the public gas cap it echoes, and a broken signature. */
export const INCONCLUSIVE_ESTIMATE = /BadWithdrawFrame|CostTooHigh|BadFrameCount|per-transaction gas cap|Invalid frame transaction signature|prefix gas budget exceeded/;
const ENDPOINT_DOWN = /RPC_UNREACHABLE|RPC_BAD_RESPONSE|-32601|Method not found/;

type NodeErr = { code: number | string; message: string; data?: unknown };

const rejected = (mempool: Mempool, source: OutcomeSource, file: string, err: NodeErr): Outcome => {
  const d = diagnoseError(err, mempool);
  return { mempool, source, file, admitted: false, rule: d.rule, detail: err.message };
};

/** `signed` says whether the tx the estimate stands for carries signatures: an estimate request is unsigned, so a VERIFY
 *  revert on it is the missing signature, not a verdict on the signed tx. */
export const extractOutcome = (c: Capture, o: { signed?: boolean } = {}): Extracted => {
  const { method } = c.request;
  const { result, error } = c.response;
  if (method === "eth_sendFrameTransaction") {
    if (error) return ENDPOINT_DOWN.test(`${error.code} ${error.message}`) ? { inconclusive: "endpoint not available" } : { outcome: rejected("alt", "sidecar-send", c.file, error) };
    return typeof result === "string" && /^0x[0-9a-f]{64}$/i.test(result)
      ? { outcome: { mempool: "alt", source: "sidecar-send", file: c.file, admitted: true } }
      : { inconclusive: "send returned no tx hash" };
  }
  if (method === "eth_sendRawTransaction") {
    if (!decodeRaw(c.request.params[0])) return { inconclusive: "not a frame transaction" };
    if (error) return { outcome: rejected("public", "ethrex-send", c.file, error) };
    return typeof result === "string" ? { outcome: { mempool: "public", source: "ethrex-send", file: c.file, admitted: true } } : { inconclusive: "send returned no tx hash" };
  }
  if (method === "eth_estimateFrameTransactionGas") {
    if (error) {
      if (ENDPOINT_DOWN.test(`${error.code} ${error.message}`)) return { inconclusive: "endpoint not available" };
      if (INCONCLUSIVE_ESTIMATE.test(error.message)) return { inconclusive: `estimator answer says nothing about the sidecar's rules (${error.message})` };
      if (o.signed && /validation frame \d+: reverted/.test(error.message)) return { inconclusive: "estimate ran the unsigned variant; a VERIFY revert there is the missing signature" };
      return { outcome: rejected("alt", "sidecar-estimate", c.file, error) };
    }
    return result?.frames ? { outcome: { mempool: "alt", source: "sidecar-estimate", file: c.file, admitted: true } } : { inconclusive: "estimate returned no frames" };
  }
  if (method === "skandha_explorer_getTransaction") {
    const a = result?.admission;
    if (!a) return { inconclusive: "no admission record" };
    const d = diagnoseAdmission(a);
    return { outcome: { mempool: "alt", source: "explorer-admission", file: c.file, admitted: !d, rule: d?.rule, detail: d?.detail } };
  }
  return { inconclusive: `${method} is not an outcome` };
};

// ---- case building ---------------------------------------------------------------------------------------------------

export interface Case {
  id: string;
  /** The pre-send input: a captured ethrex_simulateFrameTransaction call. */
  input: Capture;
  tx: FrameTx;
  txHash: Hex;
  outcomes: Outcome[];
}
export interface Excluded { files: string[]; reason: string }

const OUTCOME_METHODS = new Set(["eth_sendFrameTransaction", "eth_sendRawTransaction", "eth_estimateFrameTransactionGas", "skandha_explorer_getTransaction"]);
const SOURCE_ORDER: OutcomeSource[] = ["sidecar-send", "ethrex-send", "explorer-admission", "sidecar-estimate"];

export const buildCases = (captures: Capture[]): { cases: Case[]; excluded: Excluded[]; scanned: number } => {
  const excluded: Excluded[] = [];
  const key = new Map<string, { sims: Capture[]; outs: Capture[]; hashes: Set<string> }>();
  const grp = (k: string) => key.get(k) ?? (key.set(k, { sims: [], outs: [], hashes: new Set() }), key.get(k)!);
  const adm: Capture[] = [];
  const signed = new Map<string, boolean>();

  for (const c of captures) {
    const m = c.request.method;
    if (m === "ethrex_simulateFrameTransaction") {
      const raw = c.request.params[0];
      const tx = decodeRaw(raw);
      if (!tx) { excluded.push({ files: [c.file], reason: "simulate input is not a decodable frame tx" }); continue; }
      const id = identityOfRaw(raw)!;
      const g = grp(id);
      g.sims.push(c);
      g.hashes.add(hashTx(profile, tx));
      signed.set(id, tx.signatures.length > 0);
    }
  }
  for (const c of captures) {
    const m = c.request.method;
    if (!OUTCOME_METHODS.has(m)) continue;
    if (m === "skandha_explorer_getTransaction") { adm.push(c); continue; }
    const p0 = c.request.params[0];
    const id = m === "eth_sendRawTransaction" ? identityOfRaw(p0) : identityOfWire(p0);
    if (!id) { excluded.push({ files: [c.file], reason: `${m}: request is not a full frame tx` }); continue; }
    const g = grp(id);
    g.outs.push(c);
    if (m === "eth_sendRawTransaction") { const t = decodeRaw(p0); if (t) g.hashes.add(hashTx(profile, t)); }
    if (m === "eth_sendFrameTransaction" && typeof c.response.result === "string") g.hashes.add(c.response.result);
  }
  const byHash = new Map<string, string>();
  for (const [k, g] of key) for (const h of g.hashes) byHash.set(h.toLowerCase(), k);
  for (const c of adm) {
    const h = String(c.request.params[0]).toLowerCase();
    const k = byHash.get(h);
    if (k) key.get(k)!.outs.push(c);
    else grp(`hash:${h}`).outs.push(c);
  }

  const cases: Case[] = [];
  for (const [k, g] of key) {
    const extracted = g.outs.map((c) => ({ c, e: extractOutcome(c, { signed: signed.get(k) }) }));
    const usable = extracted.flatMap(({ e }) => ("outcome" in e ? [e.outcome] : []));
    if (!g.sims.length && usable.length) {
      excluded.push({ files: g.outs.map((c) => c.file), reason: "node outcome captured, but no pre-send ethrex_simulateFrameTransaction capture for this tx (the model has nothing to replay)" });
      continue;
    }
    for (const { c, e } of extracted) if ("inconclusive" in e) excluded.push({ files: [c.file], reason: `outcome unusable: ${e.inconclusive}` });
    if (!g.sims.length) continue;
    if (!usable.length) { excluded.push({ files: g.sims.map((c) => c.file), reason: "pre-send simulate captured, but no usable node outcome for this tx" }); continue; }
    usable.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
    const input = g.sims[0]!;
    const tx = decodeRaw(input.request.params[0])!;
    cases.push({ id: input.file, input, tx, txHash: hashTx(profile, tx), outcomes: usable });
    for (const s of g.sims.slice(1)) excluded.push({ files: [s.file], reason: "duplicate simulate capture of a tx already in the benchmark" });
  }
  return { cases, excluded, scanned: captures.length };
};

// ---- prediction ------------------------------------------------------------------------------------------------------

export interface Lookups {
  /** debug/explorer listReputation items: address, status, opsSeen, opsIncluded, stake, unstakeDelaySec, withdrawTime. */
  reputation: { address: string; status: string; opsSeen: number; opsIncluded: number; stake?: string; unstakeDelaySec?: number; withdrawTime?: string }[];
}

/** Captured pre-send stake and reputation lookups: the explorer's listReputation page (stake fields included). An address
 *  the page doesn't list reads as unstaked with no history. */
export const loadLookups = (captures: Capture[], inputFile?: string): Lookups => {
  // Live-suite captures are named `NN-caseCC-...`: a page captured for another case is a later state of the chain
  // (e.g. case 4 stakes the contract case 3 uses unstaked), so it is not a pre-send lookup for this case.
  const caseOf = (f: string) => f.match(/case\d+/)?.[0];
  const mine = inputFile && caseOf(inputFile);
  return {
    reputation: captures
      .filter((c) => c.request.method === "skandha_explorer_listReputation" && (!mine || !caseOf(c.file) || caseOf(c.file) === mine))
      .flatMap((c) => c.response.result?.items ?? []),
  };
};

const depositOf = (l: Lookups, address: string) => {
  const i = l.reputation.find((r) => r.address.toLowerCase() === address.toLowerCase());
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [BigInt(i?.stake ?? 0), BigInt(i?.unstakeDelaySec ?? 0), BigInt(i?.withdrawTime ?? 0)],
  );
};

/** The simulator with the node's admission record and the gateway estimator switched off: a prediction, never a lookup. */
export const predictionSimulator = (input: Capture, lookups: Lookups) =>
  createSimulator({
    explorer: false,
    estimate: false,
    ethrex: {
      url: "accuracy:replay",
      call: async (method: string, params: unknown[] = []) =>
        method === "eth_call" ? depositOf(lookups, `0x${String((params[0] as { data?: string } | undefined)?.data ?? "").slice(-40)}`) : null,
      simulateFrameTransaction: async () => {
        const e = input.response.error;
        if (e) throw Object.assign(new Error(e.message), e);
        return input.response.result;
      },
      sendRawTransaction: async () => { throw new Error("accuracy: no sends"); },
    },
    gateway: { listReputation: async () => ({ items: lookups.reputation }) } as unknown as ReturnType<typeof gateway>,
  });

export type Judgement = "match" | "mismatch";
export interface Comparison {
  mempool: Mempool;
  predicted: { verdict: "admitted" | "rejected"; rule?: string; source: string };
  actual: Outcome;
  judgement: Judgement;
  /** Why it differs. Undefined on a match. */
  reason?: string;
  /** The prediction came from our local rule model, not a node's answer. */
  unverified: boolean;
}
export interface CaseResult { id: string; txHash: Hex; input: string; comparisons: Comparison[] }

export const compare = (mempool: Mempool, predicted: Comparison["predicted"], actual: Outcome): Comparison => {
  const base = { mempool, predicted, actual, unverified: predicted.source === "model" };
  const pAdmit = predicted.verdict === "admitted";
  if (pAdmit !== actual.admitted)
    return { ...base, judgement: "mismatch", reason: pAdmit ? `predicted admit, node rejected (${actual.rule})` : `predicted reject (${predicted.rule}), node admitted` };
  if (!pAdmit && predicted.rule !== actual.rule)
    return { ...base, judgement: "mismatch", reason: `both reject, rule differs: predicted ${predicted.rule}, node ${actual.rule}` };
  return { ...base, judgement: "match" };
};

export const runCase = async (c: Case, lookups: Lookups): Promise<CaseResult> => {
  const report = await predictionSimulator(c.input, lookups).check(c.tx);
  const comparisons: Comparison[] = [];
  for (const mempool of ["public", "alt"] as const) {
    const actual = c.outcomes.find((o) => o.mempool === mempool);
    if (!actual) continue;
    const v = report.verdicts[mempool];
    comparisons.push(compare(mempool, { verdict: v.verdict, rule: v.failed?.rule, source: v.source }, actual));
  }
  return { id: c.id, txHash: c.txHash, input: c.input.file, comparisons };
};

export interface AccuracyReport {
  scanned: number;
  cases: CaseResult[];
  excluded: Excluded[];
  totals: { cases: number; comparisons: number; matched: number; mismatched: number; unverified: number; unverifiedMatched: number };
  byMempool: Record<Mempool, { compared: number; matched: number }>;
}

export const runAccuracy = async (captures: Capture[] = loadCaptures()): Promise<AccuracyReport> => {
  const { cases, excluded, scanned } = buildCases(captures);
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, loadLookups(captures, c.input.file)));
  const all = results.flatMap((r) => r.comparisons);
  const per = (m: Mempool) => { const x = all.filter((c) => c.mempool === m); return { compared: x.length, matched: x.filter((c) => c.judgement === "match").length }; };
  return {
    scanned, cases: results, excluded,
    totals: {
      cases: results.length, comparisons: all.length,
      matched: all.filter((c) => c.judgement === "match").length, mismatched: all.filter((c) => c.judgement === "mismatch").length,
      unverified: all.filter((c) => c.unverified).length, unverifiedMatched: all.filter((c) => c.unverified && c.judgement === "match").length,
    },
    byMempool: { public: per("public"), alt: per("alt") },
  };
};
