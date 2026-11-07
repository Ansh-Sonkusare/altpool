import type { Live } from "../live";
import { ProofStrip } from "./ProofStrip";
import { Btn, Dot, dotFor, fmt, InkPanel, valueOf, Verdict } from "./ui";

export interface HeroProps {
  head: Live<number>;
}

const CheckCard = () => (
  <InkPanel title="frame-doctor: example, double-spend">
    <div className="flex flex-col gap-3 p-4 text-[14px]/[22px]">
      <div className="flex flex-wrap items-center gap-2">
        <Verdict kind="reject">rejected by both mempools</Verdict>
        <span className="font-mono text-[13px] text-inkdim">rule nullifier-spent</span>
      </div>
      <p className="m-0 text-inkfg">The newest ExitRelay exit, sent again. Its note is already withdrawn.</p>
      <p className="m-0 text-inkfg">
        <span className="font-mono text-inkdim">fix </span>
        Use a note that is not spent. The relay's VERIFY rejects a spent note, so it can never be paid twice.
      </p>
      <a href="#doctor" className="font-mono text-[13px] text-inkfg underline underline-offset-4">Run it live</a>
    </div>
  </InkPanel>
);

export const Hero = ({ head }: HeroProps) => {
  const block = valueOf(head);
  return (
    <header id="top" className="relative flex flex-col gap-14 px-[clamp(24px,8vw,128px)] pt-20 pb-16 max-[960px]:gap-10 max-[960px]:pt-10 max-[960px]:pb-12">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)] items-start gap-12 max-[960px]:grid-cols-[minmax(0,1fr)]">
        <div className="flex flex-col gap-7">
          <span className="inline-flex w-max max-w-full items-center gap-2.5 rounded-md border border-ln2 px-3 py-1.5 font-mono text-[12px] text-fg2">
            <Dot state={dotFor(head)} />
            {block === undefined ? "Connecting to the EIP-8141 devnet" : `Live on the EIP-8141 devnet, block ${fmt(block)}`}
          </span>
          <h1 className="m-0 text-[clamp(48px,7vw,88px)]/none font-semibold tracking-[-.03em] text-balance">
            Know before you <span className="font-serif font-normal tracking-[-.01em] italic">sign.</span>
          </h1>
          <p className="m-0 max-w-[60ch] text-[18px]/[28px] text-fg1">
            Altpool is a developer toolkit for the ERC-8421 alt mempool. It predicts whether a node will admit a frame transaction, and names the rule when it will not.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Btn href="#doctor" variant="solid">Run frame-doctor</Btn>
            <Btn href="#proof" variant="line">See the proof</Btn>
          </div>
          <p className="m-0 font-mono text-[13px]/5 text-fg2">SDK · admission simulator · frame-doctor · monitor · MCP · Vitest preset</p>
        </div>
        <div className="max-[960px]:order-last max-[960px]:hidden">
          <CheckCard />
        </div>
      </div>
      <ProofStrip />
      <div className="hidden max-[960px]:block">
        <CheckCard />
      </div>
    </header>
  );
};
