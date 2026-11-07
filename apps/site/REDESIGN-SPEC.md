# Redesign spec: "Altpool: know before you sign"

> Colours in this spec describe the paper-theme trial. The site went back to its original dark palette on Nov 8; `DESIGN.md` holds the current tokens. Layout, sections and copy in this spec still apply.

Read PRODUCT.md and DESIGN.md first. Mode: landing = Persuade, monitor/wallet = Operate, docs = Read.

## 1. Critique of the current site

Captured with the managed Chromium via the browser tool on https://altpool.vercel.app/ (live, Nov 7). Screenshots (local, regenerate if /tmp is cleared):
- `/tmp/altpool-shots/home-d-fold.png` (1440×900, above the fold)
- `/tmp/altpool-shots/home-d-full.png` (1440 wide, full page; document height 11,894 px)
- `/tmp/altpool-shots/home-m-fold.png` (390×844, above the fold)
- `/tmp/altpool-shots/home-m-full.png` (390 wide, full page; document height 23,284 px)
The tool also visited /monitor, /wallet and /docs at 1440 but its screenshot path option did not write files for those, so their notes below come from reading `Monitor.tsx`, `Wallet.tsx`, `Docs.tsx`. Only the two home-page folds were viewed as images; the full-page images were captured but not inspected in detail, so findings about lower sections come from the source.

Problems, most costly first.

**Story order and focus**
1. The first section after the hero is `LivePledge`: a form that sends a real 9-frame payment. A visitor is asked to act before any evidence exists that the toolkit is right. The proof (findings, the accuracy of the simulator) sits at the very bottom in `Why`.
2. The product is described as three things: "Pledge Paid" (nav item 1 and both hero CTAs), "frame-doctor" (nav item 3), and "Altpool toolkit". The nav spends its first slot on the showcase transaction. This is the split-story failure the post-mortem named.
3. Hero offers four tools in a text list (SDK, frame-doctor, Monitor, MCP). There is no number, no verdict, no tx link in the first viewport. The headline is a slogan with no evidence behind it.
4. `Why` maps the work to "three prize areas" with quotes from the prize text. That is for judges of a prize, not for a developer; it also takes the page's final persuasion slot.
5. `Why` then lists fifteen findings as one 15-item two-column list, followed by two more lists. It is a wall: no status (filed / fixed / private), no link per finding, no ordering by importance.
6. `Codebase` ends with a 3-column grid of every package card. It lists nine-plus pieces and dilutes "one toolkit". This belongs in docs.
7. ExitRelay, Falcon wallets and Wallet Bridge are not on the landing page except as footer contract addresses and a Wallet link. They are "also built" and need one honest line each.

**Density and length**
8. Landing is 11.9k px tall on desktop and 23.3k px on mobile (about 28 phone screens). Each section opens with a 36–56px light heading, a paragraph, then a nested card, tabs and sub-cards: three levels of hierarchy inside a section.
9. Cards inside bands inside a framed column: nesting of borders (frame, section rule, card, card bar) makes every region look equally important.

**Type**
10. Headings are weight 300 at 36–88px on near-black. Light weight at large size is elegant but gives no anchor; the largest type on the page is a slogan, not a fact. The italic serif "sign." is used once and not reinforced anywhere.
11. `text-dim` (#5c5c66 on #09090b, about 3:1) is used for readable text such as package paths in `Codebase`. It fails 4.5:1.
12. Eyebrows use 12px mono at `.12em` tracking and are repeated on every section; they carry no information (e.g. "Why it matters", "Use it").

**Colour**
13. Dark void plus an amber LED glow (hero radial gradient in `App.tsx`, repeated in Monitor, Wallet, Docs) is the stock "crypto dev tool" look. Amber is also the colour of the `unverified` pill and of links, so the one colour that must mean "do not trust this verdict" is also the link colour. Pass/fail meaning is diluted.
14. Hard-coded hex values bypass the token file: `#0a0a0c`, `#b9b9c2`, `#2a2a30`, `rgba(21,21,25,.88)` and the glow gradient (24 occurrences across 15 files), so a palette change cannot be done in `styles.css` alone.

**Motion**
15. Motion is minimal (dot blink, row pop) and respects reduced-motion, which is good. There is no motion that explains state: running a check shows a spinner-less "running…" string.

**Accessibility**
16. Nav: links are `max-[720px]:hidden` with no replacement. At 390px the only things in the nav are the logo and the devnet status. A mobile visitor cannot reach /monitor, /wallet, /docs or any section from the nav (seen in `home-m-fold.png`).
17. Nav has 8 links plus a status pill in one `flex-wrap` capsule; at 1440 it fits, at ~800 it wraps to two rows.
18. Positive: focus ring exists, tabs have roles, live regions exist, inputs are labelled. Keep these.

**Mobile**
19. Hero on 390px: badge, h1, paragraph, then four stacked tool rows push the CTA buttons below the first screen. Nothing evidential is visible without three screens of scrolling.
20. Footer's three-column grid collapses to a single column with 7 contract rows plus runs, adding another ~2 screens.

**Monitor, Wallet, Docs**
21. Monitor: the h1 is 22px; the header carries the entity switcher, sidecar toggle and 5 tabs in one block with an amber glow. It reads as a page title with no summary of "sends left", the number a developer opened the page for.
22. Wallet: four numbered steps with identical weight; step 1's lead is a MetaMask warning paragraph, which is the first thing read. Good function, wrong first impression.
23. Docs: strong content (TOC, recipes, agent links) but it shares the landing page's glow header and light 56px h1, and the MCP install code block is the first interactive element.

What to keep: the live devnet badge, the live frame-doctor, the Pledge frame rail, the SDK snippet, the tabs-with-pipeline idea, the honest `unverified` labelling, the focus/aria work, the monitor.

## 2. Contract shared by all units

New data module (owned by unit U1): `src/proof.ts` exports

```ts
export type ProofState = "ok" | "unverified" | "pending";
export interface ProofStat { value: string; label: string; method: string; href?: string; state: ProofState }
export const ACCURACY: ProofStat;     // value "{ACCURACY}" until the number exists
export const CONFORMANCE: ProofStat;  // value "{CONFORMANCE}"; target text "43 of 45"
export const LIVE_SUITE: ProofStat;   // value "{LIVE_SUITE}"
export const FINDINGS: { total: number; filed: string /* "{FILED}" until known */ };
export const PLEDGE_TX: { hash?: `0x${string}`; placeholder: "{PLEDGE_TX}" };
export const SUITE_TXS: { name: string; hash: `0x${string}`; admitted: boolean; predicted: "admit" | "reject"; outcome: "included" | "rejected" | "reverted" }[]; // empty until the live suite exists
```
The integrator replaces the placeholder strings with measured values. While a value is a `{...}` token, `Stat` renders it as "pending" in warn colours (DESIGN.md). Nothing may hard-code an accuracy figure outside `proof.ts`. Conformance wording on the page is fixed: "43 of 45 modelled cases" (from PRODUCT.md) once `CONFORMANCE.state` is `"ok"`.

`ui.tsx` exports added by U0: `Btn`, `SectionHead`, `Stat`, `Verdict`, `InkPanel`, `TxLink` (signatures in DESIGN.md). Units import them; U0 must land first.

Rename: `amber*` → `acc*` (token classes `text-amber`, `bg-amberbg`, `border-amberln`, `border-amberln`...) in every file a unit owns. `text-dim` is not used for text. Hard-coded colours removed as listed in DESIGN.md.

Anchors (stable, used by nav and cross-links): `#top`, `#proof`, `#findings` (the findings table inside Proof), `#doctor`, `#pledge`, `#toolkit`, `#install`, `#also`, `#limits`.

## 3. New landing: section by section

Order and purpose. The whole page should be ≈ 8–9 desktop screens (down from ~13) and ≈ 14 mobile screens (down from ~28).

### 0. Nav (all pages)
Source: `Nav.tsx`. Keep the devnet block badge. Links: `Proof`, `frame-doctor`, `Pledge Paid`, `Install`, `Monitor`, `Wallet`, `Docs`. Cut "Toolkit" and "Why it matters" as top-level links (reachable by scrolling and the in-page links). Style: a full-width bar on paper, 1px bottom rule, sticky, `bg-bg/90 backdrop-blur`, wordmark left, links centre, status right. Under 720px: a `<details>` menu button ("Menu", ≥44px) that opens a vertical list of all links plus the status line; closes on link click. Keyboard: Esc closes. Active page link gets `aria-current="page"` and `text-acc`.

### 1. Hero `#top`
Source: `Hero.tsx` (rewrite layout, keep `HeroProps` and the live badge logic).
Purpose: say the one thing, show one verdict, show the proof numbers within the first viewport.
Layout desktop: left column h1 + lede + two buttons; right column a compact live check card (an `InkPanel`) showing one frame-doctor result as static markup fed by the Doctor's preset example (reject with rule name and fix) so the visitor sees a verdict before scrolling. Below, full width, the ProofStrip (4 stats).
Mobile: h1, lede, buttons, then ProofStrip stacked 2×2. The check card moves below the strip.
Exact new copy:
- Badge (kept): `Live on the EIP-8141 devnet, block {n}` / `Connecting to the EIP-8141 devnet`.
- h1: `Know before you sign.` (serif italic only on "sign.").
- Lede: `Altpool is a developer toolkit for the ERC-8421 alt mempool. It predicts whether a node will admit a frame transaction, and names the rule when it will not.`
- One-line toolkit list under the buttons, mono, single line wrapping: `SDK · admission simulator · frame-doctor · monitor · MCP · Vitest preset`.
- Primary `Btn solid`: `Run frame-doctor` → `#doctor`. Secondary `Btn line`: `See the proof` → `#proof`.
Cut: the 4-row tool list with descriptions (moves into Toolkit), the amber glow, the "Send a Pledge Paid" CTA (demoted to section 4).

### 1b. ProofStrip (inside the hero band)
Source: new `components/ProofStrip.tsx` reading `proof.ts`. Four `Stat`s, hairline-separated, no cards:
1. `{ACCURACY}` · label `Prediction matches node outcome` · method line from `ACCURACY.method`, e.g. `on N transactions, simulator verdict vs what the node did`.
2. `{CONFORMANCE}` · `Modelled rule cases pass` · `43 of 45 modelled cases; the 2 misses are listed in the proof section`.
3. `{LIVE_SUITE}` · `Live devnet suite` · `each row links to its tx on the explorer`.
4. `{FILED}` · `Findings filed upstream` · `of 15 found while building`.
Each links to its place in `#proof`. Placeholders render as pending (never as numbers).

### 2. Proof `#proof`
Source: new `components/Proof.tsx` (+ `ProofTable.tsx`), data from `proof.ts`. Purpose: let a skeptic audit the claims.
`SectionHead n="01" label="Proof" title="The simulator is checked against the node."` Lede: `Every number here compares a prediction with what a node did. Verdicts from our local rule model stay marked unverified.`
Blocks, top to bottom:
a. Accuracy: large serif `{ACCURACY}`, then method (suite size, what counts as a match, date). A confusion list under it: predicted admit / node admitted; predicted reject / node rejected; mismatches named with rule id.
b. Conformance: `{CONFORMANCE}` with the 45 cases as a compact grid of squares (✓ ok, ✕ bad with icon), the two misses listed by rule id and reason.
c. Live suite: table (`ProofTable`) of `SUITE_TXS`: name, predicted verdict (Verdict chip), node outcome (Verdict chip), `TxLink`. Stacked rows under 720px. Empty state: `Suite not run yet.` in warn text.
d. Findings (replaces the 15-item list from `Static.tsx`): a table of the 15 with columns `#`, `finding`, `status` (fixed / filed / private / not a bug), link when filed. Content migrates from `Why`'s array; keep each sentence as-is. U2 declares a `findings` array inside `Proof.tsx` and sets each status from the issue links the integrator provides. `proof.ts` only holds the stat objects.

### 3. frame-doctor `#doctor`
Source: `Doctor.tsx` and `components/doctor/*`. Move here (was section 4). Keep behaviour. `SectionHead n="02" label="frame-doctor" title="Paste a transaction. Get a verdict and a fix."` Lede: keep the existing paragraph's content but cut it to: `checkAdmission(tx) says whether the public mempool and the alt mempool admit a frame transaction. Each verdict names its source: the node's simulation, the sidecar's admission record, or our local rule model, marked unverified.` Result panes become `InkPanel`; the verdict header uses `Verdict`. Preset buttons become a segmented row of `Btn line`.

### 4. Pledge Paid `#pledge`
Source: `components/frames/*` (rail) for the showcase and `LivePledge.tsx` + `Crowd.tsx` + `livePledge/{parts,revert}.tsx` for the send-it-yourself part. Purpose: the showcase transaction the toolkit checks, not a second product.
`SectionHead n="03" label="Showcase transaction" title="Pledge Paid: nine frames, one transaction."` Lede (new): `Withdraw from a privacy pool, unwrap, swap on Uniswap v4, settle an invoice, sweep, and check, all in one frame transaction. The toolkit checked it before it was sent, and the chain included it.` Then:
- PledgeFrames rail with each of the 9 frames and, per frame, the toolkit's verdict and the gas it predicted vs used (existing model data).
- A `TxLink` row: `Included on devnet: {PLEDGE_TX}` (hash from `PLEDGE_TX`, placeholder until known).
- Disclosure `<details>` (closed by default): `Send one yourself` containing the existing LivePledge form and Crowd. Honest limit sentence stays: `Pledge Paid is designed to unlink a payment from its deposit. The demo shows the mechanism, not privacy.`
Cut: the long `h2` "Pay an invoice from shielded funds, in one transaction. Send it yourself." and any copy that sells the payment as a product; the demo no longer opens the page.

### 5. Toolkit `#toolkit`
Source: `Codebase.tsx`, `components/toolkit/*`. `SectionHead n="04" label="Toolkit" title="Five tools, one check."` Keep the pipeline strip + tabs (SDK, frame-doctor, monitor, MCP) and add a fifth tab `Vitest preset` (snippet from `docs/reference.md`; the engineer copies the real preset name from there). Cut the "Every package" card grid; replace with one line: `Every package, with API and recipes: /docs` linking `/docs`. Strip and panels restyled per DESIGN.md.

### 6. Install `#install`
Source: `Install.tsx`. `SectionHead n="05" label="Install" title="An admitted frame transaction, from viem."`. Keep the three steps (Install, Send, MCP) but as a single column of three `InkPanel`s with the lead text above each; two columns at ≥1100px. Copy unchanged except the heading numbering. Add the Vitest preset line after step 3 only if the toolkit tab shows it.

### 7. Also built `#also`
Source: new `components/AlsoBuilt.tsx` (new). `SectionHead n="06" label="Also built" title="Three more things we built on the same rails."` Three plain rows (no cards), each: name, one sentence, link.
- `ExitRelay`: `A staked relay that exits a privacy-pool note to a fresh address with no relayer.` link to `/#pledge`? No: link `ExtLink` to the repo path of ExitRelay (engineer greps `packages/` for the path).
- `Falcon wallets`: `Accounts whose VERIFY frame checks a post-quantum Falcon signature.` link to the repo path (engineer greps `packages/`; if no path exists, write no link).
- `Wallet Bridge`: `Sign frame transactions with a browser wallet through EIP-712.` → `/wallet`.
Honesty: describe only what the code does; if unsure, copy the sentence from the package README.

### 8. Limits `#limits`
Source: `Static.tsx` (`Why` rewritten, `Footer` restyled). `SectionHead n="07" label="Limits" title="What we found, and what this does not do."` Keep: the two paragraphs "Designed to pay with no ETH and no relayer" and "Sponsored, proof-gated transactions" compressed into one shared paragraph under a `Pledge Paid design` h3; keep `Limits` list verbatim (4 items) with `!` marks; move the "Why 550k gas of validation is acceptable" list into `/docs` (do not delete: the engineer pastes it as a new `## Why 550k gas of validation is acceptable` section into a note sent to the docs owner; if no docs owner is available, leave it here collapsed in a `<details>`). Delete the "three prize areas" grid and the 15-item list (now in Proof).

### 9. Footer
Source: `Static.tsx` `Footer`. Keep credits, contracts and the Pledge Paid on-chain list; restyle with tokens, add `Devnet only, chain 1337.`; contracts list collapses in a `<details>` on mobile. Replace the tagline: `Altpool · know before you sign · a toolkit for the ERC-8421 alt mempool`.

## 4. Other pages

### Monitor (`/monitor`) — Operate
- Header: h1 `Monitor` at 32px with a one-line purpose `Stake, reputation and sends left before throttling.`; entity switcher and sidecar toggle on one row; tabs keep position, but get 44px height, `acc` underline for active. Remove glow.
- Entity view leads with the number `sends left` as a `Stat`-style numeral (serif is not used in Operate; use `num` mono 40px) with the throttle threshold under it.
- Alerts, Compare, Tx, Network: token migration, `rounded-md`, no new features. Tables stack under 720px.
- Footer link text `Back to the toolkit` → `Back to Altpool`, href `/`.
- GasChart/Pipeline use theme tokens; no hex.

### Wallet (`/wallet`) — Operate
- Header: eyebrow `packages/wallet-bridge` stays; h1 `Your browser wallet, sending frame transactions.`, lede kept. Add a status row above the steps: wallet connected? account chosen? session active? as three `Pill`s so the state is visible without reading steps.
- The MetaMask "Localhost 8545" warning moves from step 1's lead into an inline `Verdict kind="unverified"`-style notice only shown when the connected chain id is 1337 but the RPC is not the devnet (if the code cannot detect that, keep it as a collapsed `<details>` under step 1).
- Step headers get the number as a mono label, not a circle. Buttons use `Btn`.

### Docs (`/docs`) — Read
- Header: drop glow; h1 `Build with every package, without opening the repo.` at DESIGN type; agent links row kept; MCP code block as `InkPanel`.
- TOC sidebar keeps behaviour; active section highlighting added if trivial (`IntersectionObserver` on headings); mobile `<details>` kept.
- Reading column max 68ch for prose; code blocks full column width as `InkPanel`.

## 5. Work units (file-disjoint)

`src/docs/reference.md`, `public/llms*.txt`, `index.html`, `src/live.ts` are owned by the copy worker and are frozen for these units. Frozen logic files nobody edits: `src/altpool.ts`, `src/pledge.ts`, `src/hooks.ts`, `src/frames.ts`, `src/main.tsx`, `src/crowd/chain.ts`, `src/liveExit/*`, `src/livePledge/{inputs,inputs.check,invoices,plan,presets,quote,recover,run,steps,why}.ts`, `src/monitor/{fmt,hooks,route}.ts`, `src/wallet/bridge.ts`, `scripts/*`, `server/*`. Do not touch `scripts/crowd.ts` or `packages/contracts/src/flow.ts`.

Order: U0 first; U1–U11 in parallel afterwards. U2 and U5 import only the types from `proof.ts`, so they can start once U1 has written that file.

| Unit | Owns (≤5 files) | Notes |
|---|---|---|
| **U0 tokens + shell** | `src/styles.css`, `src/components/ui.tsx`, `src/components/Nav.tsx`, `src/App.tsx`, `src/components/Code.tsx` | Tokens per DESIGN.md; new ui exports; nav with mobile menu; App wires the new section order and removes the glow div and the `border-x` frame: order Nav, Hero, Proof, Doctor, LivePledge+frames showcase, Codebase, Install, AlsoBuilt, Why, Footer. Imports `Proof` and `AlsoBuilt` (new files from U2, U8) and `ProofStrip` (U1 via Hero). Code.tsx → `InkPanel` styling and sh tokens |
| **U1 hero + proof data** | `src/components/Hero.tsx`, `src/components/ProofStrip.tsx` (new), `src/proof.ts` (new) | Section 3.1/1b. `proof.ts` per contract |
| **U2 proof section** | `src/components/Proof.tsx` (new), `src/components/ProofTable.tsx` (new) | Section 3.2; owns the findings array and statuses |
| **U3 doctor A** | `src/components/Doctor.tsx`, `src/components/doctor/UseIt.tsx`, `doctor/gapOf.ts`, `doctor/paint.ts`, `doctor/RuleGrid.tsx` | Section 3.3 |
| **U4 doctor B** | `doctor/Terminal.tsx`, `doctor/follow.ts`, `doctor/Frames.tsx`, `doctor/Gap.tsx`, `doctor/Panes.tsx` (all under `src/components/`) | InkPanel + Verdict; keep logic |
| **U5 pledge showcase** | `src/components/frames/PledgeFrames.tsx`, `frames/FrameDetail.tsx`, `frames/FrameRail.tsx`, `frames/Legend.tsx`, `frames/model.ts` | Section 3.4 top half: per-frame verdict + predicted vs used gas, `PLEDGE_TX` TxLink row, 9-frame story |
| **U6 pledge send-yourself** | `src/components/LivePledge.tsx`, `src/components/Crowd.tsx`, `src/livePledge/parts.tsx`, `src/livePledge/revert.tsx` | Section 3.4 bottom half: wraps form + Crowd in a closed `<details>`; new short intro; token migration |
| **U7 toolkit** | `src/components/Codebase.tsx`, `components/toolkit/Pipeline.tsx`, `toolkit/panels.tsx`, `toolkit/usePipeline.ts` | Section 3.5; fifth tab; cut package grid |
| **U8 install, also built, limits, footer** | `src/components/Install.tsx`, `src/components/Static.tsx`, `src/components/AlsoBuilt.tsx` (new) | Sections 3.6–3.9 |
| **U9 monitor A** | `src/monitor/Monitor.tsx`, `monitor/Entity.tsx`, `monitor/Alerts.tsx`, `monitor/Activity.tsx`, `monitor/Compare.tsx` | Section 4 Monitor |
| **U10 monitor B** | `src/monitor/Tx.tsx`, `monitor/Network.tsx`, `monitor/GasChart.tsx`, `monitor/parts.tsx`, `monitor/Switcher.tsx` | Tokens, hex removal, stacked tables |
| **U11 wallet + docs** | `src/wallet/Wallet.tsx`, `src/docs/Docs.tsx` | Section 4 Wallet and Docs |

Coverage check: every file under `src/components/` (Static, Install, Nav, Codebase, Code, ui, Hero, LivePledge, Crowd, Doctor, doctor/*, toolkit/*, frames/*) is owned once above; pages `App.tsx`, `monitor/*.tsx`, `wallet/Wallet.tsx`, `docs/Docs.tsx` are owned once; `livePledge/parts.tsx` and `revert.tsx` are components and owned by U6. Frozen `.ts` logic files are in the list above and have no owner.

### Acceptance per unit (check in a browser at 1440 and 390; no horizontal scroll at 390; no console errors)
- **U0**: Page background is paper `#f5f2ea` with ink text; no `border-x` frame, no crosshair "+", no glow. Nav shows 7 links at 1440; at 390 a "Menu" button opens a list with all links and the devnet status, Esc closes it, tap targets ≥ 44px. `Btn`, `Stat`, `SectionHead`, `Verdict`, `InkPanel`, `TxLink` exist and a `Stat value="{ACCURACY}"` renders as dashed "pending". Tab focus ring is visibly blue. `grep -r "amber" src` in U0 files returns nothing. Section order on `/` matches section 3. Code blocks render as dark ink panels.
- **U1**: In the first 900px at 1440 the visitor sees h1, lede, two buttons and the four proof stats. At 390 the buttons are visible without scrolling past one screen after the h1. Stats show "pending" while `proof.ts` values are placeholders and real values after the integrator replaces them. h1 reads "Know before you sign." Badge shows the live block number.
- **U2**: `/#proof` shows accuracy numeral + method, a 45-cell conformance grid with the 2 misses listed, a live suite table with working explorer links (explorer URL has `?node=`), and a 15-row findings table with a status per row. At 390 the tables are stacked rows. Empty suite shows "Suite not run yet.".
- **U3**: Doctor appears right after Proof. Pasting a tx hash or clicking a preset produces a verdict chip with icon+word, source label (`unverified` for model verdicts), and the fix. Input and Run button reach 44px height; preset row wraps at 390.
- **U4**: Terminal, Panes, Gap, Frames and Gap views use ink panels; contrast of every text ≥ 4.5:1 (check with devtools); verdicts never rely on colour alone.
- **U5**: The rail shows nine frames labelled in order (privacy-pool withdraw, unwrap, swap, invoice settle, sweep, check, …per `model.ts`), each with a verdict chip; selecting a frame shows detail; a "Included on devnet" row shows the `PLEDGE_TX` link or the pending placeholder. Rail is scrollable and operable by keyboard at 390.
- **U6**: The send form is inside a closed `<details>` titled "Send one yourself"; opening it shows the previous form working end to end (existing behaviour unchanged); the privacy-limit sentence is visible; no h2 about "Pay an invoice from shielded funds".
- **U7**: Toolkit shows five tabs including Vitest preset; tab keyboard behaviour works (existing roles kept); the package card grid is gone and a `/docs` link is present; strip colours come from tokens.
- **U8**: Install shows three steps in ink panels with copy buttons working; Also built shows three rows with ExitRelay, Falcon wallets and Wallet Bridge; Limits shows the four limit items; no "prize areas" text anywhere on `/`; footer shows `Devnet only, chain 1337.`; footer contracts collapse at 390.
- **U9**: Monitor header shows h1 + purpose line; entity view leads with sends-left numeral; tabs are 44px tall and show active state with blue underline; page has no glow; keyboard navigates tabs.
- **U10**: Tx, Network, GasChart, Switcher render with no hex colours (inspect: chart colours resolve from theme variables); tables stack under 720px; contrast ≥ 4.5:1.
- **U11**: Wallet has the three status pills and unchanged function (connect, account, mode A, mode B still work); Docs header has no glow, the MCP block is an ink panel, TOC works on desktop and the mobile `<details>`; prose line length ≤ 68ch.

Integrator check after all units: `bun run typecheck` and the site build, then re-capture the screenshots listed in section 1 (desktop and mobile) once, and confirm the landing height is below 9,500 px desktop and 16,000 px mobile (targets, not yet measured). Replace `proof.ts` placeholders `{ACCURACY}`, `{CONFORMANCE}`, `{LIVE_SUITE}`, `{PLEDGE_TX}`, `{FILED}` with measured values and links.
