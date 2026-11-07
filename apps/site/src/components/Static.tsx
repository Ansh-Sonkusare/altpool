import type { EntityReport } from "@altpool/monitor";
import { deployments } from "@altpool/contracts";
import { DEVNET } from "@altpool/core";
import { addrUrl, exitUrl } from "../altpool";
import { EXIT_RELAY } from "../live";
import type { Live } from "../live";
import { recentRuns } from "../pledge";
import { Card, Eyebrow, ExtLink, fmt, Section, short, valueOf } from "./ui";

const AREA_TAG = "font-mono text-[11px] tracking-[.12em] text-amber";
const MARK = "w-5 shrink-0 font-mono";

const List = ({ title, tone, mark, items, cols }: { title: string; tone: string; mark?: string; items: React.ReactNode[]; cols?: boolean }) => (
  <div>
    <h4 className={`mb-3.5 font-mono text-[11px] font-normal tracking-[.12em] ${tone}`}>{title}</h4>
    <ul className={cols ? "m-0 grid list-none grid-cols-2 gap-x-10 gap-y-3.5 p-0 max-[720px]:grid-cols-1" : "m-0 flex list-none flex-col gap-3.5 p-0"}>
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-sm/[22px] text-fg1">
          <span aria-hidden="true" className={`${MARK} ${mark ? tone : "text-xs text-fg2"}`}>{mark ?? String(i + 1)}</span>
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
        A payment from a privacy pool that needs no relayer.
      </h2>
    </div>

    <div className="grid grid-cols-2 gap-10 max-[720px]:grid-cols-1">
      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-[19px]/[25px] font-medium">Pay with no ETH and no relayer</h3>
        <p className="m-0 max-w-[560px] text-[16px]/[26px] text-fg1">
          A withdrawal from a privacy pool normally needs gas in the receiving wallet. Funding that wallet from a known address links it to you. The usual fix is a relayer, one more party who can see, delay or refuse the payment. In Pledge Paid, the staked PayRelayWETH contract sends the transaction and pays its gas, and the withdrawal's fee repays it. The donor's wallet needs no ETH for the payment.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="m-0 text-[19px]/[25px] font-medium">Sponsored, proof-gated transactions</h3>
        <p className="m-0 max-w-[560px] text-[16px]/[26px] text-fg1">
          A staked contract pays the gas, but only after its VERIFY frame checks a zero-knowledge proof. The proof is the permission, so the sponsor needs no account, allowlist or signature. The public mempool cannot carry this transaction. The check reads the pool's storage and needs far more gas than the public validation cap. The alt mempool admits it.
        </p>
      </div>
    </div>

    <h3 className="m-0 mt-4 text-[22px]/[28px] font-light tracking-[-.01em]">How it maps to the three prize areas</h3>
    <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 1</span>
        <h3 className="text-[19px]/[25px] font-medium">Something only the alt mempool makes possible</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">verification budget higher than 100k … more flexible state access</q>
        <p className="text-[15px]/[23px] text-fg1">PayRelayWETH's VERIFY frame runs a Groth16 check that uses 550,095 gas under its 600k limit, and it reads the pool's storage. With the deadline frame, the validation prefix may use 610,000 gas. The public mempool caps the prefix at 100k gas and bars the storage read.</p>
        <a href="#pledge" className="mt-auto text-sm text-amber">See Pledge Paid →</a>
      </Card>
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 2</span>
        <h3 className="text-[19px]/[25px] font-medium">Developer tooling</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">a viem/ethers SDK … an admission simulator, mempool monitoring</q>
        <p className="text-[15px]/[23px] text-fg1">Altpool has all three: the SDK, checkAdmission with its frame-doctor CLI, and watchEntity. An MCP server gives an AI agent the same checks.</p>
        <a href="#doctor" className="mt-auto text-sm text-amber">Run frame-doctor →</a>
      </Card>
      <Card className="flex flex-col gap-3 p-6">
        <span className={AREA_TAG}>Area 3</span>
        <h3 className="text-[19px]/[25px] font-medium">Break the rules and improve them</h3>
        <q className="font-serif text-[18px]/[24px] text-fg2 italic">DoS vectors and vulnerabilities, new rules, simulators …</q>
        <p className="text-[15px]/[23px] text-fg1">Building these transactions led to the fifteen findings below. Findings 1 and 3 are now fixed on the devnet.</p>
      </Card>
    </div>

    <div className="flex flex-col gap-10 border-t border-ln pt-7">
      <List cols title="What we found on the devnet" tone="text-bad" items={[
        <>Validation could not call precompiles, against ERC-8421 CALLING-040. The devnet team fixed this on Nov 6.</>,
        <>The sidecar counts a replacement as <Mono>seen</Mono>, against REPUTATION-040. In native mode, anyone can fee-bump an unsigned tx to inflate an entity's seen count.</>,
        <>The public gateway's <Mono>included</Mono> count stayed at 0, so any staked sender was throttled after about 110 sends. Fixed by Nov 7: the gateway counts inclusions again.</>,
        <>A <Mono>Reverted</Mono> receipt never increments <Mono>included</Mono>.</>,
        "We propose that when an included tx makes the same SENDER call as a pending one, the sidecar drops the pending one silently. Today REPUTATION-330 blames the staked sender for it.",
        <>A design trap: SIGPARAM returns only the signer, so a validator must also check <Mono>msg</Mono>. Otherwise an old signature can be replayed.</>,
        <>An ethrex comment says the devnet runs a raised <Mono>max_verify_gas</Mono>. The public node still enforces 100k: it rejected a Pledge Paid at 600,000 on Nov 7.</>,
        "A way to bypass both mempools. We report it privately, so the details stay off this page.",
        "The sidecar admits a tx that its own simulation says will revert. A swap-then-transfer batch landed with receipt status reverted, and the sender paid its gas. When a staked payer covers someone else's frames, the sender can force that revert every time.",
        "A rolled-back batch frame reports status success with empty logs. The spec allows this, but no status code says the swap never happened. We propose a distinct rolled-back status.",
        "The sidecar rejects the atomic-batch flag on the last frame at submit, as SPEC lines 166 to 172 require. This is not a bug, and a tool can catch it before the send.",
        "A 0-ETH sender cannot send top-level frame value, even when an earlier frame funds it. The sidecar checks the sum against the balance at admission. The spec only reverts the frame at execution. This is why the Settler spends its own balance.",
        <>The devnet's Tornado Verifier cannot run inside VERIFY. Its <Mono>staticcall(sub(gas(), 2000), …)</Mono> uses <Mono>GAS</Mono> where ERC-7562 OP-012 bans it, so our relays call a 15-byte patched copy with the same key.</>,
        "On Nov 6 the gateway sidecar admitted exits but did not gossip them to the miner's sidecar, so they never reached a block. We send to the miner's sidecar directly.",
        "EIP-8037 state gas makes old withdraw limits too low. A withdraw to a fresh account pays 183,600 for the account and 97,920 for the nullifier slot, 281,520 in all, so a 250k state limit runs out of gas.",
      ]} />
      <div className="grid grid-cols-2 gap-10 max-[720px]:grid-cols-1">
        <List title="Why 550k gas of validation is acceptable" tone="text-ok" mark="✓" items={[
          <>The cost is fixed, with no loops. Every payment uses the same VERIFY gas, and the <a href="/monitor" className="text-amber">monitor</a> charts it per inclusion.</>,
          "Cheap checks run before the pairing.",
          "Only the note's own withdrawal, or about 100 later deposits, can invalidate a pending payment.",
          "The relay is staked, so nodes can throttle it.",
          "It removes the relayer, a party who could censor the payment.",
        ]} />
        <List title="Limits" tone="text-warn" mark="!" items={[
          <>Pledge Paid is designed to unlink a payment from its deposit. The demo shows the mechanism, not privacy. The pool's crowd is accounts we run on this devnet, and the leaks listed <a href="#pledge" className="text-amber">with the live sender</a> still apply.</>,
          "Before a send, alt verdicts come from our rule model and are marked unverified. The devnet has no alt dry-run.",
          "The proof is Groth16 on the pool's 2019 setup. It is not post-quantum.",
          "The stake is a mempool bond. Nothing slashes it.",
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
          <h5 className={H5}>Credits</h5>
          <p className="text-[15px]/[23px] text-[#b9b9c2]">
            Built on viem and @forshtat/hegota-support, with credit to the devnet workshop, frametx-kit, FrameTx-toolkit, and Nero_eth's "Three Gates to Privacy".
          </p>
          <ExtLink href="https://github.com/Ansh-Sonkusare/altpool" className="font-mono text-[13px] text-amber">github.com/Ansh-Sonkusare/altpool</ExtLink>
        </div>
        <div className={FCOL}>
          <h5 className={H5}>Contracts</h5>
          {CONTRACTS.map(([name, addr]) => (
            <div key={name} className={KV}><span className="text-fg2">{name}</span><ExtLink href={addrUrl(addr as `0x${string}`)} className="text-amber">{short(addr)}</ExtLink></div>
          ))}
          <div className={KV}><span className="text-fg2">Explorer</span><ExtLink href={DEVNET.explorerUrl} className="text-amber">{DEVNET.explorerUrl.replace(/^https?:\/\//, "")}</ExtLink></div>
        </div>
        <div className={FCOL}>
          <h5 className={H5}>Pledge Paid on chain</h5>
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
        <span>Altpool · a toolkit for the ERC-8421 alt mempool</span>
        <span>ETHGlobal Mumbai 2026 · AI-assisted, disclosed in the README</span>
      </div>
    </footer>
  );
};
