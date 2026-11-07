// Usage: node ../../scripts/pack-swap.mjs pre|post  (run from a package dir)
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const backup = ".package.src.json";
if (process.argv[2] === "pre") {
  copyFileSync("package.json", backup);
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  Object.assign(p, p.publishConfig);
  delete p.publishConfig;
  delete p.devDependencies; // dev-only (workspace:* is not publishable)
  delete p.scripts.prepack;
  delete p.scripts.postpack;
  writeFileSync("package.json", JSON.stringify(p, null, 2));
} else {
  renameSync(backup, "package.json");
}
