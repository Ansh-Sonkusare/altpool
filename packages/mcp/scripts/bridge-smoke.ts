// Live check of the two BridgeAccount paths through the MCP server, with the wallet-bridge test owner standing in for
// MetaMask (viem signTypedData = the same bytes as eth_signTypedData_v4):
//   1. session: the owner authorises a session once; the agent (MCP send_calls via "session") spends within it.
//   2. owner:   prepare_owner_tx -> the owner signs the typed data -> submit_frame_tx -> wait_for_receipt.
// Needs packages/wallet-bridge/.env OWNER_PK and its BridgeAccount in deployments.json (bun run --filter
// @altpool/wallet-bridge deploy). Exits non-zero on mismatch.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET } from "@altpool/core";
import { bridgeAccount } from "altpool";
import { bridgeDeployments } from "@altpool/wallet-bridge";
import { profile, type SessionFile } from "../src/context";

const envFile = readFileSync(new URL("../../wallet-bridge/.env", import.meta.url), "utf8");
const ownerPk = envFile.match(/^OWNER_PK=(0x[0-9a-fA-F]{64})\s*$/m)?.[1] as Hex | undefined;
if (!ownerPk) throw new Error("packages/wallet-bridge/.env has no OWNER_PK");
const owner = privateKeyToAccount(ownerPk);
const deployed = bridgeDeployments.accounts[owner.address]?.address as Address | undefined;
if (!deployed) throw new Error(`no BridgeAccount for ${owner.address} in packages/wallet-bridge/deployments.json`);
const account = getAddress(deployed);
const bridge = bridgeAccount({ address: account, owner: owner.address, profile });

// 1. The owner authorises a 30-minute session for any target, 1000 wei per tx (what wallet-bridge-web exports).
const sessionPk = generatePrivateKey();
const session = { key: privateKeyToAccount(sessionPk).address, validUntil: BigInt(Math.floor(Date.now() / 1000) + 1800), maxValuePerTx: 1000n, maxCostPerTx: parseEther("0.01"), target: zeroAddress as Address };
const ownerSignature = await owner.signTypedData(bridge.authorizeSession(session));
const file: SessionFile = {
  kind: "altpool-bridge-session", chainId: DEVNET.chainId, account, owner: owner.address,
  session: { key: session.key, validUntil: String(session.validUntil), maxValuePerTx: "1000", maxCostPerTx: String(session.maxCostPerTx), target: session.target },
  ownerSignature, sessionPrivateKey: sessionPk,
};
const sessionPath = join(mkdtempSync(join(tmpdir(), "altpool-session-")), "session.json");
writeFileSync(sessionPath, JSON.stringify(file), { mode: 0o600 });

let bad = 0;
const expect = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) bad++; };
const client = new Client({ name: "altpool-bridge-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({
  command: "bun", args: [new URL("../src/server.ts", import.meta.url).pathname],
  env: { ...(process.env as Record<string, string>), ALTPOOL_SESSION: sessionPath },
}));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const texts = r.content.map((c) => c.text);
  console.log(texts[0]);
  let json: any = {};
  try { json = texts[1] ? JSON.parse(texts[1]) : {}; } catch {}
  return { isError: !!r.isError, text: texts[0] ?? "", json };
};
const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

try {
  const info = await call("agent_info", {});
  expect(info.text.includes(`session on BridgeAccount ${account}`), "agent_info sees the session");

  // Over the session's value cap: refused locally, nothing sent.
  const over = await call("send_calls", { via: "session", calls: [{ to: fresh(), value: "1001" }] });
  expect(over.isError && /maxValuePerTx/.test(over.text), "session: value over the cap is refused");

  const s = await call("send_calls", { via: "session", calls: [{ to: fresh(), value: "7" }] });
  expect(!s.isError && !!s.json.hash, `session send_calls hash=${s.json.hash}`);
  if (s.json.hash) expect(!(await call("wait_for_receipt", { hash: s.json.hash, timeoutSec: 240 })).isError, "session tx included");

  // 2. Human in the loop.
  const prep = await call("prepare_owner_tx", { account, calls: [{ to: fresh(), value: "3" }] });
  expect(!prep.isError && prep.json.typedData?.primaryType === "FrameTx", "prepare_owner_tx returns FrameTx typed data");
  const td = prep.json.typedData;
  const sig = await owner.signTypedData({
    domain: td.domain, types: td.types, primaryType: td.primaryType,
    message: { ...td.message, value: BigInt(td.message.value), nonce: BigInt(td.message.nonce), frameCount: BigInt(td.message.frameCount), maxFeePerGas: BigInt(td.message.maxFeePerGas) },
  });
  const wrong = await call("submit_frame_tx", { tx: prep.json.tx, ownerSignature: await privateKeyToAccount(generatePrivateKey()).signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: { ...td.message, value: BigInt(td.message.value), nonce: BigInt(td.message.nonce), frameCount: BigInt(td.message.frameCount), maxFeePerGas: BigInt(td.message.maxFeePerGas) } }) });
  expect(wrong.isError && /does not recover the account owner/.test(wrong.text), "submit_frame_tx refuses a non-owner signature");
  const sub = await call("submit_frame_tx", { tx: prep.json.tx, ownerSignature: sig });
  expect(!sub.isError && !!sub.json.hash, `submit_frame_tx hash=${sub.json.hash}`);
  if (sub.json.hash) expect(!(await call("wait_for_receipt", { hash: sub.json.hash, timeoutSec: 240 })).isError, "owner tx included");
} finally {
  await client.close();
}
if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
console.log("bridge smoke ok");
