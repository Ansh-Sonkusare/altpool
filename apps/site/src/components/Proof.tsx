import { Section, Stat, Verdict, cx } from "./ui";
import { FindingCode as M, FindingsTable, SuiteTable, type Finding } from "./ProofTable";
import { ACCURACY, CONFORMANCE, FINDINGS, LIVE_SUITE, SUITE_TXS } from "../proof";

/** One row per finding. Update `status` and `href` here when a finding is filed or fixed. */
export const FINDINGS_LIST: Finding[] = [
  { n: 1, status: "fixed on devnet", title: "Precompiles banned in validation",
    detail: <>Validation could not call precompiles, against ERC-8421 CALLING-040. The devnet team fixed this on Nov 6.</> },
  { n: 2, status: "proposal written", title: "Replacements count as seen",
    detail: <>The sidecar counts a replacement as <M>seen</M>, against REPUTATION-040. In native mode, anyone can fee-bump an unsigned tx to inflate an entity's seen count.</> },
  { n: 3, status: "fixed on devnet", title: "Gateway included count stuck at 0",
    detail: <>The public gateway's <M>included</M> count stayed at 0, so any staked sender was throttled after about 110 sends. Fixed by Nov 7: the gateway counts inclusions again.</> },
  { n: 4, status: "proposal written", title: "Reverted receipt never counts as included",
    detail: <>A <M>Reverted</M> receipt never increments <M>included</M>.</> },
  { n: 5, status: "proposal written", title: "Replay equivalence blames the staked sender",
    detail: "We propose that when an included tx makes the same SENDER call as a pending one, the sidecar drops the pending one silently. Today REPUTATION-330 blames the staked sender for it." },
  { n: 6, status: "proposal written", title: "SIGPARAM replay trap",
    detail: <>A design trap: SIGPARAM returns only the signer, so a validator must also check <M>msg</M>. Otherwise an old signature can be replayed.</> },
  { n: 7, status: "proposal written", title: "Stale max_verify_gas comment in ethrex",
    detail: <>An ethrex comment says the devnet runs a raised <M>max_verify_gas</M>. The public node still enforces 100k: it rejected a Pledge Paid at 600,000 on Nov 7.</> },
  { n: 8, status: "not yet reported (private)", title: "Bypass of both mempools",
    detail: "A way to bypass both mempools. We report it privately, so the details stay off this page." },
  { n: 9, status: "patch ready (not yet filed)", title: "Sidecar admits a tx its own simulation says will revert",
    detail: "The sidecar admits a tx that its own simulation says will revert. A swap-then-transfer batch landed with receipt status reverted, and the sender paid its gas. When a staked payer covers someone else's frames, the sender can force that revert every time." },
  { n: 10, status: "proposal written", title: "Rolled-back batch frame reports success",
    detail: "A rolled-back batch frame reports status success with empty logs. The spec allows this, but no status code says the swap never happened. We propose a distinct rolled-back status." },
  { n: 11, status: "not a bug", title: "Atomic-batch flag on the last frame is rejected",
    detail: "The sidecar rejects the atomic-batch flag on the last frame at submit, as SPEC lines 166 to 172 require. This is not a bug, and a tool can catch it before the send." },
  { n: 12, status: "proposal written", title: "0-ETH sender cannot send top-level value",
    detail: "A 0-ETH sender cannot send top-level frame value, even when an earlier frame funds it. The sidecar checks the sum against the balance at admission. The spec only reverts the frame at execution. This is why the Settler spends its own balance." },
  { n: 13, status: "proposal written", title: "Tornado Verifier cannot run inside VERIFY",
    detail: <>The devnet's Tornado Verifier cannot run inside VERIFY. Its <M>staticcall(sub(gas(), 2000), …)</M> uses <M>GAS</M> where ERC-7562 OP-012 bans it, so our relays call a 15-byte patched copy with the same key.</> },
  { n: 14, status: "proposal written", title: "Gateway did not gossip exits to the miner",
    detail: "On Nov 6 the gateway sidecar admitted exits but did not gossip them to the miner's sidecar, so they never reached a block. We send to the miner's sidecar directly." },
  { n: 15, status: "proposal written", title: "EIP-8037 state gas breaks old withdraw limits",
    detail: "EIP-8037 state gas makes old withdraw limits too low. A withdraw to a fresh account pays 183,600 for the account and 97,920 for the nullifier slot, 281,520 in all, so a 250k state limit runs out of gas." },
];

// The 45 modelled conformance cases. The two misses are the last two cells.
const CONFORMANCE_MISSES = [
  { id: "paymaster", label: "canonical paymaster exemption (devnet sidecar has none)" },
  { id: "opcodes", label: "unassigned opcodes (devnet sidecar allows them)" },
] as const;
const CONFORMANCE_TOTAL = 45;

const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);
const Cross = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);

const H3 = ({ children }: { children: React.ReactNode }) => (
  <h3 className="m-0 text-[20px]/[26px] font-medium text-fg">{children}</h3>
);
const BLOCK = "flex min-w-0 flex-col gap-6 border-t border-ln pt-8";

const Accuracy = () => {
  const rows = SUITE_TXS;
  const match = (r: (typeof rows)[number]) => (r.predicted === "admit") === r.admitted;
  const count = (predicted: "admit" | "reject", admitted: boolean) => rows.filter((r) => r.predicted === predicted && r.admitted === admitted).length;
  const mismatches = rows.filter((r) => !match(r));
  return (
    <div id="proof-accuracy" className={BLOCK}>
      <H3>Accuracy</H3>
      <Stat {...ACCURACY} />
      {rows.length === 0 ? (
        <p className="m-0 text-[15px]/6 font-medium text-warn">Suite not run yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px]/6 text-fg1">
          <li><span className="num">{count("admit", true)}</span> predicted admit, node admitted</li>
          <li><span className="num">{count("reject", false)}</span> predicted reject, node rejected</li>
          <li><span className="num">{count("admit", false)}</span> predicted admit, node rejected</li>
          <li><span className="num">{count("reject", true)}</span> predicted reject, node admitted</li>
          {mismatches.length > 0 && (
            <li>Mismatches: {mismatches.map((r) => r.name).join(", ")}</li>
          )}
        </ul>
      )}
    </div>
  );
};

const Conformance = () => {
  const cells = Array.from({ length: CONFORMANCE_TOTAL }, (_, i) => i);
  const firstMiss = CONFORMANCE_TOTAL - CONFORMANCE_MISSES.length;
  const passCount = firstMiss;
  return (
    <div id="proof-conformance" className={BLOCK}>
      <H3>Conformance</H3>
      <Stat {...CONFORMANCE} />
      <div className="flex flex-col gap-3">
        <ol
          className="m-0 grid list-none grid-cols-[repeat(9,minmax(0,24px))] gap-1 p-0 min-[480px]:grid-cols-[repeat(15,minmax(0,24px))]"
          aria-label={`${passCount} of ${CONFORMANCE_TOTAL} modelled cases pass`}
        >
          {cells.map((i) => {
            const miss = i >= firstMiss;
            return (
              <li
                key={i}
                title={miss ? CONFORMANCE_MISSES[i - firstMiss]!.label : `Case ${i + 1}: pass`}
                className={cx(
                  "flex aspect-square items-center justify-center rounded-md border",
                  miss ? "border-bad/40 bg-badbg text-bad" : "border-okln bg-okbg text-okt",
                )}
              >
                {miss ? <Cross /> : <Check />}
                <span className="sr-only">{miss ? `Case ${i + 1}: miss, ${CONFORMANCE_MISSES[i - firstMiss]!.label}` : `Case ${i + 1}: pass`}</span>
              </li>
            );
          })}
        </ol>
        <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px]/[22px] text-fg2">
          <span className="inline-flex items-center gap-1.5"><span className="text-okt"><Check /></span> pass</span>
          <span className="inline-flex items-center gap-1.5"><span className="text-bad"><Cross /></span> miss</span>
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[15px]/6 font-medium text-fg">The 2 misses</p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {CONFORMANCE_MISSES.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 text-[15px]/6 text-fg1">
              <Verdict kind="reject">miss</Verdict>
              <span>{m.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export const Proof = () => (
  <Section
    id="proof"
    n="01"
    label="Proof"
    title="The simulator is checked against the node."
    lede="Every number here compares a prediction with what a node did. Verdicts from our local rule model stay marked unverified."
  >
    <Accuracy />
    <Conformance />
    <div id="proof-suite" className={BLOCK}>
      <H3>Live devnet suite</H3>
      <Stat {...LIVE_SUITE} />
      <SuiteTable rows={SUITE_TXS.slice(0, 5)} />
      {SUITE_TXS.length > 5 && (
        <details className="group">
          <summary className="cursor-pointer text-[15px]/6 font-medium text-fg underline underline-offset-2 hover:text-acc">Show all {SUITE_TXS.length} cases</summary>
          <div className="pt-4"><SuiteTable rows={SUITE_TXS.slice(5)} /></div>
        </details>
      )}
    </div>
    <div id="findings" className={BLOCK}>
      <H3>Findings</H3>
      <p className="m-0 max-w-[62ch] text-[15px]/6 text-fg1">
        <span className="num">{FINDINGS.filed}</span> of <span className="num">{FINDINGS.total}</span> filed upstream. Each row shows where the finding stands.
      </p>
      <FindingsTable rows={FINDINGS_LIST.slice(0, 5)} />
      <details className="group">
        <summary className="cursor-pointer text-[15px]/6 font-medium text-fg underline underline-offset-2 hover:text-acc">Show all {FINDINGS_LIST.length} findings</summary>
        <div className="pt-4"><FindingsTable rows={FINDINGS_LIST.slice(5)} /></div>
      </details>
    </div>
  </Section>
);
