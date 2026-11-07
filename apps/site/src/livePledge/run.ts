// One live Pledge Paid, end to end in the browser: fresh depositor key -> faucet -> wrap+deposit (WETH pool) -> tree
// -> invoice (fund key) + quote -> Settler address -> proof -> 9 frames -> simulate -> checkAdmission -> miner sidecar
// -> receipt -> outcome. The depositor signs nothing after its deposit; the nine-frame payment carries no signature.
import "../liveExit/shim";
import { renderReport } from "@altpool/simulator";
import { formatEther, formatUnits, isAddressEqual, parseAbi, parseAbiItem, parseEther, parseEventLogs, type Address, type Hex } from "viem";
import { EXIT_FEE, WETH9, deployments, invoiceBookAbi, payTx, settlerAbi, settlerAddress, settlerFactoryAbi, wethAbi, type Terms } from "@altpool/contracts";
import { DEVNET, type Note } from "@altpool/core";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { addrUrl, client, profile } from "../altpool";
import type { DoctorView } from "../live";
import { PAY_RELAY, pledgeSimulator, runPledgeTx } from "../live";
import { fundKeyFunder, wrapAndDeposit, DEPOSIT_NEED, type Funder } from "../liveExit/funding";
import { createNote } from "../liveExit/note";
import { prove } from "../liveExit/prove";
import type { Fact, StepState } from "../liveExit/steps";
import type { FrameRow } from "../frames";
import type { Inputs } from "./inputs";
import { plannedRows } from "./plan";
import { expectsRevert, fixOf, presetOf, type Intent } from "./presets";
import { FGUSD, quote } from "./quote";
import { blankSteps, type ChainTx, type Later, type Lifecycle, type Rescue, type RunResult, type StepId, type Steps } from "./steps";

const [FACTORY, BOOK, POOL] = [deployments.settlerFactory, deployments.invoiceBook, deployments.wethPool] as Address[];
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const FRAME_NAMES = ["expiry", "VERIFY PayRelayWETH", "withdraw", "factory.deploy", "unwrap", "swap", "settle", "sweep", "assertSettled"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const n = (x: number | bigint) => x.toLocaleString("en-US");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Reads on a shared devnet drop now and then: ask again before calling it a failure. */
const retry = async <T,>(fn: () => Promise<T>, tries = 4): Promise<T> => {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(1500); }
  }
};

export interface Ui {
  onChange(s: Steps): void;
  /** The nine frames as planned rows (settler known and real gas limits once built). */
  onPlan(rows: FrameRow[]): void;
  /** The sidecar accepted the nine-frame transaction: its hash is known and can be looked up. */
  onSent(hash: Hex): void;
  /** Every chain transaction of the run so far, newest state. */
  onTxs(txs: ChainTx[]): void;
  /** The sidecar's view of the nine-frame transaction, each time a poll adds something. */
  onLifecycle(lc: Lifecycle): void;
  /** In a block: the real frames are now readable from the chain. */
  onIncluded(hash: Hex): void;
  /** The nine frames are built: the raw transaction, before anything is sent. */
  onBuilt(raw: Hex, intent: Intent): void;
  /** The visitor's deposit landed at this leaf. */
  onLeaf(leaf: number): void;
  /** The run took a different intent (the fix). */
  onIntent(intent: Intent): void;
  /** The simulation predicts a revert on a run meant to revert. Resolve with what to do about it. */
  onGate(g: Gate): Promise<"send" | "fix" | "stop">;
}
export interface Gate { intent: Intent; frame: number; raw: Hex; view?: DoctorView }
export interface Labels { payee: string; change: string }

/** The step and transaction bookkeeping the deposit and the payment share. */
interface Tracker {
  put(id: StepId, patch: Partial<StepState>): void;
  fact(id: StepId, f: Fact): void;
  step<T>(id: StepId, fn: () => Promise<T>): Promise<T>;
  track(id: StepId, label: string, hash: Hex): void;
  settleTx(hash: Hex, block: bigint | number | undefined, ok?: boolean): void;
}

const tracker = (ui: Pick<Ui, "onChange" | "onTxs">): Tracker => {
  const steps = blankSteps();
  const txs: ChainTx[] = [];
  const put = (id: StepId, patch: Partial<StepState>) => { steps[id] = { ...steps[id], ...patch }; ui.onChange({ ...steps }); };
  return {
    put,
    fact(id, f) {
      const facts = steps[id].facts;
      put(id, { facts: facts.some((x) => x.k === f.k) ? facts.map((x) => (x.k === f.k ? f : x)) : [...facts, f] });
    },
    async step(id, fn) {
      const t = performance.now();
      put(id, { status: "running", startedAt: Date.now(), facts: [], detail: undefined, error: undefined, ms: undefined });
      try {
        const r = await fn();
        put(id, { status: "done", ms: performance.now() - t });
        return r;
      } catch (e) {
        put(id, { status: "error", ms: performance.now() - t, error: msg(e) });
        throw e;
      }
    },
    track(id, label, hash) {
      txs.push({ step: id, label, hash, state: "pending", sentAt: Date.now() });
      ui.onTxs(txs.map((x) => ({ ...x })));
    },
    settleTx(hash, block, ok = true) {
      const t = txs.find((x) => x.hash === hash);
      if (t?.state !== "pending") return;
      Object.assign(t, { state: ok ? "confirmed" : "failed", doneAt: Date.now(), block: block === undefined ? undefined : Number(block) });
      ui.onTxs(txs.map((x) => ({ ...x })));
    },
  };
};

const DEPOSIT_EVENT = parseAbiItem("event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)");
const WANT_LATER = 2;
const WAIT_MS = 90_000;
const WATCH_MS = 3000;

/** Fund, wrap, approve, deposit. The note stays in this run's locals: never stored or shown. */
async function runDeposit(t: Tracker, funder: Funder): Promise<{ note: Note; hash: Hex }> {
  const { step, fact, track, settleTx } = t;
  const note = await step("keys", async () => {
    const note = createNote();
    fact("keys", { k: funder.label, v: funder.address, href: addrUrl(funder.address) });
    fact("keys", { k: "note commitment", v: short(note.commitment) });
    return note;
  });

  await step("faucet", async () => {
    const hash = await funder.ensureFunds(DEPOSIT_NEED, (b) => fact("faucet", { k: "depositor balance", v: `${formatEther(b)} ETH`, tone: b >= DEPOSIT_NEED ? "ok" : undefined }), (h) => track("faucet", "faucet top-up", h));
    if (hash) settleTx(hash, (await client.getTransactionReceipt({ hash }).catch(() => undefined))?.blockNumber);
    else fact("faucet", { k: "faucet", v: "not needed, the balance covers a deposit" });
  });

  const hash = await step("deposit", async () => {
    const LABELS = { wrap: "wrap 0.1 ETH into WETH", approve: "approve the pool to take it", deposit: "pool.deposit(commitment)" } as const;
    const hash = await wrapAndDeposit(funder, note, POOL, (what, h) => track("deposit", LABELS[what], h), (h, block, ok) => settleTx(h, block, ok));
    fact("deposit", { k: "deposited", v: `${formatEther(DEVNET.denomination)} WETH into the pool`, tone: "ok" });
    fact("deposit", { k: "the depositor", v: "signs nothing more: the fund key creates the invoice and a fresh key signs any rescue", tone: "ok" });
    return hash;
  });
  return { note, hash };
}

/** Watches the pool's Deposit logs after the visitor's deposit, listing each later one, until WANT_LATER exist or 90 s pass.
 *  This page creates no deposits: whatever lands comes from others (on this devnet, mostly our crowd runner). */
async function waitForLater(t: Tracker, ui: Ui, own: Hex): Promise<Later[]> {
  const { step, fact, track, settleTx } = t;
  return step("wait", async () => {
    const r = await client.waitForTransactionReceipt({ hash: own, timeout: 180_000 });
    const [mine] = parseEventLogs({ abi: [DEPOSIT_EVENT], logs: r.logs.filter((l) => isAddressEqual(l.address, POOL)) });
    if (!mine) throw new Error(`no Deposit event in ${own}`);
    const leaf = mine.args.leafIndex;
    ui.onLeaf(leaf);
    fact("wait", { k: "your deposit", v: `leaf ${leaf}, block ${n(r.blockNumber)}` });
    const seen = new Map<number, Later>();
    const end = Date.now() + WAIT_MS;
    for (;;) {
      const logs = await retry(() => client.getLogs({ address: POOL, event: DEPOSIT_EVENT, fromBlock: r.blockNumber, toBlock: "latest" }));
      for (const l of logs.filter((l) => l.args.leafIndex! > leaf).sort((a, b) => a.args.leafIndex! - b.args.leafIndex!)) {
        if (seen.has(l.args.leafIndex!)) continue;
        const later = { leaf: l.args.leafIndex!, block: Number(l.blockNumber), hash: l.transactionHash };
        seen.set(later.leaf, later);
        track("wait", `deposit after yours, leaf ${later.leaf}`, later.hash);
        settleTx(later.hash, later.block);
      }
      fact("wait", { k: "later deposits", v: `${seen.size} of ${WANT_LATER}`, tone: seen.size >= WANT_LATER ? "ok" : undefined });
      if (seen.size >= WANT_LATER) return [...seen.values()];
      if (Date.now() > end) {
        fact("wait", seen.size
          ? { k: "timed out", v: `only ${seen.size} deposit landed after yours in 90 s. Proving anyway: the timing still narrows the set to a few notes.`, tone: "warn" }
          : { k: "no crowd running", v: "no deposit landed after yours in 90 s. Your note is the newest leaf in the root, and the timing links it.", tone: "warn" });
        return [...seen.values()];
      }
      await sleep(WATCH_MS);
    }
  });
}

const FUND_GAS = parseEther("0.01");
const POOL_READS = parseAbi(["function nextIndex() view returns (uint32)"]);

/** One Pledge Paid: a fresh depositor deposits, then the same tab proves against the newest root and pays. */
export async function runLivePledge(inputs: Inputs, labels: Labels, intent0: Intent, ui: Ui, funder: Funder): Promise<RunResult> {
  const t = tracker(ui);
  ui.onPlan(plannedRows());
  const { note, hash } = await runDeposit(t, funder);
  const later = await waitForLater(t, ui, hash);
  return runPay(t, ui, note, inputs, labels, intent0, later);
}

/** Prove against the newest root, have the fund issue the invoice, then build, simulate and send. */
async function runPay(t: Tracker, ui: Ui, note: Note, inputs: Inputs, labels: Labels, intent0: Intent, later: Later[]): Promise<RunResult> {
  const t0 = performance.now();
  const { put, fact, step, track, settleTx } = t;

  const { path, anonymity } = await step("tree", async () => {
    const { rebuildTree } = await import("../liveExit/tree");
    const p = await rebuildTree(note, 10, POOL);
    const [leavesNow, bal] = await retry(() => Promise.all([
      client.readContract({ address: POOL, abi: POOL_READS, functionName: "nextIndex" }),
      client.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [POOL] }),
    ]));
    const after = p.leafCount - 1 - p.leafIndex;
    // Every later deposit seen was mined before this read, so the newest root holds them all: check it rather than assume it.
    const missing = later.filter((l) => l.leaf >= p.leafCount);
    if (missing.length || (later.length && after < 1)) throw new Error(`the root covers leaves 0 to ${p.leafCount - 1}, which leaves out later leaves ${missing.map((l) => l.leaf).join(", ")} or puts yours last`);
    // Notes in the root that nobody has withdrawn: every withdrawal so far is a deposit missing from the pool's balance.
    const set = p.leafCount - (leavesNow - Number(bal / DEVNET.denomination));
    fact("tree", { k: "leaves", v: `${n(p.leafCount)} deposits rebuilt; ours is leaf ${p.leafIndex}` });
    fact("tree", { k: "pool getLastRoot()", v: `${short(p.chainRoot)} = local root, at roots(${p.rootIdx})`, tone: "ok" });
    fact("tree", { k: "root covers", v: `leaves 0 to ${p.leafCount - 1}: ${after} deposit${after === 1 ? "" : "s"} after yours${after ? "" : ", so the newest leaf in this root is yours"}`, tone: after > 0 ? "ok" : "warn" });
    fact("tree", { k: "anonymity set", v: `${set} unspent notes in this root, an upper bound. ${after ? "Timing still narrows it." : "Your leaf is the newest in this root, so the newest-leaf and timing links narrow it, likely to 1."}`, tone: "warn" });
    fact("tree", { k: "your position", v: `1 of ${p.leafCount} notes in this root, ${after} deposited after yours`, tone: after >= WANT_LATER ? "ok" : "warn" });
    return { path: p, anonymity: { leaf: p.leafIndex, root: p.root, rootIdx: p.rootIdx, leaves: p.leafCount, after, set, later } };
  });

  let intent = intent0;
  /** Invoice, quote, Settler, proof, nine frames, simulation, admission check. Runs again with the fixed intent after "Use the fix". */
  const build = async () => {
    const { invoiceId, q } = await step("invoice", async () => {
      fact("invoice", { k: `payee (${labels.payee})`, v: inputs.payee, href: addrUrl(inputs.payee) });
      fact("invoice", { k: `change address (${labels.change})`, v: inputs.change, href: addrUrl(inputs.change) });
      const pre = intent.invoice;
      if (pre && pre.amount !== inputs.amount) throw new Error(`invoice #${pre.id} is for ${formatUnits(pre.amount, 6)} fgUSD, not ${formatUnits(inputs.amount, 6)}`);
      let invoiceId: bigint;
      if (pre) {
        if (!(await retry(() => client.readContract({ address: BOOK, abi: invoiceBookAbi, functionName: "paid", args: [pre.id] })))) throw new Error(`invoice #${pre.id} is not paid any more: pick the preset again`);
        invoiceId = pre.id;
        fact("invoice", { k: "invoice", v: `#${pre.id}: ${formatUnits(pre.amount, 6)} fgUSD to ${labels.payee}. InvoiceBook.paid(${pre.id}) is true: reused on purpose`, tone: "warn" });
      } else {
        const fund = fundKeyFunder();
        const top = await fund.ensureFunds(FUND_GAS, () => {}, (h) => track("invoice", "fund key faucet top-up", h));
        if (top) settleTx(top, (await client.getTransactionReceipt({ hash: top }).catch(() => undefined))?.blockNumber);
        fact("invoice", { k: `created by (${fund.label.toLowerCase()})`, v: fund.address, href: addrUrl(fund.address) });
        const hash = await fund.wallet.writeContract({ address: BOOK, abi: invoiceBookAbi, functionName: "create", args: [inputs.payee, FGUSD, inputs.amount], type: "legacy" });
        track("invoice", "InvoiceBook.create", hash);
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
        settleTx(hash, receipt.blockNumber, receipt.status === "success");
        if (receipt.status !== "success") throw new Error(`create invoice ${hash} reverted`);
        const [created] = parseEventLogs({ abi: invoiceBookAbi, eventName: "Created", logs: receipt.logs });
        if (!created) throw new Error("no Created event in the invoice receipt");
        invoiceId = created.args.id;
        fact("invoice", { k: "invoice", v: `#${invoiceId}: ${formatUnits(inputs.amount, 6)} fgUSD to ${labels.payee}` });
      }
      const fresh = await retry(() => quote(inputs.amount));
      const q = intent.lowMaxIn ? { ...fresh, maxIn: fresh.maxIn / 2n } : fresh;
      fact("invoice", { k: "fgUSD pool", v: `liquidity ${fresh.liquidity}, ~${fresh.fgPerEth.toFixed(0)} fgUSD per ETH` });
      fact("invoice", { k: "fresh quote", v: `${formatUnits(inputs.amount, 6)} fgUSD costs ${formatEther(fresh.amountIn)} ETH` });
      fact("invoice", intent.lowMaxIn
        ? { k: "maxIn (half the quote)", v: `${formatEther(q.maxIn)} ETH, below the cost on purpose`, tone: "warn" }
        : { k: "maxIn (+3%)", v: `${formatEther(q.maxIn)} ETH`, tone: "ok" });
      return { invoiceId, q };
    });

    const { terms, settler, codeHash } = await step("settler", async () => {
      const terms: Terms = { invoiceId, book: BOOK, amount: inputs.amount, maxIn: q.maxIn, change: inputs.change };
      const codeHash = await retry(() => client.readContract({ address: FACTORY, abi: settlerFactoryAbi, functionName: "settlerCodeHash" }));
      const settler = settlerAddress(FACTORY, codeHash, terms);
      const onChain = await retry(() => client.readContract({ address: FACTORY, abi: settlerFactoryAbi, functionName: "addressOf", args: [terms] }));
      if (!isAddressEqual(settler, onChain)) throw new Error(`computed Settler ${settler} differs from factory.addressOf ${onChain}`);
      ui.onPlan(plannedRows(settler));
      fact("settler", { k: "terms", v: `invoice #${invoiceId}, ${formatUnits(inputs.amount, 6)} fgUSD, maxIn ${formatEther(q.maxIn)} ETH, change ${short(inputs.change)}` });
      fact("settler", { k: "Settler", v: settler, href: addrUrl(settler), tone: "ok" });
      fact("settler", { k: "check", v: "CREATE2 in the browser = factory.addressOf(terms); the proof's recipient will be this address", tone: "ok" });
      return { terms, settler, codeHash };
    });

    const proved = await step("prove", async () => {
      const p = await prove(note, path, { recipient: settler, relayer: PAY_RELAY, fee: EXIT_FEE }, () => {}, false);
      fact("prove", { k: "prover", v: "websnark (wasm) in this tab", tone: "ok" });
      fact("prove", { k: "circuit + key", v: `${(p.loadMs / 1000).toFixed(1)} s to fetch and unpack` });
      fact("prove", { k: "witness + proof", v: `${(p.proveMs / 1000).toFixed(1)} s` });
      fact("prove", { k: "recipient", v: `the Settler; relayer = PayRelayWETH ${short(PAY_RELAY)}, fee ${formatEther(EXIT_FEE)} WETH` });
      return p;
    });

    const { tx, failed } = await step("simulate", async () => {
      const gp = await retry(() => client.altpool.getGasPrice());
      const opts = { payRelay: PAY_RELAY, pool: POOL, factory: FACTORY, settlerCodeHash: codeHash, terms };
      // The fee cap is fixed by the relay's fee (EXIT_FEE / gas budget, ~0.65 gwei). The sidecar's suggested tip can exceed it
      // (2 gwei on Nov 7), which the node rejects as "Priority fee greater than max fee per gas". So the tip never exceeds the cap.
      const cap = payTx(proved.proof, opts).fees.maxFeePerGas;
      const tx = payTx(proved.proof, { ...opts, maxPriorityFeePerGas: gp.maxPriorityFeePerGas < cap ? gp.maxPriorityFeePerGas : cap });
      ui.onPlan(plannedRows(settler, tx));
      ui.onBuilt(encodeTx(profile, tx), intent);
      fact("simulate", { k: "transaction", v: `${tx.frames.length} frames, sender PayRelayWETH ${short(tx.sender)}, no signatures; nonce key = nullifier hash` });
      const sim = await retry(() => client.altpool.simulateFrameTransaction({ transaction: tx }));
      fact("simulate", { k: "execution", v: `${sim.executionStatus ?? "?"}${sim.executionError ? ` (${sim.executionError})` : ""}` });
      // valid=false here is expected: ethrex's public gates cap VERIFY at 100k and the relay's Groth16 check needs ~550k.
      fact("simulate", { k: "ethrex public gates", v: sim.valid ? "valid" : `not valid${sim.violation ? `: ${sim.violation}` : ""}`, tone: sim.valid ? "ok" : "warn" });
      sim.frames?.forEach((f, i) => fact("simulate", { k: `frame ${i} ${FRAME_NAMES[i]}`, v: `${f.succeeded ? "ok" : "WOULD FAIL"} · gas ${n(f.gasUsed)}`, tone: f.succeeded ? "ok" : "bad" }));
      const failed = sim.frames?.findIndex((f) => !f.succeeded) ?? -1;
      if (sim.frames?.length !== 9) throw new Error(`the simulation returned ${sim.frames?.length ?? 0} frames, expected 9 (execution: ${sim.executionStatus ?? "unknown"}${sim.executionError ? `, ${sim.executionError}` : ""}). Not sending, and nothing was spent beyond the deposit. Try again.`);
      if (failed >= 0 && !expectsRevert(intent)) throw new Error(`the simulation predicts frame ${failed} (${FRAME_NAMES[failed]}) fails${sim.executionError ? `: ${sim.executionError}` : ""}. Not sending: the withdraw would stay final and the funds would wait at the Settler.`);
      if (failed < 0 && expectsRevert(intent)) throw new Error(`"${presetOf(intent).label}" is meant to revert, but the node's simulation says all nine frames pass. Not sending.`);
      return { tx, failed };
    });

    await step("check", async () => {
      const report = await pledgeSimulator.check(tx);
      for (const [name, v] of [["public mempool", report.verdicts.public], ["alt mempool", report.verdicts.alt]] as const) {
        const rule = v.failed ? ` (${v.failed.rule}${v.failed.frameIndex !== undefined ? `, frame ${v.failed.frameIndex}` : ""})` : "";
        fact("check", { k: name, v: `${v.verdict}${rule} · source: ${v.source}`, tone: v.verdict === "admitted" ? "ok" : name === "alt mempool" ? "bad" : "warn" });
      }
      put("check", { detail: renderReport(report, { title: "checkAdmission" }) });
      const alt = report.verdicts.alt;
      // A rejection from our own rule model is unverified: the send below is the real test. A node's word stops the run.
      if (alt.verdict === "rejected" && alt.source !== "model") throw new Error(`the alt mempool would reject this payment: ${alt.failed?.rule ?? "unknown rule"}${alt.fix ? `. ${alt.fix}` : ""}`);
    });
    return { terms, settler, tx, failed, invoiceId };
  };

  let built = await build();
  while (built.failed >= 0) {
    const raw = encodeTx(profile, built.tx);
    const view = await runPledgeTx(raw).then((r) => r.view, () => undefined);
    const choice = await ui.onGate({ intent, frame: built.failed, raw, view });
    if (choice === "send") break;
    if (choice === "stop") throw new Error("Stopped before sending. Nothing was submitted; the deposited note stays in the pool.");
    intent = fixOf(intent);
    ui.onIntent(intent);
    built = await build();
  }
  const { terms, settler, tx, invoiceId } = built;
  const sentAnyway = built.failed >= 0;

  const snap = async () => {
    const bal = (token: Address, who: Address) => retry(() => client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] }));
    return {
      fundFg: await bal(FGUSD, inputs.payee),
      changeEth: await retry(() => client.getBalance({ address: inputs.change })),
      relayWeth: await bal(WETH9, PAY_RELAY),
    };
  };
  const before = await snap();

  const hash = await step("submit", async () => {
    // submit, not send: the sender is the PayRelayWETH contract (zero signatures) and it pins every frame.
    const sent = await client.altpool.submitFrameTransaction({ transaction: tx });
    track("submit", "the nine-frame Pledge Paid", sent.hash as Hex);
    ui.onSent(sent.hash as Hex);
    fact("submit", { k: "sidecar", v: `${DEVNET.minerSidecarUrl} accepted it` });
    return sent.hash as Hex;
  });

  let landed: Pick<RunResult, "block" | "gasUsed" | "frames" | "reverted"> | undefined;
  await step("receipt", async () => {
    const t0s = Date.now();
    const lc: Lifecycle = { hash, sentAt: t0s, intervalMs: 1500, polls: 0, failedPolls: 0, live: true, events: [{ status: "Accepted", at: t0s, note: "the miner's sidecar returned the hash" }] };
    const emit = () => ui.onLifecycle({ ...lc, events: [...lc.events] });
    const see = (status: string, note?: string) => {
      if (lc.events[lc.events.length - 1]?.status === status) return;
      lc.events.push({ status, at: Date.now(), note });
    };
    emit();
    const status = async () => {
      const s = await client.altpool.getTransactionStatus({ hash }).catch(() => "failed" as const);
      lc.polls++;
      lc.lastPollAt = Date.now();
      if (s === "failed") lc.failedPolls++;
      else if (s) {
        see(s.status, s.reason);
        lc.carriedBy = s.transaction ?? lc.carriedBy;
        lc.reason = s.reason ?? lc.reason;
      }
      return s === "failed" ? null : s;
    };
    try {
      let end = Date.now() + 180_000;
      let r = null;
      let revertedPolls = 0;
      let resends = 0;
      while (!r) {
        const [s, rec] = await Promise.all([status(), client.altpool.getFrameTransactionReceipt({ hash }).catch(() => null)]);
        r = rec;
        emit();
        revertedPolls = s?.status === "Reverted" ? revertedPolls + 1 : 0;
        if (!r && revertedPolls >= 3 && !sentAnyway) throw new Error(`the sidecar marks the payment Reverted and no receipt followed${s?.reason ? `: ${s.reason}` : ""}`);
        // The sidecar's privileged submission is one-shot per payload and gives up after a few missed blocks. Its README
        // allows sending the same transaction again; a reverting batch missed four payloads in a row on Nov 7, then landed.
        if (!r && s?.status === "Cancelled" && /without being included/.test(s.reason ?? "") && resends < 2) {
          resends++;
          await client.altpool.submitFrameTransaction({ transaction: tx });
          see("Resent", `the sidecar dropped it (${s.reason}), so the same transaction went again (${resends} of 2)`);
          end = Date.now() + 180_000;
          await sleep(lc.intervalMs);
          continue;
        }
        if (!r && s?.status === "Cancelled") throw new Error(`the sidecar cancelled the payment${s.reason ? `: ${s.reason}` : ""}`);
        if (!r && Date.now() > end) throw new Error(`no receipt for ${hash} after 180 s (last status: ${lc.events[lc.events.length - 1]?.status})`);
        if (!r) await sleep(lc.intervalMs);
      }
      see("Receipt", `block ${r.blockNumber}, ${r.status}`);
      await status();
      settleTx(hash, r.blockNumber, r.status === "success");
      landed = { block: Number(r.blockNumber), gasUsed: r.gasUsed ?? r.frames.reduce((t, f) => t + f.gasUsed.execution + f.gasUsed.state, 0n), frames: r.frames.filter((f) => f.status === "success").length };
      const failed = r.frames.find((f) => f.status !== "success");
      fact("receipt", { k: "block", v: `${r.blockNumber} · ${r.status}${r.gasUsed === undefined ? "" : ` · ${n(r.gasUsed)} gas in total`}`, tone: failed ? "warn" : "ok" });
      ui.onIncluded(hash);
      if (failed && sentAnyway) {
        landed.reverted = { frame: failed.index, status: failed.status };
        fact("receipt", { k: `frame ${failed.index} ${FRAME_NAMES[failed.index]}`, v: `${failed.status}: the atomic batch rolled back, as the simulation said`, tone: "warn" });
      } else if (failed) throw new Error(`frame ${failed.index} (${FRAME_NAMES[failed.index]}) ${failed.status}. The withdraw (frame 2) stays final and the relay is repaid; the earlier atomic frames are rolled back and the funds wait at the Settler ${settler}. Anyone can deploy it with the same terms and call refund() to send them to the change address.`);
    } catch (e) {
      settleTx(hash, undefined, false);
      throw e;
    } finally {
      lc.live = false;
      emit();
    }
  });

  await step("outcome", async () => {
    let after = await snap();
    for (let i = 0; i < 10 && after.fundFg === before.fundFg && !landed!.reverted; i++) { await sleep(1500); after = await snap(); }
    const get = <T,>(f: () => Promise<T>) => retry(f);
    const paid = await get(() => client.readContract({ address: BOOK, abi: invoiceBookAbi, functionName: "paid", args: [invoiceId] }));
    const [sw, se, sf, code] = await Promise.all([
      get(() => client.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [settler] })),
      get(() => client.getBalance({ address: settler })),
      get(() => client.readContract({ address: FGUSD, abi: erc20, functionName: "balanceOf", args: [settler] })),
      get(() => client.getCode({ address: settler })),
    ]);
    const settlerEmpty = (code ?? "0x").length > 2 && sw === 0n && se === 0n && sf === 0n;
    const gotFg = after.fundFg - before.fundFg;
    const gotChange = after.changeEth - before.changeEth;
    const relayGain = after.relayWeth - before.relayWeth;
    const paidOut = DEVNET.denomination - EXIT_FEE;
    const checks: [string, string, boolean][] = landed!.reverted ? [
      ["batch", `frame ${landed!.reverted.frame} ${landed!.reverted.status}; frames 3 to 8 undone`, landed!.reverted.frame === built.failed],
      ["withdraw", "frame 2 stands: the note is spent and the relay is repaid", landed!.frames >= 3 && relayGain >= EXIT_FEE],
      ["payee", `+${formatUnits(gotFg, 6)} fgUSD, unchanged`, gotFg === 0n],
      ["invoice", `#${invoiceId} ${paid ? "paid already" : "still unpaid"}`, paid === (intent.invoice !== undefined)],
      ["Settler", `no code deployed; ${formatEther(sw)} WETH parked at ${short(settler)}`, (code ?? "0x").length <= 2 && sw === paidOut],
      ["change", `+${formatEther(gotChange)} ETH at ${short(inputs.change)}, unchanged`, gotChange === 0n],
    ] : [
      ["payee", `+${formatUnits(gotFg, 6)} fgUSD`, gotFg === inputs.amount],
      ["invoice", `#${invoiceId} ${paid ? "paid" : "NOT paid"}`, paid],
      ["Settler", settlerEmpty ? "deployed and empty: no ETH, WETH or fgUSD left" : "not empty", settlerEmpty],
      ["change", `+${formatEther(gotChange)} ETH at ${short(inputs.change)}`, gotChange > 0n && gotChange < paidOut],
      ["relay fee", `+${formatEther(relayGain)} WETH repaid to PayRelayWETH`, relayGain >= EXIT_FEE],
    ];
    for (const [k, v, ok] of checks) fact("outcome", { k, v, tone: ok ? "ok" : "bad" });
    const bad = checks.find(([, , ok]) => !ok);
    if (bad) throw new Error(`${bad[0]}: ${bad[1]}`);
  });

  const rescue: Rescue = { terms, settler, change: inputs.change, invoicePaid: await retry(() => client.readContract({ address: BOOK, abi: invoiceBookAbi, functionName: "paid", args: [invoiceId] })) };
  return { hash, totalMs: performance.now() - t0, ...landed!, rescue, anonymity };
}
