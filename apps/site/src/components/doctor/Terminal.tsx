import { useEffect, useState } from "react";
import { useReducedMotion } from "../../hooks";
import { paint, type Tone } from "./paint";

const TONE: Record<Tone, string> = {
  bad: "font-medium text-[color-mix(in_srgb,var(--color-bad)_45%,white)]",
  ok: "text-[color-mix(in_srgb,var(--color-ok)_45%,white)]",
  warn: "text-[color-mix(in_srgb,var(--color-warn)_45%,white)]",
  src: "text-[color-mix(in_srgb,var(--color-ok)_45%,white)]",
  dim: "text-inkdim",
};
const LINE_MS = 70;

/** Remount per result (key on the text) so a new report always starts hidden. Hidden lines keep their space: no layout shift. */
const Typed = ({ text }: { text: string }) => {
  const lines = text.split("\n");
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setShown((s) => (s >= lines.length ? (clearInterval(id), s) : s + 1)), LINE_MS);
    return () => clearInterval(id);
  }, [reduced, lines.length]);
  const visible = reduced ? lines.length : shown;
  return lines.map((l, i) => (
    <span key={i} className={i < visible ? "block min-h-[22px]" : "invisible block min-h-[22px]"}>
      {paint(l).map((s, j) => <span key={j} className={s.tone && TONE[s.tone]}>{s.text}</span>)}
    </span>
  ));
};

export const Terminal = ({ text, error }: { text?: string; error?: string }) => (
  <pre className="ink m-0 min-h-[250px] whitespace-pre-wrap bg-ink p-5 font-mono text-[13px]/[22px] text-inkfg [overflow-wrap:anywhere]" aria-live="polite">
    {error !== undefined ? <span className="font-medium text-[color-mix(in_srgb,var(--color-bad)_45%,white)]"><span aria-hidden="true">✕ </span>frame-doctor: {error}</span> : text === undefined ? "asking the devnet…" : <Typed key={text} text={text} />}
  </pre>
);
