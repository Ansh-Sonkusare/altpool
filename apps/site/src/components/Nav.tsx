import { useRef } from "react";
import type { Live } from "../live";
import { cx, Dot, dotFor, fmt } from "./ui";

export interface NavProps { head: Live<number> }

const LINKS: [string, string][] = [["/#proof", "Proof"], ["/#doctor", "frame-doctor"], ["/#pledge", "Pledge Paid"], ["/#install", "Install"], ["/monitor", "Monitor"], ["/wallet", "Wallet"], ["/docs", "Docs"]];

const current = (href: string) => !href.includes("#") && typeof window !== "undefined" && window.location.pathname.replace(/\/$/, "") === href;

export const Nav = ({ head }: NavProps) => {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  const status = head.status === "live" ? `devnet · block ${fmt(head.value)}` : head.status === "error" ? "devnet unreachable" : "devnet · connecting…";
  const link = (href: string, label: string, extra: string) => (
    <a key={href} href={href} onClick={close} aria-current={current(href) ? "page" : undefined} className={cx("text-[14px] hover:text-fg", current(href) ? "text-acc" : "text-fg2", extra)}>{label}</a>
  );

  return (
    <nav aria-label="Sections" className="sticky top-0 z-[5] border-b border-ln2 bg-bg/90 backdrop-blur-[10px]">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-[clamp(20px,5vw,72px)] max-[720px]:py-1.5">
        <a href="/#top" className="flex min-h-11 items-center gap-[9px] text-[15px] font-semibold">
          <i aria-hidden="true" className="grid size-[18px] place-items-center rounded-[5px] border-[1.5px] border-fg after:size-1.5 after:rounded-full after:bg-acc after:content-['']" />
          Altpool
        </a>
        <div className="flex items-center gap-1 max-[720px]:hidden">
          {LINKS.map(([href, label]) => link(href, label, "inline-flex min-h-11 items-center rounded-md px-3"))}
        </div>
        <span className="flex items-center gap-2 font-mono text-[12px] text-fg1 max-[720px]:hidden">
          <Dot state={dotFor(head)} size="sm" />
          <span>{status}</span>
        </span>
        <details
          ref={menu}
          className="group relative min-[721px]:hidden"
          onKeyDown={(e) => { if (e.key === "Escape") { close(); (e.currentTarget.firstElementChild as HTMLElement | null)?.focus(); } }}
        >
          <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-md border border-ln2 px-4 text-[15px] font-medium marker:hidden [&::-webkit-details-marker]:hidden">Menu</summary>
          <div className="absolute top-[calc(100%+8px)] right-0 flex w-[min(280px,calc(100vw-40px))] flex-col rounded-md border border-ln2 bg-s1 p-2">
            {LINKS.map(([href, label]) => link(href, label, "flex min-h-11 items-center rounded-md px-3 text-[15px]"))}
            <span className="mt-1 flex min-h-11 items-center gap-2 border-t border-ln px-3 font-mono text-[12px] text-fg1">
              <Dot state={dotFor(head)} size="sm" />
              <span>{status}</span>
            </span>
          </div>
        </details>
      </div>
    </nav>
  );
};
