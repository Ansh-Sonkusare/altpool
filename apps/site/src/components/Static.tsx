import type { EntityReport } from "@altpool/monitor";
import { deployments } from "@altpool/contracts";
import { DEVNET } from "@altpool/core";
import { addrUrl, exitUrl } from "../altpool";
import { EXIT_RELAY } from "../live";
import type { Live } from "../live";
import { recentRuns } from "../pledge";
import { Card, Eyebrow, ExtLink, fmt, Section, short, valueOf } from "./ui";

const AREA_TAG = "font-mono text-[11px] uppercase tracking-[.12em] text-amber";
const MARK = "w-5 shrink-0 font-mono";

const List = ({ title, tone, mark, items }: { title: string; tone: string; mark?: string; items: React.ReactNode[] }) => (
  <div>
    <h4 className={`mb-3.5 font-mono text-[11px] font-normal tracking-[.12em] ${tone}`}>{title}</h4>
    <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm/[22px] text-fg1">
          <span aria-hidden="true" className={`${MARK} ${mark ? tone : "text-xs text-fg2"}`}>{mark ?? String(i + 1).padStart(2, "0")}</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  </div>
);

const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono text-fg">{children}</span>;

export const Why = () => (
  <Section id="findings">
    <div className="flex flex-col gap-4">
      <Eyebrow>Why it matters</Eyebrow>
      <h2 className="text-balance text-[clamp(36px,5vw,56px)]/[1.07] font-light tracking-[-.03em]">
        A payment from a privacy pool that needs no <span className="font-serif font-normal italic tracking-[-.01em] text-amber">relayer.</span>
      </h2>
    </div>

    <div className="grid grid-cols-2 gap-10 max-[720px]:grid-cols-1">
      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-[19px]/[25px] font-medium">Pay from an empty wallet, with no relayer</h3>
        <p className="m-0 max-w-[560px] text-[16px]/[26px] text-fg1">
          A withdrawal from a privacy pool normally needs gas in the receiving wallet. Funding that wallet from a known address links it to you. The usual fix is a relayer, which is one more party who can see, delay or refuse the payment. Pledge Paid sends the whole payment from a wallet that holds 0 ETH. No relayer and no gas transfer is involved.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-[19px]/[25px] font-medium">Sponsored, proof-gated transactions</h3>
        <p className="m-0 max-w-[560px] text-[16px]/[26px] text-fg1">
          A staked contract pays the gas, but only after its VERIFY frame has checked a zero-knowledge proof. The proof is the permission, so nobody needs an account, an allowlist or a signature from the sponsor. The public mempool cannot carry this, because the check costs about 375k gas and reads the pool's storage. The alt mempool can.
        </p>
      </div>
    </div>

    <h3 className="m-0 mt-4 text-[22px]/[28px] font-light tracking-[-.01em]">How it maps to the three prize areas</h3>
    <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 1</span>
        <h3 className="text-[19px]/[25px] font-medium">Something only the alt mempool makes possible</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">verification budget higher than 100k … more flexible state access</q>
        <p className="text-[15px]/[23px] text-fg1">The relay's VERIFY frame runs a Groth16 check of about 375k gas, pinned at {DEVNET.verifyGasMax / 1000n}k, and reads the pool's storage. The public mempool caps validation at 100k and bars that read.</p>
        <a href="#pledge" className="mt-auto text-sm text-amber">See Pledge Paid →</a>
      </Card>
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 2</span>
        <h3 className="text-[19px]/[25px] font-medium">Developer tooling</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">a viem/ethers SDK … an admission simulator, mempool monitoring</q>
        <p className="text-[15px]/[23px] text-fg1">Altpool is those three: the SDK, checkAdmission with frame-doctor, and watchEntity.</p>
        <a href="#doctor" className="mt-auto text-sm text-amber">Run it →</a>
      </Card>
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 3</span>
        <h3 className="text-[19px]/[25px] font-medium">Break the rules and improve them</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">DoS vectors and vulnerabilities, new rules, simulators …</q>
        <p className="text-[15px]/[23px] text-fg1">Building both transactions surfaced eight devnet findings, listed below.</p>
      </Card>
    </div>

    <div className="grid grid-cols-2 gap-10 border-t border-ln pt-7 max-[720px]:grid-cols-1">
      <List title="WHAT THE TOOLS SURFACED" tone="text-bad" items={[
        <>The devnet's verifier uses the <Mono>GAS</Mono> opcode, banned in validation by ERC-7562 OP-012. We call a 15-byte patched copy with the same key. The pool re-verifies with the original.</>,
        "The gateway sidecar admitted exits but did not gossip them to the block builder's sidecar.",
        "The gateway's included count stays at 0, so a busy entity is throttled after about 110 sends.",
        "The withdraw frame ran out of state gas at 250k. EIP-8037 prices a new account at 183,600 and a new storage slot at 97,920.",
        "The sidecar admits a tx that its own simulation says will revert. A swap-then-transfer batch landed with receipt status reverted, and the sender paid its own gas. When a staked payer covers someone else's frames, the sender can force that revert every time.",
        "A rolled-back batch frame reports status success with empty logs. The spec allows it, but no status code says the swap never happened. We propose a distinct rolled-back status.",
        "The atomic-batch flag on the last frame is rejected at submit, as SPEC lines 166 to 172 require. No report needed, and a tool can catch it before sending.",
        "A 0-ETH sender cannot send top-level frame value, even when an earlier frame funds it. The sidecar checks the sum against the balance at admission, while the spec only reverts the frame at execution. This is why the Settler contract spends its own balance.",
      ]} />
      <div className="flex flex-col gap-10">
        <List title="WHY ~375K OF VALIDATION IS ACCEPTABLE" tone="text-ok" mark="✓" items={[
          "Fixed cost, no loops: the same gas on every exit (see the monitor above).",
          "Cheap checks run before the pairing.",
          "Only the note's own withdrawal or about 100 deposits can invalidate a pending exit.",
          "The relay is staked, so nodes can throttle it.",
          "It removes the relayer, the one party who could censor.",
        ]} />
        <List title="HONEST LIMITS" tone="text-warn" mark="!" items={[
          "This proves the mechanism, not privacy yet. On the devnet we seeded the pool's crowd ourselves.",
          "Alt verdicts before sending come from our rule model and are labelled unverified. The devnet has no alt dry-run.",
          "Groth16 with the pool's 2019 setup, not post-quantum.",
          "The stake is a mempool bond and is never slashed.",
        ]} />
      </div>
    </div>
  </Section>
);


const KV = "flex justify-between gap-3 font-mono text-[13px]";
const FCOL = "flex min-w-0 flex-col gap-2 border-r border-ln px-6 py-7 last:border-r-0 max-[720px]:border-r-0 max-[720px]:border-b max-[720px]:border-ln";
const H5 = "mb-1 font-mono text-[11px] font-normal tracking-[.12em] text-fg2";

const CONTRACTS: [string, string][] = [
  ["PayRelayWETH", deployments.payRelayWETH],
  ["SettlerFactory", deployments.settlerFactory],
  ["InvoiceBook", deployments.invoiceBook],
  ["WETH pool", deployments.wethPool],
  ["ExitRelay", EXIT_RELAY],
  ["ETH pool", DEVNET.pool],
  ["Staking registry", DEVNET.stakingRegistry],
];

export const Footer = ({ entity }: { entity: Live<EntityReport> }) => {
  const e = valueOf(entity);
  const runs = recentRuns(e).slice(0, 4);
  return (
    <footer className="border-t border-ln">
      <div className="grid grid-cols-[1.3fr_1.4fr_1fr] max-[720px]:grid-cols-1">
        <div className={FCOL}>
          <h5 className={H5}>CREDITS</h5>
          <p className="text-[15px]/[23px] text-[#b9b9c2]">
            Built on viem and @forshtat/hegota-support, with credit to the devnet workshop, frametx-kit, FrameTx-toolkit, and Nero_eth's “Three Gates to Privacy”.
          </p>
          <ExtLink href="https://github.com/Ansh-Sonkusare/altpool" className="font-mono text-[13px] text-amber">github.com/Ansh-Sonkusare/altpool</ExtLink>
        </div>
        <div className={FCOL}>
          <h5 className={H5}>CONTRACTS</h5>
          {CONTRACTS.map(([name, addr]) => (
            <div key={name} className={KV}><span className="text-fg2">{name}</span><ExtLink href={addrUrl(addr as `0x${string}`)} className="text-amber">{short(addr)}</ExtLink></div>
          ))}
          <div className={KV}><span className="text-fg2">Explorer</span><ExtLink href={DEVNET.explorerUrl} className="text-amber">{DEVNET.explorerUrl.replace(/^https?:\/\//, "")}</ExtLink></div>
        </div>
        <div className={FCOL}>
          <h5 className={H5}>PLEDGE PAID ON CHAIN</h5>
          {!e ? (
            <span className="font-mono text-[13px] text-fg2">Reading PayRelayWETH from the sidecar…</span>
          ) : runs.length === 0 ? (
            <span className="font-mono text-[13px] text-fg2">No payments in the sidecar's history yet.</span>
          ) : runs.map((r) => (
            <div key={r.hash} className={KV}>
              <span className="text-fg2">{r.outcome === "reverted" ? "Reverted" : "Paid"}{r.block !== undefined && `, block ${fmt(r.block)}`}</span>
              <ExtLink href={exitUrl(r.hash)} className="text-amber">{short(r.hash)}</ExtLink>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap justify-between gap-3 border-t border-ln px-6 py-4 font-mono text-xs text-fg2">
        <span>Altpool · ERC-8421 alternative mempool toolkit</span>
        <span>ETHGlobal Mumbai 2026 · AI-assisted, disclosed in the README</span>
      </div>
    </footer>
  );
};
