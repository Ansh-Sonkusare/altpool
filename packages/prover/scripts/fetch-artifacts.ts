// Download tornado-core release v2.0 circuit assets (the key baked into the devnet Verifier) and pin their sha256.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../artifacts", import.meta.url));
const BASE = "https://github.com/tornadocash/tornado-core/releases/download/v2.0/";
const ASSETS: Record<string, string> = {
  "withdraw.json": "8ee950ce8476ce7d43aa4f3c2243adc446e17f00ce0a05935f7462e31af3b2bc",
  "withdraw_proving_key.bin": "95a7024dfd37e9e872762487c32d6534e0bc298e13f07a2bec1b9f6a1d57a5c9",
  "withdraw_verification_key.json": "a29cdf7c8c0285454c1b91794e8127b4a32a0a41ccf1f58578a85f5ab5896ac4",
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

mkdirSync(DIR, { recursive: true });
for (const [name, want] of Object.entries(ASSETS)) {
  const path = join(DIR, name);
  if (existsSync(path) && sha256(readFileSync(path)) === want) {
    console.log(`ok   ${name}`);
    continue;
  }
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== want) throw new Error(`${name}: sha256 ${got} != ${want}`);
  writeFileSync(path, bytes);
  console.log(`got  ${name} (${bytes.length} B)`);
}
