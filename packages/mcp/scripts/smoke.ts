// Live check: spawn the server over stdio and exercise the tools against the devnet (or altpool-localnet via
// ETHREX_URL / GATEWAY_URL / MINER_SIDECAR_URL). Exits non-zero on mismatch.
//   bun run smoke              read-only tools, resource, prompt
//   bun run smoke -- --write   also the agent path: fund_from_faucet -> send_calls (1 wei to a fresh address) -> wait_for_receipt
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, parseAbi, toHex, type Address, type Hex } from "viem";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet } from "@altpool/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile as profileOf } from "@forshtat/hegota-support/profiles";
import { createAltMempoolClient } from "altpool";
import { EXIT_FEE, deployments, exitTx } from "@altpool/contracts";

const WRITE = process.argv.includes("--write");
// A tx the node itself recorded as included. Explorer history is in memory, so a pinned hash dies on every restart.
async function recentIncluded(): Promise<{ hash: string; node: "miner" | "gateway" } | undefined> {
  for (const [node, url] of [["miner", DEVNET.minerSidecarUrl], ["gateway", DEVNET.gatewayUrl]] as const) {
    const sc = createAltMempoolClient({ httpUrl: url, profile: profileOf(DEVNET.profile), name: node });
    const page = await sc.listAdmissions({ outcome: "included", limit: 5 }).catch(() => undefined);
    const hit = page?.items[0];
    if (hit) return { hash: hit.hash, node };
  }
  return undefined;
}
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
  const want = ["agent_info", "check_admission", "entity_status", "explain_rule", "fund_from_faucet", "get_admission_report", "prepare_owner_tx", "send_calls", "stake_entity", "submit_frame_tx", "wait_for_receipt"];
  expect(JSON.stringify(names) === JSON.stringify(want), `tools = ${names.join(",")}`);
  const rules = await client.readResource({ uri: "altpool://rules" });
  expect(String((rules.contents[0] as { text?: string })?.text ?? "").includes("BUDGET-010"), "resource altpool://rules");
  const prompt = await client.getPrompt({ name: "get_admitted", arguments: { goal: "send 1 wei" } });
  expect(prompt.messages.length === 1, "prompt get_admitted");
  const rule = await call("explain_rule", { rule: "storage" });
  expect(!rule.isError && /stake/i.test(rule.texts[0]!), "explain_rule storage");

  const inc = await recentIncluded();
  if (!inc) console.log("SKIP get_admission_report: no included tx in either node's in-memory history");
  else {
    const rep = await call("get_admission_report", { hash: inc.hash, node: inc.node });
    const repJson = rep.texts[1] ? JSON.parse(rep.texts[1]) : {};
    console.log(rep.texts[0]);
    expect(!rep.isError && ["included", "accepted"].includes(repJson.outcome) && repJson.checks?.length > 0, `get_admission_report outcome=${repJson.outcome} checks=${repJson.checks?.length}`);
  }

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

  const info = await call("agent_info", {});
  console.log(info.texts[0]);
  expect(!info.isError && /agent EOA 0x/.test(info.texts[0]!), "agent_info");

  if (WRITE) {
    const fund = await call("fund_from_faucet", {});
    console.log(fund.texts[0]);
    const to = privateKeyToAccount(generatePrivateKey()).address;
    const sent = await call("send_calls", { calls: [{ to, value: "1" }] });
    console.log(sent.texts[0]);
    const sentJson = sent.texts[1] ? JSON.parse(sent.texts[1]) : {};
    expect(!sent.isError && /^0x[0-9a-f]{64}$/i.test(sentJson.hash ?? ""), `send_calls hash=${sentJson.hash}`);
    if (sentJson.hash) {
      const r = await call("wait_for_receipt", { hash: sentJson.hash, timeoutSec: 240 });
      console.log(r.texts[0]);
      expect(!r.isError && /every frame succeeded/.test(r.texts[0]!), "wait_for_receipt: included, all frames ok");
      expect((await pub.getBalance({ address: to })) === 1n, "recipient got 1 wei");
    }
  }
} finally {
  await client.close();
}
if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
console.log("smoke ok");
