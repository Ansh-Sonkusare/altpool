// Quick switch: a combobox over our deployed entities that also takes any pasted address, several addresses, or a tx hash.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "@altpool/core";
import { cx } from "../components/ui";
import { isAddress, isHash, KNOWN, lc, short, type NodeChoice } from "./fmt";
import { navigate, queryFor, type Target } from "./route";

interface Option { id: string; label: string; hint: string; target: Target }

export const QuickSwitch = ({ target, node, feeParam }: { target: Target; node: NodeChoice; feeParam: string | null }) => {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState<string>();
  // Pasting an address while on the alerts view keeps you on alerts.
  const addrKind = target.kind === "alerts" ? "alerts" : "entity";

  const options = useMemo<Option[]>(() => {
    const v = text.trim();
    const out: Option[] = [];
    const many = [...new Set(v.split(/[\s,]+/).filter(isAddress))] as Address[];
    if (isHash(v)) out.push({ id: "paste", label: `Open transaction ${short(v)}`, hint: "tx hash", target: { kind: "tx", hash: v as Hex } });
    else if (many.length > 1) out.push({ id: "paste", label: `Compare ${many.length} addresses`, hint: "pasted", target: { kind: "compare", addrs: many.slice(0, 6) } });
    else if (isAddress(v) && !KNOWN[lc(v)]) out.push({ id: "paste", label: `Watch ${short(v)}`, hint: "address", target: { kind: addrKind, addr: v as Address } });
    const q = lc(v);
    for (const [addr, k] of Object.entries(KNOWN))
      if (!q || lc(k.label).includes(q) || addr.includes(q)) out.push({ id: addr, label: k.label, hint: short(addr), target: { kind: addrKind, addr: addr as Address } });
    return out;
  }, [text, addrKind]);

  useEffect(() => setActive(0), [text]);
  // "/" focuses the box from anywhere on the page, like most consoles.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); input.current?.focus(); }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  const go = (o: Option) => {
    navigate(queryFor(o.target, node, feeParam));
    scrollTo({ top: 0 });
    setText(""); setOpen(false); setErr(undefined);
    input.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Escape") { setOpen(false); setErr(undefined); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[active];
      if (o && open) go(o);
      else setErr("Choose an entity, or paste an address (0x and 40 hex digits), several addresses separated by commas, or a transaction hash (0x and 64 hex digits).");
    }
  };

  return (
    <div className="relative min-w-0 flex-1 basis-72">
      <label htmlFor={`${id}-in`} className="sr-only">Switch entity: pick one, or paste an address or transaction hash</label>
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-ln2 bg-s1 pl-3 pr-2 focus-within:border-amberln">
        <input ref={input} id={`${id}-in`} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-invalid={!!err}
          aria-activedescendant={open && options[active] ? `${id}-o${active}` : undefined}
          value={text} onChange={(e) => { setText(e.target.value); setOpen(true); setErr(undefined); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKey}
          spellCheck={false} autoComplete="off" placeholder="Entity, address or tx hash"
          className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-dim" />
        <kbd aria-hidden="true" className="hidden rounded border border-ln2 px-1.5 font-mono text-[11px] text-dim min-[561px]:block">/</kbd>
      </div>
      {open && options.length > 0 && (
        <ul id={`${id}-list`} role="listbox" aria-label="Entities"
          className="absolute inset-x-0 top-[calc(100%+6px)] z-20 m-0 flex max-h-72 list-none flex-col overflow-auto rounded-lg border border-ln2 bg-s1 p-1 shadow-[0_12px_32px_rgba(0,0,0,.5)]">
          {options.map((o, i) => (
            <li key={o.id} id={`${id}-o${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); go(o); }} onMouseEnter={() => setActive(i)}
              className={cx("flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-[14px]", i === active ? "bg-amberbg text-amber" : "text-fg1")}>
              <span className="min-w-0 truncate">{o.label}</span>
              <span className="flex-none font-mono text-[12px] text-fg2">{o.hint}</span>
            </li>
          ))}
        </ul>
      )}
      {open && options.length === 0 && text.trim() && (
        <p className="absolute inset-x-0 top-[calc(100%+6px)] z-20 m-0 rounded-lg border border-ln2 bg-s1 p-3 text-[13px] text-fg2">No known entity matches. Paste a full address or a transaction hash.</p>
      )}
      {err && <p role="alert" className="mt-2 mb-0 font-mono text-[12.5px]/[19px] text-bad">{err}</p>}
    </div>
  );
};
