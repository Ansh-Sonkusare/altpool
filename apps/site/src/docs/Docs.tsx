// The docs page (/docs). The content is src/docs/reference.md; the same file is copied to public/llms-full.txt on build
// (package.json "build"), so the page and the plain-text copy for agents cannot drift. Edit the Markdown, not this file.
import { Fragment, useEffect, type ReactNode } from "react";
import { Code } from "../components/Code";
import { Nav } from "../components/Nav";
import { Card, CardBar, cx, Eyebrow } from "../components/ui";
import { useHeadBlock } from "../hooks";
import reference from "./reference.md?raw";

// ------------------------------------------------------------------------------------------------ parsing ------

type Block =
  | { t: "h"; level: number; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "code"; lang: string; code: string }
  | { t: "table"; head: string[]; rows: string[][] };

const slug = (s: string) => s.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

const parse = (md: string): Block[] => {
  const lines = md.split("\n");
  const out: Block[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim();
      const buf: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) buf.push(lines[i]!);
      i++;
      out.push({ t: "code", lang, code: buf.join("\n") });
    } else if (/^#{1,4} /.test(l)) {
      const level = l.indexOf(" ");
      const text = l.slice(level + 1);
      const base = slug(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.push({ t: "h", level, text, id: n ? `${base}-${n + 1}` : base });
      i++;
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      out.push({ t: "table", head: rows[0]!, rows: rows.slice(2) });
    } else if (l.startsWith("- ")) {
      const items: string[] = [];
      for (; i < lines.length && (lines[i]!.startsWith("- ") || lines[i]!.startsWith("  ")); i++) {
        if (lines[i]!.startsWith("- ")) items.push(lines[i]!.slice(2)); else items[items.length - 1] += " " + lines[i]!.trim();
      }
      out.push({ t: "ul", items });
    } else if (l.trim() === "") {
      i++;
    } else {
      const buf: string[] = [];
      for (; i < lines.length && lines[i]!.trim() !== "" && !/^(```|#{1,4} |\||- )/.test(lines[i]!); i++) buf.push(lines[i]!);
      out.push({ t: "p", text: buf.join(" ") });
    }
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ rendering ------

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
const inline = (s: string): ReactNode =>
  s.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`")) return <code key={i} className="rounded bg-s1 px-1 py-px font-mono text-[0.9em] text-fg [overflow-wrap:anywhere]">{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i} className="font-medium text-fg">{part.slice(2, -2)}</strong>;
    const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (m) return <a key={i} href={m[2]} {...(m[2]!.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})} className="text-amber underline-offset-2 hover:underline">{m[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });

const FOLD_AT = 40;
const CodeBlock = ({ lang, code }: { lang: string; code: string }) => {
  const n = code.split("\n").length;
  const body = lang === "text"
    ? <pre className="m-0 overflow-x-auto p-4 font-mono text-[12.5px]/[20px] text-fg1">{code}</pre>
    : <Code code={code} lang={lang === "sh" ? "sh" : "ts"} className="p-4 text-[12.5px]/[20px]" />;
  const label = lang === "sh" ? "shell" : lang === "text" ? "output" : lang === "json" ? "json" : "typescript";
  return (
    <Card className="overflow-hidden">
      {n > FOLD_AT ? (
        <details className="[&>summary]:cursor-pointer">
          <summary className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 font-mono text-[12px] text-fg2 hover:text-fg">
            <span>{label} · {n} lines</span><span className="text-amber">expand</span>
          </summary>
          {body}
        </details>
      ) : (
        <>
          <CardBar windowDots><span>{label}</span></CardBar>
          {body}
        </>
      )}
    </Card>
  );
};

const Table = ({ head, rows }: { head: string[]; rows: string[][] }) => (
  <div className="overflow-x-auto rounded-xl border border-ln2">
    <table className="w-max min-w-full border-collapse text-left text-[13.5px]/[21px]">
      <thead>
        <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-ln bg-s1 px-3 py-2 font-mono text-[12px] font-normal text-fg2">{inline(h)}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-ln last:border-b-0">
            {r.map((c, j) => <td key={j} className="min-w-[7rem] max-w-[34rem] px-3 py-2 align-top text-fg1">{inline(c)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const HEADING = {
  2: "mt-10 border-t border-ln pt-10 text-[28px]/[34px] font-light tracking-[-.02em]",
  3: "mt-4 text-[20px]/[28px] font-medium",
  4: "mt-2 text-[16px]/[24px] font-medium text-fg1",
} as const;

const render = (b: Block, i: number): ReactNode => {
  switch (b.t) {
    case "h": {
      if (b.level === 1) return null;
      const H = `h${b.level}` as "h2" | "h3" | "h4";
      return (
        <H key={i} id={b.id} className={cx("group m-0 min-w-0", HEADING[b.level as 2 | 3 | 4])}>
          <a href={`#${b.id}`} className="no-underline">{b.text.replace(/`/g, "")}<span aria-hidden="true" className="ml-2 text-dim opacity-0 group-hover:opacity-100">#</span></a>
        </H>
      );
    }
    case "p": return <p key={i} className="m-0 max-w-[760px] text-[15px]/[24px] text-fg2">{inline(b.text)}</p>;
    case "ul": return <ul key={i} className="m-0 flex max-w-[760px] list-disc flex-col gap-2 pl-5 text-[15px]/[24px] text-fg2">{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>;
    case "code": return <CodeBlock key={i} lang={b.lang} code={b.code} />;
    case "table": return <Table key={i} head={b.head} rows={b.rows} />;
  }
};

const BLOCKS = parse(reference);
const HEADS = BLOCKS.filter((b): b is Extract<Block, { t: "h" }> => b.t === "h" && (b.level === 2 || b.level === 3));

const Toc = ({ onPick }: { onPick?: () => void }) => (
  <ul className="m-0 flex list-none flex-col p-0 text-[14px]">
    {HEADS.map((h) => (
      <li key={h.id}>
        <a href={`#${h.id}`} onClick={onPick} className={cx("block rounded-md py-1 text-fg2 hover:bg-s1 hover:text-fg", h.level === 2 ? "mt-3 px-2 font-medium text-fg1" : "px-2 pl-5 text-[13px]")}>{h.text.replace(/`/g, "")}</a>
      </li>
    ))}
  </ul>
);

const MCP_INSTALL = `git clone https://github.com/Ansh-Sonkusare/altpool && cd altpool && bun install
claude mcp add altpool -- bun $PWD/packages/mcp/src/server.ts`;

export const Docs = () => {
  const head = useHeadBlock();
  useEffect(() => { document.title = "Docs · Altpool"; }, []);
  const pad = "px-[clamp(56px,8vw,128px)] max-[960px]:px-6 max-[560px]:px-4";
  return (
    <div className="relative mx-auto min-h-screen max-w-[1360px] overflow-x-clip border-x border-ln">
      <div className="pointer-events-none absolute -top-[180px] -right-[160px] h-[420px] w-[700px] max-w-full bg-[radial-gradient(closest-side,rgba(241,201,140,.09),rgba(241,201,140,.02)_55%,transparent)]" aria-hidden="true"></div>
      <Nav head={head} />
      <header className={cx("relative flex flex-col gap-4 pt-14 pb-8", pad)}>
        <Eyebrow tone="amber">docs</Eyebrow>
        <h1 className="m-0 text-balance text-[clamp(36px,5vw,56px)]/[1.07] font-light tracking-[-.03em]">
          Build with every package, <span className="font-serif font-normal italic">without opening the repo.</span>
        </h1>
        <p className="m-0 max-w-[720px] text-[16px]/[26px] text-fg1">
          Full API reference, eight runnable recipes, the rule catalogue, every CLI flag and MCP tool schema, and the devnet facts that bite. Checked against the source and the live devnet.
        </p>
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[13px]">
          <span className="text-fg2">For agents:</span>
          <a href="/llms.txt" className="text-amber hover:underline">/llms.txt</a>
          <a href="/llms-full.txt" className="text-amber hover:underline">/llms-full.txt</a>
          <span className="text-fg2">(this page as plain Markdown)</span>
        </p>
        <div className="max-w-[760px]"><CodeBlock lang="sh" code={MCP_INSTALL} /></div>
      </header>

      <div className={cx("relative grid grid-cols-[240px_minmax(0,1fr)] items-start gap-x-12 pb-20 max-[960px]:grid-cols-1", pad)}>
        <aside className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 max-[960px]:hidden"><Toc /></aside>
        <details className="mb-6 rounded-xl border border-ln2 bg-s1 px-3 py-2 min-[961px]:hidden [&>summary]:cursor-pointer [&>summary]:py-1 [&>summary]:font-mono [&>summary]:text-[13px] [&>summary]:text-fg2">
          <summary>On this page</summary>
          <div className="max-h-[60vh] overflow-y-auto pt-2"><Toc /></div>
        </details>
        <main className="flex min-w-0 flex-col gap-4">{BLOCKS.map(render)}</main>
      </div>
    </div>
  );
};
