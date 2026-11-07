// Shared primitives every section imports. Nobody else edits this file.
// Variants are props, not className overrides: without tailwind-merge two utilities for one property conflict unpredictably.
import type { ReactNode } from "react";
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

/** v = verified source (green), u = unverified (amber). */
export const Pill = ({ kind, children }: { kind: "v" | "u"; children: ReactNode }) => (
  <span className={cx(
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px]/normal",
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
    state === "live" && size === "md" && "shadow-[0_0_0_4px_rgba(123,224,176,.15)]",
  )} />
);
export const dotFor = (s: Live<unknown>): DotState => (s.status === "live" ? "live" : s.status === "error" ? "err" : undefined);

/** A page section: top hairline, crosshair marks, standard padding. band = the slightly lighter background. */
export const Section = ({ id, band, className, children }: { id?: string; band?: boolean; className?: string; children: ReactNode }) => (
  <section id={id} className={cx(
    "crosshair relative flex flex-col gap-8 border-t border-ln px-[clamp(56px,8vw,128px)] py-20 max-[960px]:px-6 max-[960px]:py-16",
    band && "bg-band",
    className,
  )}>{children}</section>
);

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cx("min-w-0 rounded-xl border border-ln2 bg-s1", className)}>{children}</div>
);

/** A card's title strip. windowDots = the three grey "window" dots on the left. */
export const CardBar = ({ windowDots, children }: { windowDots?: boolean; children: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ln px-4 py-3 font-mono text-[12px]/normal text-fg2">
    {windowDots && (
      <span className="flex gap-1.5" aria-hidden="true">
        <i className="size-2 rounded-full bg-[#2a2a30]" /><i className="size-2 rounded-full bg-[#2a2a30]" /><i className="size-2 rounded-full bg-[#2a2a30]" />
      </span>
    )}
    {children}
  </div>
);

export const Eyebrow = ({ tone = "dim", children }: { tone?: "dim" | "amber"; children: ReactNode }) => (
  <span className={cx("font-mono text-[12px]/normal tracking-[.12em]", tone === "amber" ? "text-amber" : "text-fg2")}>{children}</span>
);

