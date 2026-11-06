import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Vite stubs Node builtins with empty modules. websnark needs a real "assert". circomlib reaches for "stream" (via blake-hash)
// and "events" (via web3-utils) only for code paths we do not use, so those two get small shims (src/liveExit).
const assert = fileURLToPath(new URL("src/liveExit/assert.cjs", import.meta.url));
const web3Utils = fileURLToPath(new URL("src/liveExit/web3-utils.ts", import.meta.url));
const blakeHash = fileURLToPath(new URL("src/liveExit/blake-hash.cjs", import.meta.url));

export default defineConfig({ plugins: [react(), tailwindcss()], resolve: { alias: [{ find: /^assert$/, replacement: assert }, { find: /^blake-hash$/, replacement: blakeHash }, { find: /^web3-utils$/, replacement: web3Utils }] } });
