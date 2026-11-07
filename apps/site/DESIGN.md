# Design

Replaces the current look. The old look is evidence only: dark void, amber LED glow, hairline frame with crosshair "+" marks, pill buttons, italic serif accent. Product truth, content and functions stay.

## Concept: the test report
Altpool answers "will the node admit this?". The page looks like the document that answers it: a bench report, set dark. Near-black page, light ink, ruled sections, big tabular numerals as the loudest thing on the page, and verdict colours (pass, fail, unverified) used only for verdicts. Code and terminals are framed panels one step above the page. Anyone who has read a lab sheet knows what to trust: the number, the method line under it, the link to the raw data.

Anti-references: neon glow, gradient hero blobs, glass nav pills, card-in-card grids, "feature row" icon lists. Dark is the base, not an effect: no glow anywhere.

Mode per surface: landing = Persuade. Monitor and wallet = Operate. Docs = Read.

## Colour tokens
Replace the whole `@theme` colour block in `src/styles.css`. Tailwind v4 theme: keep `--color-*: initial;` so only these exist. Names marked (renamed) change; units migrate usages in files they own.

Page (dark; the original site's palette, kept on Nov 8 after a short paper-theme trial):
| token | value | use |
|---|---|---|
| `bg` | `#09090b` | page |
| `band` | `#0c0c0f` | alternate section band |
| `s1` | `#0f0f12` | card, input surface |
| `fg` | `#ededef` | headings, numerals |
| `fg1` | `#c9c9d1` | body text |
| `fg2` | `#8b8b94` | secondary text. Minimum for any text |
| `dim` | `#5c5c66` | decorative only (rules, disabled). Never body text |
| `ln` | `rgba(255,255,255,.08)` | hairline |
| `ln2` | `rgba(255,255,255,.14)` | control border, section rule |
| `x` | `rgba(255,255,255,.35)` | marks |
| `acc` | `#f1c98c` | amber: links, active tab, focus ring, primary hover. The only non-semantic colour |
| `accbg` | `rgba(241,201,140,.06)` | selected fill |
| `accln` | `rgba(241,201,140,.45)` | selected border |

Verdict colours (semantic only; never decoration):
| token | value | meaning |
|---|---|---|
| `ok`, `okt` | `#7be0b0`, `#9fd9b8` | admitted, matched, verified source |
| `okbg`, `okln` | `rgba(123,224,176,.08)`, `rgba(123,224,176,.35)` | |
| `bad` | `#f47c7c` | rejected, mismatch, failure |
| `badbg` | `rgba(244,124,124,.1)` | |
| `warn` | `#f5b547` | unverified (model verdict), caution |
| `warnbg`, `warnln` | `rgba(245,181,71,.1)`, `rgba(245,181,71,.4)` | |
| `kw` | `#c3a6ff` | code keyword |

Ink panels (code, terminal, tx dumps) sit one step above the page, with a 1px `inkln` inset edge from the `.ink` rule in styles.css:
| token | value |
|---|---|
| `ink` | `#121216` |
| `ink2` | `#18181d` |
| `inkfg` | `#ededef` |
| `inkdim` | `#8b8b94` |
| `inkln` | `rgba(255,255,255,.1)` |

Syntax tokens (`:root` in styles.css): `--sh-keyword:#c3a6ff; --sh-string:#9fd9b8; --sh-comment:#8a8777; --sh-class/property/entity:#f1c98c; --sh-identifier:#d8d6cc; --sh-sign:#9a9788; --sh-jsxliterals:#f5b547`.

Colour rules:
- Page and ink cover ~90% of every screen. `acc` appears on at most three things per viewport.
- Pass/fail/unverified colours appear only on verdict chips, verdict numerals and Pill. Never as a heading colour or border flourish.
- Remove every hard-coded colour: `text-[#0a0a0c]` becomes `text-bg`; `text-[#b9b9c2]` becomes `text-fg1`; `bg-[#2a2a30]` becomes `bg-inkln`; the `radial-gradient(...rgba(241,201,140...` blobs in App, Monitor, Wallet, Docs are deleted (no glow anywhere); `rgba(21,21,25,.88)` nav fill becomes `bg-bg/90`. Charts (GasChart) and Pipeline use theme tokens, not hex.

## Type
Fonts stay loaded as in `index.html` (Geist 300/400/500/600, Geist Mono 400/500, Instrument Serif regular+italic). No `index.html` change is needed.

| role | font | size / leading | weight | notes |
|---|---|---|---|---|
| proof numeral | Instrument Serif (`font-serif`) | `clamp(64px,11vw,136px)/.9` | 400 | tabular-nums, `-0.02em`. The loudest element |
| display (h1) | Geist | `clamp(44px,7vw,84px)/.98` | 500 | `-0.035em`. One serif-italic word allowed: "sign." |
| h2 | Geist | `clamp(30px,4vw,48px)/1.08` | 500 | `-0.025em`, `text-balance` |
| h3 | Geist | `20px/26px` | 500 | |
| lede | Geist | `18px/28px` | 400 | `text-fg1`, max 62ch |
| body | Geist | `16px/26px` | 400 | `text-fg1`, max 68ch |
| small | Geist | `14px/22px` | 400 | `text-fg2` |
| label | Geist Mono | `12px/16px` | 500 | uppercase, `tracking-[.08em]` (was .12em), `text-fg2` |
| data | Geist Mono | `13px/20px` | 400 | `tabular-nums`; hashes, addresses, verdicts |

Weight 300 is dropped from headings. Body min 15px on mobile, labels min 12px. Never wrap a heading in a thin italic for emphasis except the one hero word.

## Layout and spacing
Scale (px): 4, 8, 12, 16, 24, 32, 48, 72, 112. Use only these as gaps and paddings (Tailwind: `1, 2, 3, 4, 6, 8, 12, 18, 28`; use arbitrary values `[72px]`, `[112px]` where needed).

- Page: no outer frame, no `border-x`, no crosshair marks. Content column `mx-auto max-w-[1200px] px-[clamp(20px,5vw,72px)]`. Bands (`band`) run full viewport width; their content stays in the column.
- Section: `py-[clamp(64px,9vw,112px)]`, top border `1px solid ln2`. Left gutter label (see `SectionHead`): at ≥960px a 2-column grid, `160px` label column (number + name in mono label style) and the content column; below 960px the label stacks above.
- Cards: `rounded-md` (6px), `border-ln2`, `bg-s1`, no shadow. No card inside a card: inner groupings use a top hairline and spacing.
- Radius: 6px for cards, inputs, buttons and chips. `rounded-full` only for the live Dot and status Pill.
- Density: Operate pages (monitor, wallet) use 12/16 gaps and 13–14px type. Persuade page uses 48–112.
- Mobile first at 390px: single column, 20px gutters, tap targets ≥44px, no horizontal scroll (tables become stacked rows under 720px).

## Components (in `ui.tsx`, contract for every unit)
Existing, restyled in place: `Section`, `Card`, `CardBar`, `Eyebrow`, `Pill`, `Dot`, `Facts/Fact`, `Kvl`, `ExtLink`, helpers (`short`, `fmt`, `cx`, `valueOf`...). Signatures do not change except where noted.

New, added by the tokens unit:
- `Btn({ href?, onClick?, variant: "solid" | "line", children })`: renders `<a>` when `href` else `<button>`. 44px min height, `rounded-md`, 15px/500. `solid` = `bg-fg text-bg`, hover `bg-acc text-bg`. `line` = `border-ln2 text-fg`, hover `border-fg`.
- `SectionHead({ n, label, title, lede? })`: the gutter label + h2 + lede block. `n` is "01"…"09".
- `Stat({ value, label, method, href?, state? })`: serif proof numeral, a label, a one-line method, an optional evidence link. `state`: `"ok" | "unverified" | "pending"`. When `value` is a `{PLACEHOLDER}` token string it renders with dashed `border-warnln` and the text "pending" in `text-warn` so it can never read as a real number.
- `Verdict({ kind: "admit" | "reject" | "unverified", children })`: chip. admit = ok colours with "✓"; reject = bad with "✕"; unverified = warn with "?". Always icon + text, never colour alone.
- `InkPanel({ title?, children, className? })`: `bg-ink text-inkfg rounded-md`, header strip with `inkln` border and the three window dots in `bg-inkln`; replaces `Card`+`CardBar windowDots` for code, terminal and tx dumps.
- `TxLink({ hash, label? })`: mono short hash linking to the explorer URL with `?node=`; reuses `exitUrl` from `src/altpool.ts`.
`Section` gains `n`/`label` props passed through to `SectionHead` only if given; existing callers keep working until their unit migrates.

## Motion rules
- Motion only states a change: a live feed row arriving (`animate-pop`, ≤ 700ms), the live Dot (`animate-bl`), a verdict chip swapping (opacity, 120ms). Nothing animates on scroll. No parallax, no count-up: numbers are true at first paint.
- Durations 120ms (hover, press), 200ms (disclosure). Easing `ease-out`. Transition only `color, background-color, border-color, opacity, transform`.
- `prefers-reduced-motion` handling already in styles.css stays.
- Skeletons are static hairline rows, no shimmer.

## Accessibility floor
- Text contrast ≥ 4.5:1 on its surface; `dim` never carries text. Verdicts use icon + word + colour.
- Focus ring: `2px solid acc`, offset 2px, on the page and on ink (on ink panels use `outline-color: inkfg`).
- Mobile nav is reachable: see Nav in REDESIGN-SPEC (the current nav hides every link under 720px).
- Landmarks: one `h1` per page, `nav`, `main`, `footer`. Tabs keep `role="tab"` semantics. Live regions stay `aria-live="polite"`.
- Link text names its target ("Open tx 0x12ab…ef90 on the explorer"), not "here".

## styles.css file changes (exact)
1. Header comment: `/* Dark test-report look: near-black page, light ink, amber accent, verdict colours only for verdicts, framed panels for code. */`.
2. `@theme`: replace colour tokens with the tables above (keep `--color-*: initial;`). Keep the three `--font-*` lines and `--animate-bl`, `--animate-pop`. Add `--radius-md: 6px;` and `--breakpoint-*` untouched.
3. `:root` sh tokens: new values above.
4. `@layer base`: `body` has no side padding and gets `background: var(--color-bg); color: var(--color-fg)`; `:root { color-scheme: dark; }`; `:focus-visible` uses `var(--color-acc)`; `.ink :focus-visible { outline-color: var(--color-inkfg); }`; `.ink { box-shadow: inset 0 0 0 1px var(--color-inkln); }`; `a:hover` stays.
5. Delete `@utility crosshair`.
6. Add `@utility num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }` and `@utility proof { font-family: var(--font-serif); font-variant-numeric: lining-nums tabular-nums; letter-spacing: -.02em; line-height: .9; }`.
7. There is no `tailwind.config`: Tailwind v4 reads `@theme` from styles.css. No other config file changes.
