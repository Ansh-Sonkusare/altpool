import type { Live } from "../live";
import { Dot, dotFor, fmt } from "./ui";

export interface NavProps { head: Live<number> }

const LINKS: [string, string][] = [["/#pledge", "Send Pledge Paid"], ["/#toolkit", "Toolkit"], ["/#doctor", "frame-doctor"], ["/#install", "Install"], ["/#findings", "Why it matters"], ["/monitor", "Monitor"], ["/wallet", "Wallet"], ["/docs", "Docs"]];

export const Nav = ({ head }: NavProps) => (
  <div className="sticky top-0 z-[5] flex justify-center pt-4">
    <nav aria-label="Sections" className="flex flex-wrap items-center justify-center gap-1 rounded-full border border-ln2 bg-[rgba(21,21,25,.88)] py-1.5 pr-1.5 pl-[18px] backdrop-blur-[10px]">
      <a href="/#top" className="mr-3.5 flex items-center gap-[9px] text-[15px] font-semibold">
        <i aria-hidden="true" className="grid size-[18px] place-items-center rounded-[5px] border-[1.5px] border-fg after:size-1.5 after:rounded-full after:bg-amber after:content-['']" />
        Altpool
      </a>
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className="rounded-full px-3 py-2 text-[14px] text-fg2 hover:text-fg max-[720px]:hidden">{label}</a>
      ))}
      <span className="ml-1.5 flex items-center gap-2 rounded-full border border-ln2 bg-bg px-3.5 py-2 font-mono text-[12px] text-fg1">
        <Dot state={dotFor(head)} size="sm" />
        <span>{head.status === "live" ? `devnet · block ${fmt(head.value)}` : head.status === "error" ? "devnet unreachable" : "devnet · connecting…"}</span>
      </span>
    </nav>
  </div>
);
