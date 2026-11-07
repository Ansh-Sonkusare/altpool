// Shared primitives every section imports. Nobody else edits this file.
// Variants are props, not className overrides: without tailwind-merge two utilities for one property conflict unpredictably.
import type { ReactNode } from "react";
import { exitUrl } from "../altpool";
import type { Live } from "../live";

export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
export const fmt = (x: number | bigint) => x.toLocaleString("en-US");
export const eth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;
export const clock = (d: Date) => d.toLocaleTimeString();
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** The value a Live state can show: live data, or the snapshot kept on error. */
export const valueOf = <T,>(s: Live<T>): T | undefined => (s.status === "live" ? s.value : s.status === "error" ? s.snapshot : undefined);

export const ExtLink = ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className={className}>{children} ↗</a>
);

/** v = verified source (green), u = unverified (warn). */
export const Pill = ({ kind, children }: { kind: "v" | "u"; children: ReactNode }) => (
  <span className={cx(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[12px]/normal",
    "before:size-[5px] before:rounded-full before:bg-current before:content-['']",
    kind === "v" ? "border-okln bg-okbg text-okt" : "border-warnln bg-warnbg text-warn",
  )}>{children}</span>
);

export type DotState = "live" | "err" | undefined;
/** No state = grey (connecting). sm = the 6px dot used inside pills, claim checks and card footers (no glow). */
export const Dot = ({ state, size = "md" }: { state?: DotState; size?: "sm" | "md" }) => (
  <span className={cx(
    "flex-none rounded-full",
    size === "sm" ? "size-1.5" : "size-[7px]",
    state === "live" ? "animate-bl bg-ok" : state === "err" ? "bg-bad" : "bg-dim",
  )} />
);
export const dotFor = (s: Live<unknown>): DotState => (s.status === "live" ? "live" : s.status === "error" ? "err" : undefined);

/** A page section: full-width band with a top rule, content in the 1200px column. band = the alternate paper tone.
 *  Give n + label + title to open it with a SectionHead. */
export const Section = ({ id, band, className, n, label, title, lede, children }: {
  id?: string; band?: boolean; className?: string; n?: string; label?: string; title?: ReactNode; lede?: ReactNode; children: ReactNode;
}) => (
  <section id={id} className={cx("border-t border-ln2", band && "bg-band")}>
    <div className={cx("mx-auto flex max-w-[1200px] flex-col gap-8 px-[clamp(20px,5vw,72px)] py-[clamp(48px,6vw,72px)]", className)}>
      {n && label && title && <SectionHead n={n} label={label} title={title} lede={lede} />}
      {children}
    </div>
  </section>
);

/** Gutter label (number + name) beside an h2 and optional lede. Stacks under 960px. */
export const SectionHead = ({ n, label, title, lede }: { n: string; label: string; title: ReactNode; lede?: ReactNode }) => (
  <header className="grid gap-4 min-[960px]:grid-cols-[160px_minmax(0,1fr)] min-[960px]:gap-8">
    <p className="m-0 font-mono text-[12px]/4 font-medium uppercase tracking-[.08em] text-fg2 min-[960px]:pt-3">{n} · {label}</p>
    <div className="flex min-w-0 flex-col gap-4">
      <h2 className="m-0 max-w-[22ch] text-balance text-[clamp(30px,4vw,48px)]/[1.08] font-medium tracking-[-.025em] text-fg">{title}</h2>
      {lede && <p className="m-0 max-w-[62ch] text-[18px]/7 text-fg1">{lede}</p>}
    </div>
  </header>
);

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cx("min-w-0 rounded-md border border-ln2 bg-s1", className)}>{children}</div>
);

/** A card's title strip. windowDots = the three window dots on the left. */
export const CardBar = ({ windowDots, children }: { windowDots?: boolean; children: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ln px-4 py-3 font-mono text-[12px]/normal text-fg2">
    {windowDots && (
      <span className="flex gap-1.5" aria-hidden="true">
        <i className="size-2 rounded-full bg-inkln" /><i className="size-2 rounded-full bg-inkln" /><i className="size-2 rounded-full bg-inkln" />
      </span>
    )}
    {children}
  </div>
);

export const Eyebrow = ({ tone = "dim", children }: { tone?: "dim" | "acc"; children: ReactNode }) => (
  <span className={cx("font-mono text-[12px]/normal tracking-[.08em]", tone === "dim" ? "text-fg2" : "text-acc")}>{children}</span>
);

/** Solid = ink fill, hover blue. Line = hairline control, hover ink border. Anchor when href, else button. */
export const Btn = ({ href, onClick, variant, children }: { href?: string; onClick?: () => void; variant: "solid" | "line"; children: ReactNode }) => {
  const cls = cx(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-5 text-[15px]/6 font-medium transition-[color,background-color,border-color,opacity,transform] duration-120 ease-out active:translate-y-px",
    variant === "solid" ? "border-fg bg-fg text-bg hover:border-acc hover:bg-acc hover:text-bg" : "border-ln2 text-fg hover:border-fg hover:text-fg",
  );
  return href ? <a href={href} className={cls}>{children}</a> : <button type="button" onClick={onClick} className={cls}>{children}</button>;
};

export type StatState = "ok" | "unverified" | "pending";
/** Proof numeral + label + method line + optional evidence link. A `{TOKEN}` value renders as a dashed "pending" box, never as a number. */
export const Stat = ({ value, label, method, href, state }: { value: string; label: string; method: string; href?: string; state?: StatState }) => {
  const pending = /^\{.*\}$/.test(value.trim()) || state === "pending";
  const tone = pending || state === "unverified" ? "text-warn" : state === "ok" ? "text-okt" : "text-fg";
  const body = (
    <>
      {pending ? (
        <span className="inline-flex min-h-[clamp(64px,8vw,96px)] flex-col justify-center rounded-md border border-dashed border-warnln bg-warnbg px-3 text-warn">
          <span className="font-mono text-[14px]/5 font-medium uppercase tracking-[.08em]">pending</span>
          <span className="num text-[12px]/4 opacity-90">{value}</span>
        </span>
      ) : (
        <span className={cx("proof block text-[clamp(64px,8vw,96px)]", tone)}>{value}</span>
      )}
      <span className="text-[15px]/6 font-medium text-fg">{label}</span>
      <span className="text-[14px]/[22px] text-fg2">{method}</span>
    </>
  );
  const cls = "flex min-w-0 flex-col items-start gap-2";
  return href
    ? <a href={href} className={cx(cls, "hover:[&_span:nth-last-child(2)]:text-acc")}>{body}</a>
    : <div className={cls}>{body}</div>;
};

const VERDICT = {
  admit: ["✓", "border-okln bg-okbg text-okt"],
  reject: ["✕", "border-bad/40 bg-badbg text-bad"],
  unverified: ["?", "border-warnln bg-warnbg text-warn"],
} as const;
/** Icon + word chip. Colour never carries the verdict alone. */
export const Verdict = ({ kind, children }: { kind: "admit" | "reject" | "unverified"; children: ReactNode }) => (
  <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[13px]/5 font-medium", VERDICT[kind][1])}>
    <span aria-hidden="true">{VERDICT[kind][0]}</span>{children}
  </span>
);

/** Dark panel for code, terminals and tx dumps. Optional title in the header strip. */
export const InkPanel = ({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) => (
  <div className={cx("ink min-w-0 overflow-hidden rounded-md bg-ink text-inkfg", className)}>
    <div className="flex items-center gap-3 border-b border-inkln px-4 py-3 font-mono text-[12px]/4 text-inkdim">
      <span className="flex gap-1.5" aria-hidden="true">
        <i className="size-2 rounded-full bg-inkln" /><i className="size-2 rounded-full bg-inkln" /><i className="size-2 rounded-full bg-inkln" />
      </span>
      {title && <span className="min-w-0 truncate">{title}</span>}
    </div>
    {children}
  </div>
);

/** Short mono tx hash linking to the explorer on the node that holds it. */
export const TxLink = ({ hash, label }: { hash: string; label?: string }) => (
  <a href={exitUrl(hash)} target="_blank" rel="noreferrer" aria-label={`Open tx ${short(hash)} on the explorer`} className="num inline-flex min-h-6 items-center gap-1 text-[13px]/5 text-acc underline underline-offset-2 hover:text-fg">
    {label ?? short(hash)} ↗
  </a>
);


/** The artifact's fact row: a small sans label over a mono number. */
export const Facts = ({ children }: { children: ReactNode }) => (
  <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-x-6 gap-y-4">{children}</dl>
);
export const Fact = ({ k, children }: { k: string; children: ReactNode }) => (
  <div><dt className="text-[12px] text-fg2">{k}</dt><dd className="m-0 mt-0.5 font-mono text-[18px] text-fg tabular-nums">{children}</dd></div>
);

/** Mono key/value list: keys left, values wrap. Rows are [key, value] pairs. */
export const Kvl = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-1.5 font-mono text-[12.5px]/[1.5] max-[560px]:grid-cols-1 max-[560px]:gap-y-0">
    {rows.map(([k, v]) => (
      <div key={k} className="contents">
        <dt className="text-fg2">{k}</dt>
        <dd className="m-0 break-words max-[560px]:mb-1.5 [overflow-wrap:anywhere]">{v}</dd>
      </div>
    ))}
  </dl>
);
