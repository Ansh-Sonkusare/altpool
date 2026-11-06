export type Tone = "bad" | "ok" | "warn" | "src" | "dim";
export interface Span { text: string; tone?: Tone }

/** frame-doctor's report colouring, one row per original paint() rule. Every pattern stays within one line. */
const TOKENS: [RegExp, (m: string) => Tone][] = [
  [/✗ rejected/, () => "bad"],
  [/✓ admitted/, () => "ok"],
  [/\[local model, unverified\]/, () => "warn"],
  [/\[(?:node simulation|explorer record|sent)\]/, () => "src"],
  [/fix:/, () => "ok"],
  [/node:|status|VERIFY gas used|VERIFY gas|explorer|public ·/, () => "dim"],
];
const ANY = new RegExp(TOKENS.map(([r]) => `(${r.source})`).join("|"), "g");

export const paint = (line: string): Span[] => {
  const out: Span[] = [];
  let at = 0;
  for (const m of line.matchAll(ANY)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ text: m[0], tone: TOKENS[m.findIndex((g, i) => i > 0 && g !== undefined) - 1]![1](m[0]) });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
};
