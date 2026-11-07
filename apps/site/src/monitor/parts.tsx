// Small building blocks shared by every monitor view, built on the site's primitives (components/ui.tsx).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NodeRef } from "@altpool/monitor";
import { cx, Dot, ExtLink } from "../components/ui";
import { KNOWN, lc, num, short } from "./fmt";
import { useCopy } from "./hooks";
import { navigate, queryFor, type Target } from "./route";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";
export const TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-acc", muted: "text-fg2" };
export const FILL: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-acc", muted: "bg-dim" };
const TAG: Record<Tone, string> = {
  ok: "border-okln bg-okbg text-okt", warn: "border-warnln bg-warnbg text-warn", bad: "border-bad/40 bg-bad/10 text-bad",
  info: "border-accln bg-accbg text-acc", muted: "border-ln2 text-fg2",
};

/** Same pill shape as the main page; the tone says ok, warn, bad, or just information. off = dashed, for "not there". */
export const Tag = ({ tone = "muted", off, title, children }: { tone?: Tone; off?: boolean; title?: string; children: ReactNode }) => (
  <span title={title} className={cx(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px]/normal",
    "before:size-[5px] before:rounded-full before:bg-current before:content-['']",
    off ? "border-dashed border-ln2 text-dim" : TAG[tone],
  )}>{children}</span>
);

export const Square = ({ tone }: { tone: Tone }) => <span aria-hidden="true" className={cx("mr-2 inline-block size-[7px] rounded-full align-[1px]", FILL[tone])} />;

/** In-app link: updates the URL and re-renders without a reload. Keeps the &node= choice. */
export const A = ({ to, className, children, "aria-current": current }: { to: Target; className?: string; children: ReactNode; "aria-current"?: "page" }) => {
  const p = new URLSearchParams(location.search);
  const n = p.get("node");
  const q = queryFor(to, n === "gateway" || n === "miner" ? n : "both", p.get("fee"));
  return (
    <a href={`?${q}`} className={className} aria-current={current} onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(q);
      scrollTo({ top: 0 });
    }}>{children}</a>
  );
};
export const TxLink = ({ hash }: { hash: string }) => <A to={{ kind: "tx", hash: hash as `0x${string}` }} className="font-mono text-acc hover:underline">{short(hash)}</A>;
export const EntityLink = ({ addr }: { addr: string }) => <A to={{ kind: "entity", addr: addr as `0x${string}` }} className="font-mono text-acc hover:underline focus-visible:underline">{KNOWN[lc(addr)]?.label ?? short(addr)}</A>;
export { ExtLink };

export const NodeTags = ({ on, watched }: { on: string[]; watched: NodeRef[] }) => (
  <span className="flex flex-wrap gap-1">
    {watched.map((n) => on.includes(n.name) ? <Tag key={n.name} tone="info">{n.name}</Tag> : <Tag key={n.name} off title={`never reached the ${n.name}`}>{n.name}: no</Tag>)}
  </span>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="m-0 p-5 text-[14px]/[22px] text-fg2">{children}</p>;

const th = "whitespace-nowrap border-b border-ln px-4 py-3 text-[11px] font-normal tracking-[.12em] text-fg2";
export const Table = ({ head, right = [], children }: { head: string[]; right?: number[]; children: ReactNode }) => (
  <div className="overflow-x-auto max-[720px]:overflow-visible">
    <table className="w-full border-collapse font-mono text-[13px] tabular-nums max-[720px]:block">
      <thead className="max-[720px]:sr-only"><tr>{head.map((h, i) => <th key={h + i} className={cx(th, right.includes(i) ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
      <tbody className="[&_tr:last-child_td]:border-b-0 max-[720px]:block [&_tr]:max-[720px]:block [&_tr]:max-[720px]:border-b [&_tr]:max-[720px]:border-ln [&_tr]:max-[720px]:py-2">{children}</tbody>
    </table>
  </div>
);
export const Td = ({ right, className, children, colSpan, label }: { right?: boolean; className?: string; children: ReactNode; colSpan?: number; label?: string }) => (
  <td colSpan={colSpan} data-label={label} className={cx(
    "border-b border-ln px-4 py-3 align-top text-fg",
    right && "text-right",
    "max-[720px]:flex max-[720px]:min-w-0 max-[720px]:items-baseline max-[720px]:gap-3 max-[720px]:border-b-0 max-[720px]:px-0 max-[720px]:py-1 max-[720px]:text-left max-[720px]:break-words",
    "before:max-[720px]:w-[104px] before:max-[720px]:shrink-0 before:max-[720px]:text-[11px] before:max-[720px]:tracking-[.12em] before:max-[720px]:text-fg2 before:max-[720px]:content-[attr(data-label)]",
    className,
  )}>{children}</td>
);

/** The headline strip: cells separated by hairlines. */
export const Stats = ({ cols, children }: { cols: 3 | 4 | 5; children: ReactNode }) => (
  <div className={cx(
    "grid grid-cols-1 gap-px border-b border-ln bg-ln min-[561px]:grid-cols-2",
    cols === 3 && "min-[961px]:grid-cols-3",
    cols === 4 && "min-[961px]:grid-cols-4",
    cols === 5 && "min-[961px]:grid-cols-5 [&>:last-child]:min-[561px]:max-[960px]:col-span-2",
  )}>{children}</div>
);
export const Stat = ({ label, tone, big, sub, children }: { label: string; tone: Tone; big: ReactNode; sub?: ReactNode; children?: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5 bg-s1 px-4 py-5">
    <span className="font-mono text-[12px] text-fg2"><Square tone={tone} />{label}</span>
    <span className={cx("break-words text-[28px]/[1.15] font-light tracking-[-.02em] tabular-nums", TEXT[tone])}>{big}</span>
    {children}
    <span className="font-mono text-[12px]/[18px] text-fg2 [overflow-wrap:anywhere]">{sub}</span>
  </div>
);

export const Heading = ({ title, sub, aside }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode }) => (
  <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
    <div className="flex min-w-0 flex-col gap-2">
      <h2 className="m-0 text-[clamp(26px,3.4vw,34px)]/[1.15] font-light tracking-[-.03em] text-balance">{title}</h2>
      {sub && <span className="font-mono text-[12.5px] text-fg2 [overflow-wrap:anywhere]">{sub}</span>}
    </div>
    {aside}
  </div>
);

export const Tabs = <T extends string>({ tabs, value, onChange, tone }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void; tone?: Partial<Record<T, Tone>> }) => (
  <div role="tablist" className="flex overflow-x-auto border-b border-ln">
    {tabs.map((t) => (
      <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
        className={cx("whitespace-nowrap border-r border-ln px-4 py-3 font-mono text-[13px]", value === t.id ? "bg-accbg text-fg shadow-[inset_0_-2px_0_var(--color-acc)]" : "text-fg2 hover:text-fg")}>
        {t.label}{t.count !== undefined && <> <span className={tone?.[t.id] ? TEXT[tone[t.id]!] : "text-dim"}>{t.count}</span></>}
      </button>
    ))}
  </div>
);

/** A rejection's rule, revert and fix, with the echoed public gas-cap text called out. */
export const Why = ({ d, detail, fallback }: { d?: { rule?: string; revertReason?: string; fix?: string }; detail: string; fallback: string }) => {
  // On Nov 6 the sidecars recorded rejected ExitRelay replays with the public mempool's gas-cap text, not the cause.
  const echoed = /prefix gas budget exceeded/.test(detail);
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[13px] text-bad">{d?.rule ?? fallback}{d?.revertReason ? ` · ${d.revertReason}` : ""}</span>
      {detail && <span className="max-w-[70ch] break-words font-mono text-[12px] text-fg2">{detail.slice(0, 200)}</span>}
      <span className="max-w-[70ch] text-[13px]/[20px] text-fg2">{echoed
        ? "This is the public mempool's gas cap, echoed by the sidecar, not the cause. A replayed note shows this. Run frame-doctor on the raw tx for the real reason."
        : d?.fix ?? ""}</span>
    </div>
  );
};

export const CopyButton = ({ text, label = "Copy" }: { text: string; label?: string }) => {
  const [done, copy] = useCopy();
  return (
    <button type="button" onClick={() => copy(text)} aria-label={done === text ? "Copied" : `${label} ${text.length > 24 ? "to clipboard" : text}`}
      className="min-h-7 rounded-md border border-ln2 px-2 font-mono text-[11.5px] text-fg1 hover:border-accln hover:text-acc">
      {done === text ? "Copied" : label}
    </button>
  );
};

/** Counts from the shown number to the new one when `value` changes. The first render and reduced motion show the value as is. */
export const CountUp = ({ value, format = (n) => num(Math.round(n)) }: { value: number; format?: (n: number) => string }) => {
  const [shown, setShown] = useState(value);
  const at = useRef(value);
  useEffect(() => {
    if (at.current === value || matchMedia("(prefers-reduced-motion: reduce)").matches) { at.current = value; setShown(value); return; }
    const from = at.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      at.current = from + (value - from) * (1 - (1 - k) ** 3);
      setShown(at.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular-nums">{format(shown)}</span>;
};

export interface Tick { at: number; label: string; className: string }
/** A bar with threshold marks. value and ticks share the 0..max scale. */
export const Meter = ({ value, max, tone, label, ticks = [] }: { value: number; max: number; tone: Tone; label: string; ticks?: Tick[] }) => {
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  return (
    <div className="relative h-2 rounded-full bg-ln2" role="meter" aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(Math.min(value, max))} aria-label={label}>
      <div className={cx("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700", FILL[tone])} style={{ width: pct(value) }} />
      {ticks.map((t) => <i key={t.label} title={t.label} className={cx("absolute -bottom-1 -top-1 w-0.5 rounded-full", t.className)} style={{ left: pct(t.at) }} />)}
    </div>
  );
};

export const Chip = ({ on, count, tone, onClick, children }: { on: boolean; count?: number; tone?: Tone; onClick: () => void; children: ReactNode }) => (
  <button type="button" aria-pressed={on} onClick={onClick}
    className={cx("min-h-9 whitespace-nowrap rounded-full border px-3 font-mono text-[12px]", on ? "border-accln bg-accbg text-acc" : "border-ln2 text-fg2 hover:text-fg")}>
    {children}{count !== undefined && <> <span className={cx(!on && count > 0 && tone ? TEXT[tone] : "")}>{count}</span></>}
  </button>
);

export const Skeleton = ({ className }: { className?: string }) => <span aria-hidden="true" className={cx("block animate-bl rounded bg-ln2", className ?? "h-4 w-24")} />;

/** One line that says what the live read is doing. Only the state word sits in the live region, so it speaks on change, not every second. */
export const Pulse = ({ state, children, word }: { state: "live" | "err" | undefined; word: string; children: ReactNode }) => (
  <div className="flex min-w-0 items-start gap-2 font-mono text-[12px]/[18px] text-fg2">
    <span className="mt-[5px]"><Dot state={state} /></span>
    <span className="min-w-0"><span role="status" className={cx("text-fg1", state === "err" && "text-bad")}>{word}</span> {children}</span>
  </div>
);
