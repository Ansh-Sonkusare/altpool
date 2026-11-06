import { useState } from "react";
import { RULES, ruleCells, type DoctorView } from "../../live";
import { cx } from "../ui";

const MARK = { pass: "✓", fail: "✗", unchecked: "–" } as const;
const WORD = { pass: "pass", fail: "fail", unchecked: "not checked" } as const;
const TONE = {
  pass: "border-okln bg-okbg text-okt",
  fail: "border-bad/50 bg-bad/10 text-bad",
  unchecked: "border-ln text-fg2",
} as const;

export const RuleGrid = ({ view }: { view?: DoctorView }) => {
  const cells = ruleCells(view);
  const [active, setActive] = useState<string>();
  const shown = RULES.find((r) => r.id === active);
  const cell = shown && cells.get(shown.id);
  const [all, setAll] = useState(false);
  const reported = RULES.filter((r) => cells.has(r.id));
  const hidden = RULES.length - reported.length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2 p-0">
        {(all ? RULES : reported).map((r) => {
          const state = cells.get(r.id)?.state ?? "unchecked";
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-describedby="rule-info"
                onMouseEnter={() => setActive(r.id)}
                onFocus={() => setActive(r.id)}
                onClick={() => setActive(r.id)}
                className={cx("flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left font-mono text-xs transition-colors", TONE[state], active === r.id && "outline outline-1 outline-fg2")}
              >
                <span className="min-w-0 truncate">{r.id}</span>
                <span className="flex-none" aria-label={WORD[state]}>{MARK[state]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(!all)} className="self-start font-mono text-xs text-fg2 underline decoration-ln2 underline-offset-4 hover:text-fg1">
          {all ? "Show only the rules reported for this input" : `${hidden} more rules were not reported for this input. Show them`}
        </button>
      )}
      <p id="rule-info" aria-live="polite" className="m-0 min-h-[42px] text-sm/[21px] text-fg2">
        {shown ? (
          <>
            <span className="font-mono text-fg1">{shown.id}</span> <span className="font-mono text-[11px]">({shown.scope === "both" ? "both mempools" : `${shown.scope} mempool`}, {WORD[cell?.state ?? "unchecked"]})</span>
            {" "}{shown.info}{cell?.why && cell.state === "fail" && <> <span className="text-bad">This input: {cell.why}</span></>}
          </>
        ) : (
          "Hover or focus a rule for what it checks."
        )}
      </p>
    </div>
  );
};
