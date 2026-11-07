# Product

## One line
Altpool: know before you sign. A developer toolkit for the ERC-8421 alt mempool.

## What it is
One product with five parts, all aimed at one question: "Will a node admit this frame transaction, and if not, which rule stops it?"

- SDK: build, simulate and send frame transactions from viem.
- Admission simulator and frame-doctor: `checkAdmission(tx)` and a CLI. Names the rule, the entity, the frame and the fix.
- Monitor: a staked entity's stake, reputation and sends left before throttling.
- MCP server: the same checks for an AI agent.
- Vitest preset: assert admission verdicts in a project's tests.

Pledge Paid is the showcase transaction the toolkit checks: a 9-frame transaction (privacy-pool withdraw, unwrap, Uniswap v4 swap, invoice settle, sweep, check). It is evidence the toolkit handles a hard case. It is not a second product.

Also built, shown as one line each and not as headline items: ExitRelay exit, Falcon wallets, Wallet Bridge.

## Audience
1. EF alt-mempool and EIP-8141 devs, and hackathon judges. They know the spec. They want to see that predictions match the node, and that we found real spec and node issues. They will click tx links and read the numbers.
2. Wallet and dApp devs who will send frame transactions. They want an install command, a working snippet, and a clear rejection message.

Secondary: AI agents reading `/llms.txt` and `/docs`.

## Job of the site
Persuade a skeptical reader in one scroll that the toolkit is accurate, then let them try it. Proof comes before explanation. Every claim links to its evidence (a tx, a fixture, a filed issue, a test).

## Voice
- Plain, short sentences. Evidence first. Numbers beat adjectives.
- Say what happened, with the count and the link. Do not say "powerful", "seamless", "revolutionary".
- Name the rule (for example REPUTATION-040) instead of describing it vaguely.
- No prize-track language on the page.

## Honesty constraints (non-negotiable)
- Privacy is "designed to", never "is". The demo pool's crowd is accounts we run. The demo shows the mechanism, not privacy.
- Any verdict from the local rule model is labelled `unverified`. The devnet has no alt dry-run. Only the node's simulation and the sidecar's admission record are verified sources.
- Headline accuracy is "prediction vs node outcome" on the stated suite. State the suite size and what counts as a match next to the number. Never round up.
- Conformance is "43 of 45 modelled cases". Say what the two misses are.
- The stake is a mempool bond. Nothing slashes it.
- Groth16 on the 2019 pool setup is not post-quantum.
- Numbers that are not yet produced render as a visible placeholder in design review, never as an invented value. Placeholders: {ACCURACY}, {CONFORMANCE}, {LIVE_SUITE}, {PLEDGE_TX}, {FILED}.
- Devnet only, chain 1337. Say so in the footer and in the monitor.

## What we will not do
Three product names. A prize-area mapping section. Describing a feature the page does not show.

## Success
A judge can, within 60 seconds and without scrolling past the proof band: read the accuracy number, see its method, click a tx on the explorer, and run frame-doctor once.
