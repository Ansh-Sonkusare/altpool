// One transaction followed through the five tools. The run is the sender's in-progress run when there is one,
// otherwise the newest Pledge Paid on chain. Everything below is read live; nothing here is a stored sample.
import { useEffect, useRef, useState } from "react";
import type { EntityReport } from "@altpool/monitor";
import { summarize, renderReport } from "@altpool/simulator";
import type { AdmissionReport } from "@altpool/core";
import type { Hex } from "viem";
import { client } from "../../altpool";
import { doctorHash, PAY_RELAY, runRawTx, type DoctorResult, type Live } from "../../live";
import { recentRuns, useCurrentRun } from "../../pledge";
import { valueOf } from "../ui";

export type Stage = "idle" | "running" | "done" | "failed";
export const STAGE_WORD: Record<Stage, string> = { idle: "idle", running: "running", done: "done", failed: "failed" };

export interface Target {
  origin: "yours" | "chain";
  preset?: string;
  expectRevert: boolean;
  raw?: Hex;
  hash?: Hex;
  block?: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

// A check is computed once per input and shared by the pipeline, the checkAdmission tab and the MCP transcript.
const cache = new Map<string, Promise<DoctorResult>>();
export type Async<T> = { status: "idle" } | { status: "running" } | { status: "done"; value: T } | { status: "error"; error: string };

export const useCheck = (key: string | undefined, make: () => Promise<DoctorResult>): Async<DoctorResult> => {
  const [s, setS] = useState<{ key?: string; value?: DoctorResult; error?: string }>({});
  const makeRef = useRef(make);
  makeRef.current = make;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    let p = cache.get(key);
    if (!p) { p = makeRef.current(); cache.set(key, p); }
    p.then((value) => alive && setS({ key, value }), (e) => { cache.delete(key); if (alive) setS({ key, error: msg(e) }); });
    return () => { alive = false; };
  }, [key]);
  if (!key) return { status: "idle" };
  if (s.key !== key) return { status: "running" };
  return s.value ? { status: "done", value: s.value } : { status: "error", error: s.error ?? "failed" };
};

export const checkKey = (t: Target | undefined) => (t?.raw ? `raw:${t.raw}` : t?.hash ? `hash:${t.hash}` : undefined);
export const checkMaker = (t: Target | undefined) => () => (t?.raw ? runRawTx(t.raw) : doctorHash(t!.hash!));

/** The node simulation reverts while the alt model admits: the gap frame-doctor explains. */
export const gapOf = (r: DoctorResult | undefined) => {
  const v = r?.view;
  if (!v?.alt || !v.public || v.alt.verdict !== "admitted") return undefined;
  const bad = v.frames?.rows.find((f) => f.state === "failed");
  if (bad) return { frame: bad.index, why: bad.note ?? "frame failed in the node simulation" };
  if (v.public.verdict === "rejected" && v.public.failed?.rule === "simulation") return { frame: v.public.failed.frameIndex, why: v.public.error?.revertReason ?? v.public.error?.message ?? "the node simulation reverts" };
  return undefined;
};

// ---------------------------------------------------------------- the entity feed

export interface FeedEvent { id: string; kind: "inclusion" | "eviction" | "rejection" | "pending"; hash: Hex; detail: string; at?: Date; earlier?: boolean }
const lc = (h: string) => h.toLowerCase();

/** Diffs consecutive reports the way watchEntity's onInclusion / onRejection / onEviction do: the first report is the baseline. */
export const useFeed = (report: EntityReport | undefined): FeedEvent[] => {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const prev = useRef<EntityReport>(undefined);
  useEffect(() => {
    if (!report || report === prev.current) return;
    const before = prev.current;
    prev.current = report;
    if (!before) {
      setEvents(report.inclusions.slice(0, 3).map((i) => ({ id: `b${i.hash}`, kind: "inclusion", hash: i.hash, earlier: true, detail: `block ${i.block}${i.verifyGas !== undefined ? `, VERIFY gas ${i.verifyGas.toLocaleString("en-US")}` : ""}` })));
      return;
    }
    const had = (xs: { hash: string }[]) => new Set(xs.map((x) => lc(x.hash)));
    const [inc, rej, ev, pen] = [had(before.inclusions), had(before.rejections), had(before.evictions), had(before.pending)];
    const at = new Date();
    const add: FeedEvent[] = [
      ...report.pending.filter((p) => !pen.has(lc(p.hash))).map((p): FeedEvent => ({ id: `p${p.hash}`, kind: "pending", hash: p.hash, at, detail: `${p.role} ${p.status}` })),
      ...report.inclusions.filter((i) => !inc.has(lc(i.hash))).map((i): FeedEvent => ({ id: `i${i.hash}`, kind: "inclusion", hash: i.hash, at, detail: `block ${i.block}${i.verifyGas !== undefined ? `, VERIFY gas ${i.verifyGas.toLocaleString("en-US")}` : ""}` })),
      ...report.rejections.filter((r) => !rej.has(lc(r.hash))).map((r): FeedEvent => ({ id: `r${r.hash}`, kind: "rejection", hash: r.hash, at, detail: r.failed ? `failed ${r.failed.rule}` : "rejected" })),
      ...report.evictions.filter((e) => !ev.has(lc(e.hash))).map((e): FeedEvent => ({ id: `e${e.hash}`, kind: "eviction", hash: e.hash, at, detail: `${e.kind}${e.reason ? `: ${e.reason}` : ""}` })),
    ];
    if (add.length) setEvents((old) => [...add, ...old].slice(0, 30));
  }, [report]);
  return events;
};

// ---------------------------------------------------------------- the MCP tools' text, from the same functions

const staked = (s: EntityReport) =>
  `${s.address}: ${s.stake.isStaked ? "staked" : "NOT staked"} (${s.stake.amount} wei, unstake delay ${s.stake.unstakeDelaySec}s); reputation ${s.reputation.status} (seen ${s.reputation.opsSeen}, included ${s.reputation.opsIncluded}); headroom ${s.headroom.untilThrottled} until throttled, ${s.headroom.untilBanned} until banned; ${s.pending.length} pending, ${s.inclusions.length} recent inclusions.`;

export interface McpCall { tool: "check_admission" | "get_admission_report" | "entity_status"; args: string; status: Async<{ text: string; json: string }> }

const useAdmissionRecord = (hash: Hex | undefined, included: boolean): Async<{ text: string; json: string }> => {
  const [s, setS] = useState<{ key?: string; value?: { text: string; json: string }; error?: string }>({});
  const key = hash && `${hash}:${included}`;
  useEffect(() => {
    if (!hash) return;
    let alive = true;
    client.altpool.getAdmissionReport({ hash }).then(
      (r) => {
        if (!alive) return;
        if (!r) return setS({ key, value: { text: `No record of ${hash} on the miner node; try the gateway node (admission records are node-local and in memory).`, json: "null" } });
        const failed = r.failed.length ? ` failed: ${r.failed.map((c) => c.rule).join(", ")}.` : "";
        setS({ key, value: { text: `miner node: outcome ${r.outcome}, ${r.checks.length} checks.${failed}${r.explanation?.fix ? ` Fix: ${r.explanation.fix}` : ""}`, json: toJson(r) } });
      },
      (e) => alive && setS({ key, error: `Could not read the admission record: ${msg(e)}\nFix: Check the node is reachable, or retry with the other node.` }),
    );
    return () => { alive = false; };
  }, [hash, included]);
  if (!hash) return { status: "idle" };
  if (s.key !== key) return { status: "running" };
  return s.value ? { status: "done", value: s.value } : { status: "error", error: s.error! };
};

// ---------------------------------------------------------------- the pipeline

export interface Pipeline {
  target?: Target;
  check: Async<DoctorResult>;
  gap?: ReturnType<typeof gapOf>;
  mcp: McpCall[];
  feed: FeedEvent[];
  stages: Record<"build" | "check" | "explain" | "watch" | "ask", { stage: Stage; note: string }>;
  report?: EntityReport;
}

const rank = (a: Async<unknown>[]): Stage => (a.some((x) => x.status === "error") ? "failed" : a.some((x) => x.status === "running") ? "running" : a.length && a.every((x) => x.status === "done") ? "done" : "idle");

export const usePipeline = (entity: Live<EntityReport>): Pipeline => {
  const cur = useCurrentRun();
  const report = valueOf(entity);
  const newest = recentRuns(report)[0];
  const target: Target | undefined = cur
    ? { origin: "yours", preset: cur.preset, expectRevert: cur.expectRevert, raw: cur.raw, hash: cur.hash }
    : newest ? { origin: "chain", hash: newest.hash, block: newest.block, expectRevert: newest.outcome === "reverted" } : undefined;

  const key = checkKey(target);
  const check = useCheck(key, checkMaker(target));
  const feed = useFeed(report);
  const gap = check.status === "done" ? gapOf(check.value) : undefined;

  const h = target?.hash && lc(target.hash);
  const included = !!h && !!report?.inclusions.some((i) => lc(i.hash) === h);
  const lost = !!h && !!(report?.evictions.some((e) => lc(e.hash) === h) || report?.rejections.some((r) => lc(r.hash) === h));
  const record = useAdmissionRecord(target?.hash, included);
  const entityCall: Async<{ text: string; json: string }> = report ? { status: "done", value: { text: staked(report), json: toJson(report) } } : { status: "running" };

  const mcp: McpCall[] = [];
  if (target?.raw) {
    const r = check.status === "done" ? check.value.view : undefined;
    const rep: AdmissionReport | undefined = r?.public && r.alt ? { txHash: r.txHash, verdicts: { public: r.public, alt: r.alt }, verifyGas: r.verifyGas } : undefined;
    mcp.push({
      tool: "check_admission", args: `{ "raw": "${target.raw.slice(0, 10)}…${target.raw.slice(-6)}" }`,
      status: check.status === "done" ? (rep ? { status: "done", value: { text: `${summarize(rep)}\n${renderReport(rep, { verbose: true })}`, json: toJson(rep) } } : { status: "error", error: "The check returned no verdicts." }) : check.status === "error" ? { status: "error", error: check.error } : { status: "running" },
    });
  }
  if (target?.hash) mcp.push({ tool: "get_admission_report", args: `{ "hash": "${target.hash}" }`, status: record });
  if (target) mcp.push({ tool: "entity_status", args: `{ "address": "${PAY_RELAY}" }`, status: entityCall });

  const done = check.status === "done" ? check.value : undefined;
  const bad = done && (done.view.alt?.verdict === "rejected" || !!gap || target?.expectRevert && target.origin === "chain");
  const stages: Pipeline["stages"] = {
    build: !target ? { stage: "idle", note: "nothing built yet" } : cur && !cur.raw && !cur.hash ? { stage: "running", note: "building the 9 frames" } : { stage: "done", note: cur ? (cur.hash ? "built and sent" : "built, not sent") : "built earlier" },
    check: !target ? { stage: "idle", note: "waiting for a run" } : check.status === "error" ? { stage: "failed", note: "check did not run" } : check.status !== "done" ? { stage: "running", note: "asking both mempools" } : bad ? { stage: "failed", note: gap ? "admitted, but reverts" : target?.expectRevert && target.origin === "chain" ? "admitted, then reverted" : "rejected" } : { stage: "done", note: done!.view.alt?.verdict === "admitted" ? "alt admits" : "checked" },
    explain: !target ? { stage: "idle", note: "waiting for a run" } : check.status === "error" ? { stage: "failed", note: "nothing to explain" } : check.status !== "done" ? { stage: "running", note: "reading the rules" } : { stage: "done", note: bad ? "failing rule named" : "nothing to fix" },
    watch: !target?.hash ? { stage: "idle", note: target ? "not sent yet" : "waiting for a run" } : !report ? { stage: "running", note: "connecting" } : included ? { stage: "done", note: "seen included" } : lost ? { stage: "failed", note: "dropped or reverted" } : { stage: "running", note: "waiting for inclusion" },
    ask: !target ? { stage: "idle", note: "waiting for a run" } : { stage: rank(mcp.map((m) => m.status)), note: `${mcp.length} tool call${mcp.length === 1 ? "" : "s"}` },
  };
  return { target, check, gap, mcp, feed, stages, report };
};
