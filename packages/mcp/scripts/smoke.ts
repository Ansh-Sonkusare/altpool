// Live check: spawn the server over stdio and exercise all three tools against the devnet. Exits non-zero on mismatch.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, parseAbi, toHex, type Address, type Hex } from "viem";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet } from "@altpool/core";
import { EXIT_FEE, deployments, exitTx } from "@altpool/contracts";

const INCLUDED = "0x5659d8d238f2fd83ea5969640811ea8cd7b40f1d874c2874bcf11c89f48d8493";
const EXIT_RELAY = deployments.exitRelay as Address;

let bad = 0;
const expect = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) bad++; };

const client = new Client({ name: "altpool-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "bun", args: [new URL("../src/server.ts", import.meta.url).pathname] }));

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: !!r.isError, texts: r.content.map((c) => c.text) };
};

try {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(JSON.stringify(names) === JSON.stringify(["check_admission", "entity_status", "get_admission_report"]), `tools = ${names.join(",")}`);

  const rep = await call("get_admission_report", { hash: INCLUDED });
  const repJson = rep.texts[1] ? JSON.parse(rep.texts[1]) : {};
  console.log(rep.texts[0]);
  expect(!rep.isError && ["included", "accepted"].includes(repJson.outcome) && repJson.checks?.length === 17, `get_admission_report outcome=${repJson.outcome} checks=${repJson.checks?.length}`);

  const bounce = await call("get_admission_report", { hash: "0x1234" });
  expect(bounce.isError && /Fix:/.test(bounce.texts[0]!), "bad hash -> isError with fix line");

  const ent = await call("entity_status", { address: EXIT_RELAY });
  const entJson = ent.texts[1] ? JSON.parse(ent.texts[1]) : {};
  console.log(ent.texts[0]);
  expect(!ent.isError && entJson.stake?.isStaked === true, `entity_status isStaked=${entJson.stake?.isStaked}`);

  const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const poolAbi = parseAbi(["function getLastRoot() view returns (bytes32)", "function roots(uint256) view returns (bytes32)"]);
  const root = await pub.readContract({ address: DEVNET.pool, abi: poolAbi, functionName: "getLastRoot" });
  let rootIdx = -1;
  for (let i = 0; i < DEVNET.rootHistorySize && rootIdx < 0; i++) {
    if ((await pub.readContract({ address: DEVNET.pool, abi: poolAbi, functionName: "roots", args: [BigInt(i)] })) === root) rootIdx = i;
  }
  if (rootIdx < 0) throw new Error(`last root ${root} not in roots(0..${DEVNET.rootHistorySize - 1})`);
  const tx = exitTx({
    proof: toHex(new Uint8Array(256)), root, nullifierHash: toHex(crypto.getRandomValues(new Uint8Array(31)), { size: 32 }),
    recipient: "0x000000000000000000000000000000000000dEaD", relayer: EXIT_RELAY, fee: EXIT_FEE, refund: 0n, rootIdx,
  }, { exitRelay: EXIT_RELAY });
  const raw: Hex = encodeTx(getProfile(DEVNET.profile), tx);
  const chk = await call("check_admission", { raw });
  console.log(chk.texts[0]);
  const chkJson = chk.texts[1] ? JSON.parse(chk.texts[1]) : {};
  expect(!chk.isError && chkJson.verdicts?.public?.verdict === "rejected", `check_admission public=${chkJson.verdicts?.public?.verdict} alt=${chkJson.verdicts?.alt?.verdict}`);

  const both = await call("check_admission", {});
  expect(both.isError && /Fix:/.test(both.texts[0]!), "no input -> isError with fix line");
} finally {
  await client.close();
}
if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
console.log("smoke ok");
