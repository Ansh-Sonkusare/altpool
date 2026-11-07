// VERIFY gas per inclusion against the public cap and the entity's own pin. Hover, touch or arrow keys read one inclusion.
import { useState } from "react";
import type { EntityReport } from "@altpool/monitor";
import { cx } from "../components/ui";
import { clockAt, DEVNET, ethDp, num, short } from "./fmt";

const H = 180;

export const GasChart = ({ r, pin: pinG, blockTime }: { r: EntityReport; pin?: bigint; blockTime: (b: number) => number | undefined }) => {
  const pts = r.inclusions.filter((i) => i.verifyGas !== undefined).sort((a, b) => a.block - b.block);
  const [hover, setHover] = useState<number>();
  if (!pts.length) return <p className="m-0 py-10 text-center text-[14px] text-fg2">No inclusion in the explorers' recent history carries a VERIFY gas figure yet. Once this entity lands a transaction it plots here.</p>;

  const pin = Number(pinG ?? 0n), cap = Number(DEVNET.publicVerifyGasCap);
  const max = Math.max(pin * 1.12, cap * 1.12, ...pts.map((p) => Number(p.verifyGas) * 1.1));
  const y = (v: number) => H - (v / max) * (H - 12);
  const xp = (i: number) => (pts.length === 1 ? 50 : 1.5 + (i * 97) / (pts.length - 1));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${(xp(i) * 10).toFixed(1)},${y(Number(p.verifyGas)).toFixed(1)}`).join(" ");
  const area = `${line} L${xp(pts.length - 1) * 10},${H} L${xp(0) * 10},${H} Z`;
  const a = hover === undefined ? undefined : pts[hover];
  const aT = a ? blockTime(a.block) : undefined;
  const over = a ? Number(a.verifyGas) / cap : 0;
  const nearest = (clientX: number, el: HTMLElement) => {
    const b = el.getBoundingClientRect();
    const f = ((clientX - b.left) / b.width) * 100;
    let best = 0;
    pts.forEach((_, i) => { if (Math.abs(xp(i) - f) < Math.abs(xp(best) - f)) best = i; });
    return best;
  };
  const last = pts[pts.length - 1]!;

  return (
    <div className="relative h-[206px] touch-pan-y select-none rounded-md outline-offset-4" tabIndex={0} role="group"
      aria-label={`VERIFY gas of the last ${pts.length} inclusions, latest ${num(last.verifyGas!)}, public cap ${num(cap)}${pinG ? `, pin ${num(pin)}` : ""}. Arrow keys step through inclusions.`}
      onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget))} onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget))} onPointerLeave={() => setHover(undefined)}
      onFocus={(e) => { if (e.target === e.currentTarget && hover === undefined) setHover(pts.length - 1); }} onBlur={() => setHover(undefined)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setHover((h) => Math.max(0, (h ?? pts.length) - 1)); }
        if (e.key === "ArrowRight") { e.preventDefault(); setHover((h) => Math.min(pts.length - 1, (h ?? -1) + 1)); }
        if (e.key === "Escape") setHover(undefined);
      }}>
      <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" className="block h-[180px] w-full" aria-hidden="true">
        <defs><linearGradient id="gasfade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style={{ stopColor: "var(--color-acc)" }} stopOpacity=".24" /><stop offset="1" style={{ stopColor: "var(--color-acc)" }} stopOpacity="0" /></linearGradient></defs>
        {pinG && <line x1="0" x2="1000" y1={y(pin)} y2={y(pin)} className="stroke-fg2" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />}
        <line x1="0" x2="1000" y1={y(cap)} y2={y(cap)} className="stroke-warn" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
        {pts.length > 1 && <path d={area} fill="url(#gasfade)" />}
        {pts.length > 1 && <path d={line} fill="none" className="stroke-acc" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {a && <line x1={xp(hover!) * 10} x2={xp(hover!) * 10} y1="0" y2={H} className="stroke-fg2" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {pts.map((p, i) => (
        <i key={p.hash} aria-hidden="true" className={cx("absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc ring-2 ring-bg", i === hover ? "scale-150 ring-acc/40" : "opacity-80")}
          style={{ left: `${xp(i)}%`, top: y(Number(p.verifyGas)) }} />
      ))}
      {pinG && <span className="pointer-events-none absolute right-0 -translate-y-full pb-0.5 font-mono text-[11px] text-fg2" style={{ top: y(pin) }}>our pin {num(pin)}</span>}
      <span className="pointer-events-none absolute left-0 -translate-y-full pb-0.5 font-mono text-[11px] text-warn" style={{ top: y(cap) }}>public cap {num(cap)}</span>
      <span className="pointer-events-none absolute bottom-0 left-0 font-mono text-[11px] text-dim">block {num(pts[0]!.block)}</span>
      <span className="pointer-events-none absolute bottom-0 right-0 font-mono text-[11px] text-dim">block {num(last.block)}</span>
      {a && (
        <div role="status" className="pointer-events-none absolute top-1 z-10 w-max max-w-[220px] rounded-lg border border-ln2 bg-bg/95 px-3 py-2 font-mono text-[11.5px]/[17px] text-fg1 shadow-[0_8px_24px_var(--color-ln2)]"
          style={{ left: `${xp(hover!)}%`, transform: `translateX(${xp(hover!) > 62 ? "calc(-100% - 12px)" : "12px"})` }}>
          <div className="text-fg">block {num(a.block)}{aT && <span className="text-fg2"> · {clockAt(aT)}</span>}</div>
          <div>VERIFY <span className="text-acc">{num(a.verifyGas!)}</span> gas</div>
          <div className={over > 1 ? "text-warn" : "text-ok"}>{over > 1 ? `${over.toFixed(1)}× the public cap` : "under the public cap"}</div>
          {a.cost !== undefined && <div className="text-fg2">cost {ethDp(a.cost)}</div>}
          <div className="text-fg2">{short(a.hash)}</div>
        </div>
      )}
    </div>
  );
};
