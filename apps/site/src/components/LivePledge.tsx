// Pledge Paid, live: the visitor's browser sends one real 9-frame payment on the public devnet and the page tracks it as
// it happens. No server in the flow (the heavy code, including the prover, loads on the first click).
// Mount it with <LivePledge entity={...} />, where entity is PayRelayWETH's live report (App polls it every 5 s).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { formatEther, formatUnits } from "viem";
import type { EntityReport } from "@altpool/monitor";
import { addrUrl, exitUrl } from "../altpool";
import type { FrameRow } from "../frames";
import { PAY_RELAY, type DoctorView, type Live } from "../live";
import { deployments } from "@altpool/contracts";
import type { Address } from "viem";
import { freshKeyFunder, fundKeyFunder } from "../liveExit/funding";
import { DEFAULT_FG, freshAddress, validate, type Raw } from "../livePledge/inputs";
import { LifecyclePanel, secs, StepRow } from "../livePledge/parts";
import { plannedRows } from "../livePledge/plan";
import { expectsRevert, PAY, presetOf, type Intent, type PresetId } from "../livePledge/presets";
import { quote, type Quote } from "../livePledge/quote";
import type { Ui } from "../livePledge/run";
import { blankSteps, STEPS, type ChainTx, type Lifecycle, type RunResult, type Steps } from "../livePledge/steps";
import { GatePanel, PresetBar, RecoverPanel, usePaidInvoice, type GateState } from "../livePledge/revert";
import { recentRuns, setCurrentRun, setLastSent, useCurrentRun, type CurrentRun } from "../pledge";
import { openInDoctor } from "./doctor/follow";
import { GapStory } from "./doctor/Gap";
import { Crowd } from "./Crowd";
import { FrameDetail } from "./frames/FrameDetail";
import { FrameRail } from "./frames/FrameRail";
import { FrameLegend } from "./frames/Legend";
import { PledgeFrames } from "./frames/PledgeFrames";
import { Card, CardBar, cx, Dot, ExtLink, fmt, Pill, Section, short, valueOf } from "./ui";

/** Fewer sends than this before PayRelayWETH is throttled and the button stays off: one run adds one send. */
const MIN_HEADROOM = 5;
const QUOTE_POLL_MS = 15_000;
const WETH_POOL = deployments.wethPool as Address;

/** One run at a time per page, however many panels are mounted. */
let busy = false;

const blockReason = (relay: Live<EntityReport>): string | undefined => {
  if (relay.status === "loading") return "Checking PayRelayWETH's reputation headroom…";
  const r = valueOf(relay);
  if (!r) return undefined;
  if (!r.stake.isStaked) return "PayRelayWETH is not staked, so the alt mempool would not admit its payments.";
  if (r.reputation.status !== "ok") return `PayRelayWETH is ${r.reputation.status} on the miner's sidecar: it admits no new payments until the reputation recovers.`;
  if (r.headroom.untilThrottled < MIN_HEADROOM) return `PayRelayWETH has ${r.headroom.untilThrottled} sends left before the sidecar throttles it (seen ${r.reputation.opsSeen}, included ${r.reputation.opsIncluded}). Try again once inclusions catch up.`;
  return undefined;
};

/** The fresh v4 quote for the amount typed, re-read when it changes and every 15 s while idle. */
const useQuote = (amount: bigint | undefined, active: boolean) => {
  const [state, setState] = useState<Live<Quote>>({ status: "loading" });
  useEffect(() => {
    if (amount === undefined || !active) return;
    let alive = true;
    const load = () => quote(amount).then(
      (value) => alive && setState({ status: "live", value, at: new Date() }),
      (e) => alive && setState({ status: "error", error: e instanceof Error ? e.message : String(e) }),
    );
    setState({ status: "loading" });
    const first = setTimeout(load, 400);
    const id = setInterval(load, QUOTE_POLL_MS);
    return () => { alive = false; clearTimeout(first); clearInterval(id); };
  }, [amount, active]);
  return state;
};

const inputCls = "w-full rounded-lg border border-ln2 bg-bg px-3 py-2.5 font-mono text-[13px] text-fg placeholder:text-dim disabled:opacity-50";

const Field = ({ id, label, hint, error, children }: { id: string; label: string; hint: string; error?: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <label htmlFor={id} className="text-[13px] text-fg">{label}</label>
    {children}
    <p id={`${id}-hint`} className={cx("m-0 text-[12.5px]", error ? "text-bad" : "text-fg2")} role={error ? "alert" : undefined}>{error ?? hint}</p>
  </div>
);


const NOTES: [string, string][] = [
  ["Why frames", "A staked relay checks a zero-knowledge proof and pays the gas in the same transaction that withdraws. The later steps then run as one atomic batch. The transaction carries no signature, and no wallet of the donor's pays its gas."],
  ["Why the alt mempool", "PayRelayWETH's VERIFY frame runs a Groth16 check that needs far more than the public mempool's 100k validation cap, and it reads the pool's storage. The alt mempool admits it because the relay is staked (ERC-8421 STORAGE-032) and has no hard validation cap. The later frames need no extra mempool rule."],
  ["How the SDK sends it", "Build the frames with the Altpool SDK, then simulate them. The sidecar admits a transaction that will revert (finding 9), so the simulation is your check. Then call submitFrameTransaction. The tracker below polls getTransactionStatus and getFrameTransactionReceipt."],
];

const Notes = () => (
  <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-8 gap-y-6">
    {NOTES.map(([k, t]) => (
      <div key={k} className="flex flex-col gap-1.5"><h3 className="m-0 text-[14px] font-medium text-fg">{k}</h3><p className="m-0 text-[14px]/[22px] text-fg2">{t}</p></div>
    ))}
  </div>
);

const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div><dt className="text-[12px] text-fg2">{k}</dt><dd className="m-0 mt-0.5 font-mono text-[18px] text-fg tabular-nums">{children}</dd></div>
);

/** Pledge Paid payments PayRelayWETH paid for, read from its live report. Pick one to read its frames from the chain. */
const RecentRuns = ({ entity }: { entity: Live<EntityReport> }) => {
  const [open, setOpen] = useState<Hex>();
  const runs = recentRuns(valueOf(entity)).slice(0, 8);
  return (
    <Card>
      <CardBar>
        <span>recent runs on chain</span>
        <span className="flex items-center gap-2"><Dot state={entity.status === "live" ? "live" : entity.status === "error" ? "err" : undefined} size="sm" />from PayRelayWETH's own report</span>
      </CardBar>
      <div className="flex flex-col gap-3 p-5 max-[560px]:p-4">
        {runs.length === 0 && <p className="m-0 text-[14px] text-fg2">{entity.status === "loading" ? "Reading PayRelayWETH's report…" : "PayRelayWETH has no payments on record yet. Send the first one."}</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {runs.map((r) => (
            <li key={r.hash} className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12.5px]">
              <Pill kind={r.outcome === "included" ? "v" : "u"}>{r.outcome === "included" ? `included${r.block ? `, block ${fmt(r.block)}` : ""}` : "reverted on chain"}</Pill>
              <ExtLink href={exitUrl(r.hash)} className="text-amber tabular-nums underline decoration-amberln underline-offset-4">{short(r.hash)}</ExtLink>
              <button type="button" aria-pressed={open === r.hash} onClick={() => setOpen(open === r.hash ? undefined : r.hash)}
                className="ml-auto cursor-pointer rounded-md border border-ln2 px-3 py-1.5 text-[12px] text-fg1 hover:border-amberln hover:text-amber aria-pressed:border-amberln aria-pressed:text-amber">
                {open === r.hash ? "Hide its frames" : "Read its frames"}
              </button>
            </li>
          ))}
        </ul>
        {open && <PledgeFrames key={open} hash={open} />}
      </div>
    </Card>
  );
};

/** A failing step shows its own error. An error before any step (a chunk that did not load) goes on the first one. */
const failedBeforeSteps = (st: Steps, e: unknown): Steps =>
  Object.values(st).some((x) => x.status === "error") ? st : { ...st, keys: { ...st.keys, status: "error", error: e instanceof Error ? e.message : String(e) } };

export const LivePledge = ({ entity }: { entity: Live<EntityReport> }) => {
  const fund = useMemo(fundKeyFunder, []);
  const [defaults, setDefaults] = useState(() => ({ payee: freshAddress(), change: freshAddress() }));
  const [raw, setRaw] = useState<Raw>({ amount: DEFAULT_FG, ...defaults });
  const [steps, setSteps] = useState<Steps>(blankSteps);
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [lc, setLc] = useState<Lifecycle>();
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [result, setResult] = useState<RunResult>();
  const [rows, setRows] = useState<FrameRow[]>(() => plannedRows());
  const [sel, setSel] = useState(0);
  const [included, setIncluded] = useState<Hex>();
  const [now, setNow] = useState(() => Date.now());
  const [intent, setIntent] = useState<Intent>(PAY);
  const [gate, setGate] = useState<GateState>();
  const [story, setStory] = useState<{ view?: DoctorView; sent?: Hex }>();
  const [myLeaf, setMyLeaf] = useState<number>();
  const paid = usePaidInvoice(phase);
  const cur = useCurrentRun();
  const run = useRef<CurrentRun | undefined>(undefined);
  const publish = (patch: Partial<CurrentRun>, replace = false) => {
    run.current = { ...(replace ? undefined : run.current), ...patch } as CurrentRun;
    setCurrentRun(run.current);
  };
  const pick = (id: PresetId) => {
    const inv = paid.status === "live" ? paid.value : paid.status === "error" ? paid.snapshot : undefined;
    const next: Intent = id === "pay" ? PAY : id === "paid" ? { id, invoice: inv, lowMaxIn: false } : { id, lowMaxIn: true };
    setIntent(next);
    setRaw(next.invoice
      ? { amount: formatUnits(next.invoice.amount, 6), payee: next.invoice.payee, change: defaults.change }
      : { amount: DEFAULT_FG, payee: defaults.payee, change: defaults.change });
    publish({ preset: presetOf(next).label, expectRevert: expectsRevert(next) }, true);
  };

  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [phase]);

  const txCard = useRef<HTMLDivElement>(null);
  const gateCard = useRef<HTMLDivElement>(null);
  const followed = useRef(false);
  useEffect(() => {
    if (phase === "running" && lc && !followed.current) {
      followed.current = true;
      txCard.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }
    if (phase === "idle") followed.current = false;
  }, [phase, lc]);

  const checked = validate(raw);
  const errors = checked.ok ? {} : checked.errors;
  const q = useQuote(checked.ok ? checked.value.amount : undefined, phase !== "running");

  const start = async () => {
    if (busy || !checked.ok) return;
    if (intent.id === "paid" && !intent.invoice) return;
    busy = true;
    const inputs = checked.value;
    const labels = { payee: intent.invoice ? "the paid invoice's payee" : raw.payee === defaults.payee ? "demo fund" : "your address", change: raw.change === defaults.change ? "fresh address" : "your address" };
    followed.current = false;
    setPhase("running");
    setSteps(blankSteps());
    setTxs([]);
    setLc(undefined);
    setResult(undefined);
    setIncluded(undefined);
    setSel(0);
    setGate(undefined);
    setStory(undefined);
    setMyLeaf(undefined);
    publish({ preset: presetOf(intent).label, expectRevert: expectsRevert(intent), raw: undefined, hash: undefined }, true);
    const ui: Ui = {
      onChange: setSteps, onPlan: setRows, onTxs: setTxs, onLifecycle: setLc, onIncluded: setIncluded, onLeaf: setMyLeaf,
      onSent: (h) => { setLastSent(h); publish({ hash: h }); setStory((st) => st && { ...st, sent: h }); },
      onBuilt: (raw, i) => publish({ preset: i.id === "pay" && intent.id !== "pay" ? `${presetOf(intent).label}, after the fix` : presetOf(i).label, expectRevert: expectsRevert(i), raw, hash: undefined }),
      onIntent: setIntent,
      onGate: (g) => new Promise((resolve) => { setStory({ view: g.view }); setGate({ gate: g, resolve }); }),
    };
    try {
      const { runLivePledge } = await import("../livePledge/run");
      setResult(await runLivePledge(inputs, labels, intent, ui, freshKeyFunder("Fresh depositor key")));
      setPhase("done");
    } catch (e) {
      setSteps((st) => failedBeforeSteps(st, e));
      setPhase("failed");
    } finally {
      busy = false;
      // The run spent the fresh defaults; offer new ones unless the visitor typed their own.
      const next = { payee: freshAddress(), change: freshAddress() };
      setRaw((r) => ({ ...r, payee: r.payee === defaults.payee ? next.payee : r.payee, change: r.change === defaults.change ? next.change : r.change }));
      setDefaults(next);
    }
  };

  const choose = (d: "send" | "fix" | "stop") => {
    gate?.resolve(d);
    setGate(undefined);
    if (d !== "send") setStory(undefined);
  };
  useEffect(() => { if (gate) gateCard.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); }, [gate]);

  const running = phase === "running";
  const reason = running ? "A run is in progress. One at a time." : !checked.ok ? "Fix the highlighted input first." : blockReason(entity);
  const r = valueOf(entity);
  const quoted = q.status === "live" ? q.value : undefined;
  const started = phase !== "idle";
  const frameTx = txs.find((t) => t.step === "submit");

  return (
    <Section id="pledge" band>
      <div className="flex max-w-[760px] flex-col gap-5">
        <h2 className="m-0 text-[clamp(32px,4.5vw,48px)]/[1.1] font-light tracking-[-.03em] text-balance">Pay an invoice from shielded funds, in one transaction. Send it yourself.</h2>
        <p className="m-0 text-fg2">
          A donor holds a 0.1 WETH note in the privacy pool and owes an aid fund's invoice. One frame transaction withdraws the note, unwraps it, swaps on Uniswap v4, pays the invoice, returns the change and checks that nothing is left. The staked PayRelayWETH contract sends it and pays the gas, so the donor needs no ETH and no relayer. Below, your browser sends that transaction on the devnet with your amount and addresses, and the page reads each value back from the chain.
        </p>
      </div>

      <Notes />

      <div className="m-0 flex max-w-[760px] flex-col gap-2 rounded-xl border border-warnln bg-warnbg px-5 py-4 text-[14px] text-fg1">
        <p className="m-0"><span className="font-medium text-warn">Pledge Paid is designed to unlink a payment from its deposit. This demo shows the mechanism, not privacy.</span> The run deposits and pays from this tab one to three minutes apart, so timing links the two. The deposits around yours come mostly from a crowd of accounts we run on this devnet. Anyone who knows those addresses can set them aside, and your note is then nearly alone. The invoice amount and the change are public. One host serves the RPC, the faucet and the sidecar, so its operator sees your IP on the deposit and on the payment.</p>
        <p className="m-0">What the run does about it. A fresh key makes your deposit. The run then waits up to 90 s for two later deposits and proves against a root that holds them, so your note is not the newest leaf. If none come, the run says so and proves anyway. The depositor signs nothing after its deposit. The fund key {short(fund.address)} creates the invoice, and a fresh key signs any rescue.</p>
      </div>

      <Crowd pool={WETH_POOL} myLeafIndex={myLeaf} />

      <PresetBar intent={intent} paid={paid} disabled={running} onPick={pick} />

      <Card>
        <CardBar><span>invoice</span><span>devnet demo, fgUSD is a test token</span></CardBar>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-6 gap-y-5 p-5 max-[560px]:p-4">
          <Field id="pp-amount" label="Invoice amount (fgUSD)" hint={intent.invoice ? `Set by invoice #${intent.invoice.id}, which fixes its amount.` : "1 to 50. The swap must fit the pool's ~1 ETH of liquidity."} error={errors.amount}>
            <input id="pp-amount" className={inputCls} inputMode="decimal" value={raw.amount} disabled={running || !!intent.invoice} aria-describedby="pp-amount-hint" aria-invalid={!!errors.amount}
              onChange={(e) => setRaw({ ...raw, amount: e.target.value })} />
          </Field>
          <Field id="pp-payee" label="Receiving address (invoice payee)" hint={intent.invoice ? `Set by invoice #${intent.invoice.id}: its payee.` : raw.payee === defaults.payee ? "Default: a fresh address for the demo fund. Its key is discarded." : "Receives the fgUSD."} error={errors.payee}>
            <input id="pp-payee" className={inputCls} spellCheck={false} value={raw.payee} disabled={running || !!intent.invoice} aria-describedby="pp-payee-hint" aria-invalid={!!errors.payee}
              onChange={(e) => setRaw({ ...raw, payee: e.target.value })} />
          </Field>
          <Field id="pp-change" label="Change address" hint={raw.change === defaults.change ? "Default: a fresh address whose key is discarded, so the change cannot be spent. Paste your own to keep it." : "Receives the ETH left after the swap."} error={errors.change}>
            <input id="pp-change" className={inputCls} spellCheck={false} value={raw.change} disabled={running} aria-describedby="pp-change-hint" aria-invalid={!!errors.change}
              onChange={(e) => setRaw({ ...raw, change: e.target.value })} />
          </Field>
        </div>
        <p aria-live="polite" className="m-0 border-t border-ln px-5 py-3 font-mono text-[12.5px] text-fg2 max-[560px]:px-4">
          {!checked.ok ? "No quote until the inputs are valid."
            : quoted ? <>fresh v4 quote <span className="text-fg">{formatEther(quoted.amountIn)} ETH in, {formatUnits(checked.value.amount, 6)} fgUSD out</span>, {intent.lowMaxIn
              ? <>maxIn <span className="text-warn">{formatEther(quoted.maxIn / 2n)} ETH, half the quote on purpose</span></>
              : <>maxIn {formatEther(quoted.maxIn)} ETH (+3%)</>} at {quoted.at.toLocaleTimeString()}</>
            : q.status === "error" ? <span className="text-bad">{q.error}</span> : "Quoting…"}
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <button
          onClick={start}
          disabled={running || reason !== undefined}
          aria-describedby="live-pledge-reason"
          className="min-h-11 rounded-full bg-fg px-7 text-[15px] font-medium text-[#0a0a0c] disabled:cursor-not-allowed disabled:opacity-40"
        >{running ? (gate ? "Waiting for your choice…" : "Working…") : expectsRevert(intent) ? "Build it and check it" : phase === "idle" ? "Send a Pledge Paid" : "Send another Pledge Paid"}</button>
        {(cur?.raw || cur?.hash) && <button type="button" onClick={openInDoctor} className="min-h-11 rounded-full border border-ln2 px-5 text-[14px] text-fg1">Open in frame-doctor</button>}
        <p id="live-pledge-reason" role="status" className="m-0 max-w-[620px] text-[13px] text-fg2">
          {reason ?? (expectsRevert(intent)
            ? "Uses devnet ETH. The run builds and simulates the payment, then stops before the send so you can compare the verdicts and choose."
            : "Uses devnet ETH and takes one to three minutes. The run does not send if its simulation predicts a revert.")}
        </p>
      </div>

      {started && (
        <Card>
          <CardBar windowDots>
            <span>this run, step by step</span>
            <span className="flex items-center gap-2">
              <Dot state={phase === "done" ? "live" : phase === "failed" ? "err" : undefined} size="sm" />
              <span>{running ? (gate ? "waiting for you" : "running") : phase === "done" ? (result?.reverted ? "rolled back" : "landed") : "failed"}</span>
            </span>
          </CardBar>
          <ol className="m-0 list-none p-0">
            {STEPS.map((def) => <StepRow key={def.id} title={def.title} sub={def.sub} s={steps[def.id]} txs={txs.filter((t) => t.step === def.id)} now={now} />)}
          </ol>
        </Card>
      )}

      {(gate || story) && (
        <div ref={gateCard} className="scroll-mt-24">
          {gate ? <GatePanel g={gate} onChoose={choose} /> : <GapStory view={story?.view} sent={story?.sent} preset={presetOf(intent).label} />}
        </div>
      )}

      {result?.reverted && (
        <Card>
          <div className="flex flex-col gap-4 p-6 max-[560px]:p-4">
            <p className="m-0 font-serif text-[40px]/[1.1] text-fg">Rolled back.</p>
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-6 gap-y-4">
              <Fact k="Frame that failed">{result.reverted.frame} ({result.reverted.status})</Fact>
              <Fact k="Block">{fmt(result.block)}</Fact>
              <Fact k="Whole run">{secs(result.totalMs)}</Fact>
            </dl>
            <ExtLink href={exitUrl(result.hash)} className="font-mono text-[13px] text-amber underline decoration-amberln underline-offset-4">{short(result.hash)} on the explorer, miner's view</ExtLink>
          </div>
          <div className="border-t border-ln"><RecoverPanel rescue={result.rescue} now={now} /></div>
        </Card>
      )}

      {result && !result.reverted && (
        <Card>
          <div className="flex flex-col gap-4 p-6 max-[560px]:p-4">
            <p className="m-0 font-serif text-[40px]/[1.1] text-fg">Pledge paid.</p>
            <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-6 gap-y-4">
              <Fact k="Frames that succeeded">{result.frames} of 9</Fact>
              <Fact k="Block">{fmt(result.block)}</Fact>
              <Fact k="Gas used">{result.gasUsed === undefined ? "not reported" : fmt(result.gasUsed)}</Fact>
              <Fact k="Your leaf in the proof's root">{fmt(result.anonymity.leaf)} of 0 to {fmt(result.anonymity.leaves - 1)}</Fact>
              <Fact k="Deposits after yours in the root">{fmt(result.anonymity.after)}</Fact>
              <Fact k="Unspent notes in the root (upper bound)">{fmt(result.anonymity.set)}</Fact>
              <Fact k="Whole run">{secs(result.totalMs)}</Fact>
            </dl>
            <p className="m-0 max-w-[760px] text-[14px]/[22px] text-fg2">
              Your note is 1 of {fmt(result.anonymity.leaves)} notes in the root the proof used, and {fmt(result.anonymity.after)} deposited after yours.{" "}
              {result.anonymity.after >= 2 ? "Most of them come from the crowd we run, so the limits above apply." : "Fewer than two deposits landed after yours, so the root and the timing point at your note."}
            </p>
            <ExtLink href={exitUrl(result.hash)} className="font-mono text-[13px] text-amber underline decoration-amberln underline-offset-4">{short(result.hash)} on the explorer, miner's view</ExtLink>
          </div>
        </Card>
      )}

      <div ref={txCard} className="scroll-mt-24"><Card>
        <CardBar>
          <span>the nine frames</span>
          <span>{included ? "included, read back from the chain" : frameTx ? "sent, waiting for inclusion" : running ? "planned, not sent yet" : "planned"}</span>
        </CardBar>
        <div className="flex flex-col gap-5 p-5 max-[560px]:p-4">
          {lc && <LifecyclePanel lc={lc} now={now} />}
          {included
            ? <PledgeFrames hash={included} />
            : (
              <div className="flex flex-col gap-4">
                <FrameRail rows={rows} states={rows.map(() => "pending" as const)} selected={sel} onSelect={setSel} />
                <FrameDetail row={rows[sel]!} rows={rows} state="pending" />
              </div>
            )}
          <details open className="group rounded-lg border border-ln p-4">
            <summary className="cursor-pointer text-[14px] text-fg">How to read the frames</summary>
            <div className="mt-4"><FrameLegend /></div>
          </details>
        </div>
      </Card></div>

      <RecentRuns entity={entity} />

      <p className="m-0 font-mono text-[12px] text-fg2">
        {r
          ? `PayRelayWETH ${short(PAY_RELAY)} · ${r.stake.isStaked ? `staked ${formatEther(r.stake.amount)} ETH` : "unstaked"} · reputation ${r.reputation.status} · ${r.headroom.untilThrottled} sends until throttled${entity.status === "error" ? " · stale, refresh failed" : ""}`
          : entity.status === "error" ? `PayRelayWETH's headroom could not be read: ${entity.error}` : "Reading PayRelayWETH's headroom…"}
        {" · "}<ExtLink href={addrUrl(fund.address)} className="underline decoration-ln2 underline-offset-4">{fund.label.toLowerCase()} {short(fund.address)}, creates the invoices</ExtLink>
      </p>
    </Section>
  );
};
