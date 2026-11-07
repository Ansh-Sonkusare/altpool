import type { Hex } from "viem";
import type { DoctorView } from "../../live";
import { cx, short } from "../ui";
import { gapOf } from "./gapOf";

const Cell = ({ who, verdict, tone, children }: { who: string; verdict: string; tone: "ok" | "bad"; children: React.ReactNode }) => (
  <section aria-label={who} className="flex min-w-0 flex-col gap-2 p-5">
    <h4 className="m-0 font-mono text-[12px] font-normal text-fg2">{who}</h4>
    <p className={cx("m-0 font-serif text-[30px]/[1.1]", tone === "ok" ? "text-ok" : "text-bad")}><span aria-hidden="true">{tone === "ok" ? "✓ " : "✗ "}</span>{verdict}</p>
    <p className="m-0 text-sm/[21px] text-fg1 [overflow-wrap:anywhere]">{children}</p>
  </section>
);

/**
 * The three verdicts side by side as one story: the alt model admits, the sidecar admits (finding 9), the node's simulation
 * says a frame reverts. `sent` is the hash once the sidecar accepted the transaction, which turns the prediction into a measurement.
 * Renders nothing when the view has no gap.
 */
export const GapStory = ({ view, sent, preset }: { view?: DoctorView; sent?: Hex; preset?: string }) => {
  const gap = gapOf(view);
  if (!gap || !view?.alt) return null;
  const pre = gap.phase === "presend";
  return (
    <section aria-label="The admission gap" className="overflow-hidden rounded-xl border border-warnln bg-warnbg">
      <div className="flex flex-col gap-1 border-b border-warnln px-5 py-4">
        <h3 className="m-0 text-[17px] font-normal text-fg">
          {pre ? `Two checks say go. The node's simulation says frame ${gap.frame} reverts.` : `Admitted, then frame ${gap.frame} reverted on chain.`}
        </h3>
        <p className="m-0 text-sm/[21px] text-fg2">
          {preset && <>{preset}. </>}This is finding 9. Admission does not act on the atomic batch's result, so only the node's simulation shows the revert.
        </p>
      </div>
      <div className="grid grid-cols-3 divide-x divide-warnln max-[860px]:grid-cols-1 max-[860px]:divide-x-0 max-[860px]:divide-y">
        <Cell who={pre ? "checkAdmission, alt mempool" : "Alt mempool, sidecar record"} verdict="Admitted" tone="ok">
          {pre ? "From our local rule model, marked unverified. Its rules cover admission, not what the batch does." : "The sidecar's own admission record says admitted."}
        </Cell>
        <Cell who="The miner's sidecar" verdict={sent || !pre ? "Admitted" : "Would admit"} tone="ok">
          {sent ? `It accepted the transaction as ${short(sent)}, which measures finding 9 again.`
            : pre ? "Finding 9 measured the sidecar admitting a transaction that its own simulation said would revert. This page has not sent this one yet."
            : "It took the transaction into its pool, and the block builder included it."}
        </Cell>
        <Cell who={pre ? "frame-doctor, node simulation" : "The chain, frame receipt"} verdict={`Frame ${gap.frame} ${pre ? "reverts" : "reverted"}`} tone="bad">
          {gap.reason && <><span className="font-mono text-fg">{gap.reason}</span>. </>}
          {pre ? "The atomic batch would roll back. The withdraw in frame 2 stays final." : "The atomic batch rolled back. The withdraw in frame 2 stayed final."}
          {gap.fix && <span className="mt-2 block border-l-2 border-ok/60 pl-3"><span className="font-mono text-[12px] text-ok">fix </span>{gap.fix}</span>}
        </Cell>
      </div>
    </section>
  );
};
