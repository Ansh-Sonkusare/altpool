import type { EntityReport } from "@altpool/monitor";
import { deployments } from "@altpool/contracts";
import { DEVNET } from "@altpool/core";
import { addrUrl, exitUrl } from "../altpool";
import { EXIT_RELAY } from "../live";
import type { Live } from "../live";
import { recentRuns } from "../pledge";
import { ExtLink, fmt, Section, short, valueOf } from "./ui";

const MARK = "w-5 shrink-0 font-mono";
const LINK = "text-acc underline underline-offset-2";

const List = ({ title, tone, mark, items }: { title: string; tone: string; mark: string; items: React.ReactNode[] }) => (
  <div>
    {title && <h4 className={`mb-3.5 font-mono text-[12px] font-medium tracking-[.08em] ${tone}`}>{title}</h4>}
    <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-[15px]/[23px] text-fg1">
          <span aria-hidden="true" className={`${MARK} ${tone}`}>{mark}</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  </div>
);

export const Why = () => (
  <Section id="limits" n="07" label="Limits" title="What we found, and what this does not do.">
    <div className="flex max-w-[68ch] flex-col gap-3">
      <h3 className="m-0 text-[19px]/[25px] font-medium">Pledge Paid design</h3>
      <p className="m-0 text-[16px]/[26px] text-fg1">
        A withdrawal from a privacy pool normally needs gas in the receiving wallet. Funding that wallet from a known address links it to you. The usual fix is a relayer, one more party who can see, delay or refuse the payment. In Pledge Paid, the staked PayRelayWETH contract sends the transaction and pays its gas, and the withdrawal's fee repays it. The donor's wallet needs no ETH for the payment. The contract pays the gas only after its VERIFY frame checks a zero-knowledge proof. The proof is the permission, so the sponsor needs no account, allowlist or signature. The public mempool cannot carry this transaction. The check reads the pool's storage and needs far more gas than the public validation cap. The alt mempool admits it.
      </p>
    </div>

    <div className="max-w-[68ch]">
      <List title="Limits" tone="text-warn" mark="!" items={[
        <>Pledge Paid is designed to unlink a payment from its deposit. The demo shows the mechanism, not privacy. The pool's crowd is accounts we run on this devnet, and the leaks listed <a href="#pledge" className={LINK}>with the live sender</a> still apply.</>,
        "Before a send, alt verdicts come from our rule model and are marked unverified. The devnet has no alt dry-run.",
        "The proof is Groth16 on the pool's 2019 setup. It is not post-quantum.",
        "The stake is a mempool bond. Nothing slashes it.",
      ]} />
    </div>

    <details className="max-w-[68ch] border-t border-ln pt-5">
      <summary className="flex min-h-11 cursor-pointer items-center font-mono text-[13px] font-medium text-fg">Why ~550k gas of validation is acceptable</summary>
      <div className="pt-3">
        <List title="" tone="text-ok" mark="✓" items={[
          <>The cost is fixed, with no loops. Every payment uses the same VERIFY gas, and the <a href="/monitor" className={LINK}>monitor</a> charts it per inclusion.</>,
          "Cheap checks run before the pairing.",
          "Only the note's own withdrawal, or about 100 later deposits, can invalidate a pending payment.",
          "The relay is staked, so nodes can throttle it.",
          "It removes the relayer, a party who could censor the payment.",
        ]} />
      </div>
    </details>
  </Section>
);


const KV = "flex justify-between gap-3 font-mono text-[13px]";
const FCOL = "flex min-w-0 flex-col gap-2 border-r border-ln px-6 py-6 last:border-r-0 max-[720px]:border-r-0 max-[720px]:border-b max-[720px]:border-ln";
const H5 = "mb-1 font-mono text-[12px] font-medium tracking-[.08em] text-fg2";
const FLINK = "text-acc underline underline-offset-2";

const CONTRACTS: [string, string][] = [
  ["PayRelayWETH", deployments.payRelayWETH],
  ["SettlerFactory", deployments.settlerFactory],
  ["InvoiceBook", deployments.invoiceBook],
  ["WETH pool", deployments.wethPool],
  ["ExitRelay", EXIT_RELAY],
  ["ETH pool", DEVNET.pool],
  ["Staking registry", DEVNET.stakingRegistry],
];

const ContractRows = () => (
  <>
    {CONTRACTS.map(([name, addr]) => (
      <div key={name} className={KV}><span className="text-fg2">{name}</span><ExtLink href={addrUrl(addr as `0x${string}`)} className={FLINK}>{short(addr)}</ExtLink></div>
    ))}
    <div className={KV}><span className="text-fg2">Explorer</span><ExtLink href={DEVNET.explorerUrl} className={FLINK}>{DEVNET.explorerUrl.replace(/^https?:\/\//, "")}</ExtLink></div>
  </>
);

export const Footer = ({ entity }: { entity: Live<EntityReport> }) => {
  const e = valueOf(entity);
  const runs = recentRuns(e).slice(0, 4);
  return (
    <footer className="border-t border-ln2 bg-band">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[1.3fr_1.4fr_1fr] max-[720px]:grid-cols-1">
        <div className={FCOL}>
          <h5 className={H5}>Credits</h5>
          <p className="m-0 text-[15px]/[23px] text-fg1">
            Built on viem and @forshtat/hegota-support, with credit to the devnet workshop, frametx-kit, FrameTx-toolkit, and Nero_eth's "Three Gates to Privacy".
          </p>
          <ExtLink href="https://github.com/Ansh-Sonkusare/altpool" className={`font-mono text-[13px] ${FLINK}`}>github.com/Ansh-Sonkusare/altpool</ExtLink>
        </div>
        <div className={`${FCOL} max-[720px]:hidden`}>
          <h5 className={H5}>Contracts</h5>
          <ContractRows />
        </div>
        <details className={`${FCOL} min-[721px]:hidden`}>
          <summary className="flex min-h-11 cursor-pointer items-center font-mono text-[12px] font-medium tracking-[.08em] text-fg2">Contracts</summary>
          <div className="flex flex-col gap-2 pt-2"><ContractRows /></div>
        </details>
        <div className={FCOL}>
          <h5 className={H5}>Pledge Paid on chain</h5>
          {!e ? (
            <span className="font-mono text-[13px] text-fg2">Reading PayRelayWETH from the sidecar…</span>
          ) : runs.length === 0 ? (
            <span className="font-mono text-[13px] text-fg2">No payments in the sidecar's history yet.</span>
          ) : runs.map((r) => (
            <div key={r.hash} className={KV}>
              <span className="text-fg2">{r.outcome === "reverted" ? "Reverted" : "Paid"}{r.block !== undefined && `, block ${fmt(r.block)}`}</span>
              <ExtLink href={exitUrl(r.hash)} className={FLINK}>{short(r.hash)}</ExtLink>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-ln">
        <div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-3 px-6 py-4 font-mono text-xs text-fg2">
          <span>Altpool · know before you sign · a toolkit for the ERC-8421 alt mempool</span>
          <span>Devnet only, chain 1337.</span>
          <span>ETHGlobal Mumbai 2026 · AI-assisted, disclosed in the README</span>
        </div>
      </div>
    </footer>
  );
};
