# Vendored conformance vectors

`erc-8421/*.json` and `erc-8421-descriptor.json` are copied unmodified from
[4w44h9jckz-boop/exp-mempool-l2s](https://github.com/4w44h9jckz-boop/exp-mempool-l2s) at commit `d1a57c681b907`
(`conformance/vectors/erc-8421/` and `docs/spec/descriptors/erc-8421.json`), under the Apache License 2.0
(`LICENSE` in this folder). They are hand-written expected behaviour for the ERC-8421 rule set.

`bun run --filter @altpool/simulator conformance` plays them against our local rule model (`src/model.ts`) and reports,
per case, whether we agree, differ, or don't model that rule. Do not edit the vectors; a disagreement is a finding
about our model or about the devnet's rules, never a reason to change a vector.
