import type { Live } from "../live";
import { Dot, dotFor, fmt, valueOf } from "./ui";

export interface HeroProps {
  head: Live<number>;
}

const btn = "inline-flex min-h-11 items-center gap-2 rounded-full px-5 py-[11px] text-[15px]";
const btnSolid = `${btn} bg-fg font-medium text-[#0a0a0c] hover:bg-white hover:text-[#0a0a0c]`;
const btnOutline = `${btn} border border-ln2 font-normal text-fg2 hover:border-white/30 hover:text-fg`;

const GET: readonly (readonly [string, string])[] = [
  ["SDK", "Build, simulate and send frame transactions from viem."],
  ["frame-doctor", "Check whether the public and the alt mempool admit a transaction. If one rejects it, it names the rule and the fix."],
  ["Monitor", "Watch a staked entity's stake, reputation and how many sends it has left."],
  ["MCP server", "Give an AI agent the same checks."],
];

export const Hero = ({ head }: HeroProps) => {
  const block = valueOf(head);
  return (
    <header id="top" className="relative flex flex-col gap-11 px-14 pt-[88px] pb-20 max-[960px]:px-6 max-[960px]:py-16">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,.85fr)] items-end gap-12 max-[960px]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-7">
          <span className="inline-flex w-max max-w-full items-center gap-2.5 rounded-full border border-ln2 px-3 py-1.5 font-mono text-[12px] text-fg2">
            <Dot state={dotFor(head)} />
            {block === undefined ? "Connecting to the EIP-8141 devnet" : `Live on the EIP-8141 devnet, block ${fmt(block)}`}
          </span>
          <h1 className="m-0 text-[clamp(52px,8vw,88px)]/none font-light tracking-[-.03em] text-balance">
            Know before you <span className="font-serif font-normal tracking-[-.01em] italic">sign.</span>
          </h1>
        </div>
        <div className="flex flex-col gap-7">
          <p className="text-[18px]/[28px] text-[#b9b9c2]">
            Altpool is a viem toolkit for the ERC-8421 alternative mempool, where frame transactions can validate with more gas and read more state than the public mempool allows.
          </p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0 text-[15px]/[22px] text-fg1">
            {GET.map(([tool, what]) => (
              <li key={tool} className="grid grid-cols-[132px_minmax(0,1fr)] max-[480px]:grid-cols-[minmax(0,1fr)] max-[480px]:gap-1 gap-3 border-t border-ln pt-3">
                <span className="text-[15px] font-medium text-amber">{tool}</span>
                <span>{what}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2.5">
            <a href="#pledge" className={btnSolid}>Send one live</a>
            <a href="#doctor" className={btnOutline}>Run frame-doctor</a>
          </div>
        </div>
      </div>
    </header>
  );
};
