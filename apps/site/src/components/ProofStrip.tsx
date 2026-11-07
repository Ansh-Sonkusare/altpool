import { ACCURACY, CONFORMANCE, FINDINGS, LIVE_SUITE, type ProofStat } from "../proof";
import { Stat } from "./ui";

const stats: ProofStat[] = [
  { ...ACCURACY, href: ACCURACY.href ?? "#proof" },
  { ...CONFORMANCE, href: CONFORMANCE.href ?? "#proof" },
  { ...LIVE_SUITE, href: LIVE_SUITE.href ?? "#proof" },
  {
    value: FINDINGS.filed,
    label: "Findings filed upstream",
    method: `Of ${FINDINGS.total} found while building; finding 9 filed with a tested fix (issue #7, PR #8).`,
    href: "#findings",
    state: /^\{.*\}$/.test(FINDINGS.filed) ? "pending" : "ok",
  },
];

export const ProofStrip = () => (
  <ul className="m-0 grid list-none grid-cols-4 gap-x-8 gap-y-8 border-t border-ln p-0 pt-8 max-[960px]:grid-cols-2 max-[480px]:gap-x-5">
    {stats.map((s) => (
      <li key={s.label} className="min-w-0">
        <Stat {...s} />
      </li>
    ))}
  </ul>
);
