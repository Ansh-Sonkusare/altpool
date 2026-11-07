// "Also built": three things on the same rails, one honest line each. Sentences follow the package READMEs and the contract header.
import { ExtLink, Section } from "./ui";

const REPO = "https://github.com/Ansh-Sonkusare/altpool";

const ROWS: { name: string; text: string; href: string; label: string; external: boolean }[] = [
  {
    name: "ExitRelay",
    text: "A staked relay that exits a privacy-pool note to a fresh address with no relayer.",
    href: `${REPO}/blob/main/packages/contracts/src/ExitRelay.sol`,
    label: "ExitRelay.sol",
    external: true,
  },
  {
    name: "Falcon wallets",
    text: "Accounts whose VERIFY frame checks a post-quantum Falcon-512 signature.",
    href: `${REPO}/tree/main/packages/falcon`,
    label: "packages/falcon",
    external: true,
  },
  {
    name: "Wallet Bridge",
    text: "Sign frame transactions with a browser wallet through EIP-712.",
    href: "/wallet",
    label: "Open /wallet",
    external: false,
  },
];

const LINK = "inline-flex min-h-11 items-center font-mono text-[13px] text-acc underline underline-offset-2 hover:text-fg";

export const AlsoBuilt = () => (
  <Section id="also" n="06" label="Also built" title="Three more things we built on the same rails.">
    <ul className="m-0 flex list-none flex-col p-0">
      {ROWS.map((r) => (
        <li key={r.name} className="grid items-baseline gap-x-8 gap-y-1 border-t border-ln py-5 first:border-t-0 min-[960px]:grid-cols-[200px_minmax(0,1fr)_auto]">
          <h3 className="m-0 text-[19px]/[25px] font-medium">{r.name}</h3>
          <p className="m-0 max-w-[62ch] text-[16px]/[26px] text-fg1">{r.text}</p>
          {r.external ? <ExtLink href={r.href} className={LINK}>{r.label} ↗</ExtLink> : <a href={r.href} className={LINK}>{r.label} →</a>}
        </li>
      ))}
    </ul>
  </Section>
);
