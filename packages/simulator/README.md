# @altpool/simulator

Check whether a frame transaction (EIP-8141) will be admitted by the public mempool and by the alt mempool, before you send it. It ships a library, a `frame-doctor` CLI and Vitest matchers.

Not on npm yet. Build and pack it yourself: `bun run --filter @altpool/simulator build`, then `npm pack` in this folder.

## frame-doctor

```sh
frame-doctor <rawTx>          # will each mempool admit this tx?
frame-doctor <txHash>         # what happened to a sent tx?
frame-doctor --fixture <f>    # replay a captured call offline (add --staked)
```

## checkAdmission

```ts
import { checkAdmission } from "@altpool/simulator";

const report = await checkAdmission(rawTxOrFrameTx);
console.log(report.verdicts.alt.verdict);    // "admitted" | "rejected"
console.log(report.verdicts.alt.source);     // who said so: a node, or "model"
console.log(report.verdicts.public.failed?.rule, report.verdicts.public.fix);
```

## Vitest preset

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["@altpool/simulator/vitest-setup"] } });
```

```ts
// tx.test.ts
import { expect, test } from "vitest";
test("my tx is admitted by alt", async () => {
  await expect(tx).toBeAdmittedBy("alt");
  await expect(tx).not.toBeAdmittedBy("public");
});
```

Other matchers: `toBeRejectedFor(mempool, rule)`, `toRouteTo("alt", "miner")`. Pass `{ verified: true }` so only a node's own answer counts.

```yaml
# .github/workflows/admission.yml
jobs:
  admission:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx vitest run
```

## Honest note

Alt-mempool verdicts that come from the local rule model (`source: "model"`) are unverified. Only a verdict from a node is authoritative. The matchers say so in their failure messages.
