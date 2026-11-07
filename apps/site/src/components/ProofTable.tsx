import { TxLink, Verdict, cx } from "./ui";
import type { SuiteTx } from "../proof";

export type FindingStatus =
  | "proposal written"
  | "reported privately"
  | "patch ready (not yet filed)"
  | "not yet reported (private)"
  | "fixed on devnet"
  | "not a bug";

export interface Finding {
  n: number;
  title: string;
  /** The sentence shown on the page. */
  detail: React.ReactNode;
  status: FindingStatus;
  /** Set once filed upstream. */
  href?: string;
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="num rounded-sm bg-band px-1 text-[13px] text-fg">{children}</code>
);
export { Code as FindingCode };

// Stacked rows under 720px: each <tr> becomes a block, header row is visually hidden, cells carry data-label.
const TABLE = "w-full border-collapse text-left max-[720px]:block [&_tbody]:max-[720px]:block";
const THEAD = "max-[720px]:sr-only";
const TR = "max-[720px]:block max-[720px]:border-t max-[720px]:border-ln2 max-[720px]:py-3 min-[721px]:border-t min-[721px]:border-ln";
const TH = "px-3 py-2 font-mono text-[12px]/4 font-medium uppercase tracking-[.08em] text-fg2";
const TD = "px-3 py-3 align-top text-[14px]/[22px] text-fg1 max-[720px]:flex max-[720px]:flex-wrap max-[720px]:items-baseline max-[720px]:gap-2 max-[720px]:px-0 max-[720px]:py-1 before:max-[720px]:w-[96px] before:max-[720px]:shrink-0 before:max-[720px]:font-mono before:max-[720px]:text-[12px]/4 before:max-[720px]:uppercase before:max-[720px]:tracking-[.08em] before:max-[720px]:text-fg2 before:max-[720px]:content-[attr(data-label)]";

export const SuiteTable = ({ rows }: { rows: SuiteTx[] }) => {
  if (rows.length === 0) return <p className="m-0 text-[15px]/6 font-medium text-warn">Suite not run yet.</p>;
  return (
    <table className={TABLE}>
      <caption className="sr-only">Live devnet suite: predicted verdict against node outcome, with transaction links</caption>
      <thead className={THEAD}>
        <tr className="border-b border-ln2">
          <th scope="col" className={TH}>Case</th>
          <th scope="col" className={TH}>Predicted</th>
          <th scope="col" className={TH}>Node outcome</th>
          <th scope="col" className={TH}>Transaction</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.name}-${r.hash ?? "none"}`} className={TR}>
            <td data-label="Case" className={cx(TD, "font-medium text-fg")}>{r.name}</td>
            <td data-label="Predicted" className={TD}>
              <Verdict kind={r.predicted === "admit" ? "admit" : "reject"}>{r.predicted}</Verdict>
            </td>
            <td data-label="Node" className={TD}>
              <Verdict kind={r.outcome === "included" || r.outcome === "admitted" ? "admit" : "reject"}>{r.outcome === "admitted" ? "admitted, not mined" : r.outcome}</Verdict>
            </td>
            <td data-label="Tx" className={TD}>
              {r.hash ? <TxLink hash={r.hash} /> : <span className="text-fg2">no record (refused at submit)</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const FindingsTable = ({ rows }: { rows: Finding[] }) => (
  <table className={TABLE}>
    <caption className="sr-only">Fifteen findings from building on the devnet, with the status of each</caption>
    <thead className={THEAD}>
      <tr className="border-b border-ln2">
        <th scope="col" className={cx(TH, "w-12")}>#</th>
        <th scope="col" className={TH}>Finding</th>
        <th scope="col" className={cx(TH, "w-[220px]")}>Status</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((f) => (
        <tr key={f.n} className={TR}>
          <td data-label="#" className={cx(TD, "num text-fg2")}>{f.n}</td>
          <td data-label="Finding" className={cx(TD, "max-[720px]:items-start")}>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[15px]/6 font-medium text-fg">{f.title}</span>
              <span>{f.detail}</span>
            </div>
          </td>
          <td data-label="Status" className={TD}>
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap rounded-md border border-ln2 px-2 py-0.5 font-mono text-[13px]/5 text-fg">{f.status}</span>
              {f.href && <a href={f.href} target="_blank" rel="noreferrer" className="text-acc underline underline-offset-2 hover:text-fg">Open finding {f.n} upstream ↗</a>}
            </span>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);
