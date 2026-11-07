// One highlighted <pre> for every static code sample. TS/TSX goes through sugar-high; shell is a few regexes.
import { highlight } from "sugar-high";
import { cx } from "./ui";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tok = (c: string, s: string) => `<span style="color:var(--sh-${c})">${esc(s)}</span>`;

// ponytail: per-line regexes, no quoting/heredoc awareness. Swap for a real shell grammar if samples grow.
const shell = (code: string) =>
  code.split("\n").map((l) => {
    if (/^\s*#/.test(l)) return tok("comment", l);
    const cmt = l.search(/\s#\s/);
    const [body, tail] = cmt < 0 ? [l, ""] : [l.slice(0, cmt), l.slice(cmt)];
    let first = true;
    const out = body.replace(/(\s+)|("[^"]*"|'[^']*')|(--?[\w-]+)|(\S+)/g, (_m, sp, str, flag, word) => {
      if (sp) return sp;
      if (str) return tok("string", str);
      if (flag) return tok("property", flag);
      const w = first && !/^[<[]/.test(word) ? tok("keyword", word) : tok("identifier", word);
      first = false;
      return w;
    });
    return out + (tail ? tok("comment", tail) : "");
  }).join("\n");

export const Code = ({ code, lang = "ts", className }: { code: string; lang?: "ts" | "sh"; className?: string }) => (
  <pre className={cx("ink m-0 overflow-x-auto bg-ink font-mono text-inkfg", className)}>
    <code dangerouslySetInnerHTML={{ __html: lang === "sh" ? shell(code) : highlight(code) }} />
  </pre>
);
