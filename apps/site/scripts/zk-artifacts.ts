// bun scripts/zk-artifacts.ts: gzip the prover's circuit and proving key into public/zk, so the page downloads ~11.5 MB on any host.
// Needs packages/prover/artifacts (bun run --filter @altpool/prover fetch); the .gz outputs are committed so a deploy does not.
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const from = new URL("../../../packages/prover/artifacts/", import.meta.url);
const to = new URL("../public/zk/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const f of ["withdraw.json", "withdraw_proving_key.bin"]) {
  const gz = gzipSync(readFileSync(new URL(f, from)), { level: 9 });
  writeFileSync(new URL(`${f}.gz`, to), gz);
  console.log(`${f}.gz ${(gz.length / 1e6).toFixed(1)} MB`);
}
