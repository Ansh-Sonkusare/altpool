// The revert side of the live sender: preset buttons, the gate that shows the admission gap before a send, and the refund() recovery.
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { addrUrl } from "../altpool";
import { GapStory } from "../components/doctor/Gap";
import { openInDoctor } from "../components/doctor/follow";
import { cx, ExtLink, Pill, short } from "../components/ui";
import type { Live } from "../live";
import { freshKeyFunder } from "../liveExit/funding";
import { newestPaid } from "./invoices";
import { TxLine } from "./parts";
import { PRESETS, presetOf, type Intent, type PaidInvoice, type PresetId } from "./presets";
import { recover, type Recovered } from "./recover";
import type { Gate } from "./run";
import type { ChainTx, Rescue } from "./steps";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const btn = "min-h-11 cursor-pointer rounded-full border px-5 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-40";

/** The newest paid invoice, read from InvoiceBook on mount and again whenever `reload` changes (a run just paid a newer one). */
export const usePaidInvoice = (reload: unknown): Live<PaidInvoice | undefined> => {
  const [s, setS] = useState<Live<PaidInvoice | undefined>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    newestPaid().then(
      (value) => alive && setS({ status: "live", value, at: new Date() }),
      (e) => alive && setS((p) => ({ status: "error", error: msg(e), snapshot: p.status === "live" ? p.value : undefined })),
    );
    return () => { alive = false; };
  }, [reload]);
  return s;
};

export const PresetBar = ({ intent, paid, disabled, onPick }: { intent: Intent; paid: Live<PaidInvoice | undefined>; disabled: boolean; onPick: (id: PresetId) => void }) => {
  const inv = paid.status === "live" ? paid.value : paid.status === "error" ? paid.snapshot : undefined;
  const def = presetOf(intent);
  const missing = (id: PresetId) => id === "paid" && !inv;
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Presets" className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" aria-pressed={intent.id === p.id} disabled={disabled || missing(p.id)} onClick={() => onPick(p.id)}
            className={cx("min-h-9 rounded-full border px-3.5 py-[7px] text-left text-sm disabled:cursor-not-allowed disabled:opacity-40",
              intent.id === p.id ? "border-amberln bg-amberbg text-amber" : "border-ln2 text-fg1")}>{p.label}</button>
        ))}
      </div>
      <p aria-live="polite" className="m-0 max-w-[760px] text-[13.5px]/[21px] text-fg2">
        <span className="text-fg">{def.headline}</span> {def.why}
        {intent.invoice && <> The invoice is <span className="font-mono text-fg">#{intent.invoice.id.toString()}</span>.</>}
        {def.fix && <> The fix: {def.fix[0]!.toLowerCase()}{def.fix.slice(1)}</>}
        {paid.status === "loading" && intent.id === "pay" && " Looking for a paid invoice in InvoiceBook…"}
        {paid.status === "live" && !paid.value && " No paid invoice among the newest 40, so the invoice preset is off. Send one Pledge Paid first."}
        {paid.status === "error" && !inv && <span className="text-bad"> InvoiceBook could not be read: {paid.error}</span>}
      </p>
    </div>
  );
};

export interface GateState { gate: Gate; resolve: (d: "send" | "fix" | "stop") => void }

/** The run stopped before the send: three verdicts as one story, then the choice. */
export const GatePanel = ({ g, onChoose }: { g: GateState; onChoose: (d: "send" | "fix" | "stop") => void }) => {
  const { gate } = g;
  const def = presetOf(gate.intent);
  const stranded = gate.intent.id === "price";
  return (
    <div className="flex flex-col gap-4" role="region" aria-label="Decide before sending">
      <GapStory view={gate.view} preset={def.label} />
      {!gate.view && <p className="m-0 text-sm/[21px] text-fg1">The node's simulation says frame {gate.frame} reverts. frame-doctor's report could not be loaded; the step list above has the per-frame result.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => onChoose("fix")} className={cx(btn, "border-transparent bg-fg text-[#0a0a0c]")}>Use the fix</button>
        <button type="button" onClick={() => onChoose("send")} className={cx(btn, "border-warnln text-warn")}>Send anyway to see it on chain</button>
        <button type="button" onClick={openInDoctor} className={cx(btn, "border-ln2 text-fg1")}>Open in frame-doctor</button>
        <button type="button" onClick={() => onChoose("stop")} className="min-h-11 cursor-pointer px-2 text-[13px] text-fg2 underline decoration-ln2 underline-offset-4">Stop here</button>
      </div>
      <p className="m-0 max-w-[760px] text-[13px]/[20px] text-fg2">
        The fix rebuilds the payment with {gate.intent.id === "paid" ? "a fresh invoice" : "a fresh quote"} and checks it again, with the same deposit. Sending anyway spends the note: the relay is repaid and the withdraw stands, so 0.09 WETH waits at the Settler{" "}
        {stranded ? "for good. refund() needs a paid invoice, and nothing will pay this one." : "until refund() sends it to the change address."}
      </p>
    </div>
  );
};

/** After a rolled-back send: deploy the Settler at its fixed address, call refund(), show the change address got the funds. */
export const RecoverPanel = ({ rescue, now }: { rescue: Rescue; now: number }) => {
  const [funder] = useState(() => freshKeyFunder("Fresh rescue key"));
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [out, setOut] = useState<Recovered>();
  const [err, setErr] = useState<string>();
  const go = async () => {
    setPhase("running");
    setErr(undefined);
    const patch = (hash: string, p: Partial<ChainTx>) => setTxs((l) => l.map((t) => (t.hash === hash ? { ...t, ...p } : t)));
    try {
      setOut(await recover(funder, rescue, {
        onTx: (label, hash) => setTxs((l) => [...l, { step: "outcome", label, hash, state: "pending", sentAt: Date.now() }]),
        onMined: (hash, block, ok) => patch(hash, { state: ok ? "confirmed" : "failed", doneAt: Date.now(), block: Number(block) }),
      }));
      setPhase("done");
    } catch (e) {
      setErr(msg(e));
      setPhase("failed");
    }
  };
  return (
    <div className="flex flex-col gap-4 p-6 max-[560px]:p-4">
      <p className="m-0 font-serif text-[30px]/[1.1] text-fg">{rescue.invoicePaid ? "The funds can come home." : "The funds stay at the Settler."}</p>
      <p className="m-0 max-w-[760px] text-[14px]/[22px] text-fg2">
        {rescue.invoicePaid
          ? <>Anyone may call <span className="font-mono text-fg1">Settler.refund()</span> once the invoice is paid, and this one is. The rollback undid the deploy, so the Settler has no code yet. A fresh key, funded by the faucet and unrelated to the depositor, first calls <span className="font-mono text-fg1">SettlerFactory.deploy(terms)</span> at the same address, then <span className="font-mono text-fg1">refund()</span> sends its WETH to the change address <ExtLink href={addrUrl(rescue.change)} className="font-mono text-amber">{short(rescue.change)}</ExtLink>.</>
          : <><span className="font-mono text-fg1">refund()</span> reverts unless the invoice is paid, and nothing will pay it: the Settler's terms are fixed and its swap can never succeed. The 0.09 WETH are devnet funds. This is the cost of sending a payment you were told would revert.</>}
      </p>
      {rescue.invoicePaid && phase !== "done" && (
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" onClick={go} disabled={phase === "running"} className={cx(btn, "border-transparent bg-fg text-[#0a0a0c]")}>{phase === "running" ? "Recovering…" : "Recover the funds: call refund()"}</button>
          <span className="text-[13px] text-fg2">Signed by a fresh rescue key <ExtLink href={addrUrl(funder.address)} className="font-mono text-amber">{short(funder.address)}</ExtLink>, never by the depositor.</span>
        </div>
      )}
      {txs.length > 0 && <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{txs.map((t) => <TxLine key={t.hash} tx={t} now={now} />)}</ul>}
      {out && (
        <p role="status" className="m-0 flex flex-wrap items-center gap-3 text-[14px] text-fg1">
          <Pill kind={out.settlerLeft === 0n ? "v" : "u"}>{out.settlerLeft === 0n ? "recovered" : "Settler not empty"}</Pill>
          Change address {short(rescue.change)} received <span className="font-mono text-fg">{formatEther(out.weth)} WETH</span>; the Settler holds {formatEther(out.settlerLeft)}.
        </p>
      )}
      {err && <p role="alert" className="m-0 break-words font-mono text-[12.5px] text-bad">{err}</p>}
    </div>
  );
};

