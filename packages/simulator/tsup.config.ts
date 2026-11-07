import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    rules: "src/rules.ts",
    conformance: "src/conformance.ts",
    vitest: "src/vitest.ts",
    "vitest-setup": "src/vitest-setup.ts",
    "frame-doctor": "src/frame-doctor.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { resolve: true, compilerOptions: { baseUrl: ".", paths: { "viem/*": ["../../node_modules/viem/*"], "viem": ["../../node_modules/viem/_types/index.d.ts"], "@altpool/core": ["../core/src/index.ts"] } }, entry: ["src/index.ts", "src/rules.ts", "src/conformance.ts", "src/vitest.ts", "src/vitest-setup.ts"] },
  clean: true,
  noExternal: ["@altpool/core"],
  external: ["vitest"],
  // tsup keeps the source shebang (tsx); replace it with node for the bin.
  esbuildOptions(o) { o.banner = {}; },
  onSuccess: "node -e \"const f='dist/frame-doctor.js',fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/^#!.*\\n/,'#!/usr/bin/env node\\n'));fs.chmodSync(f,0o755)\"",
});
