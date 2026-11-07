// End-to-end on the live devnet, with a viem local account standing in for MetaMask (its signTypedData produces the
// same eth_signTypedData_v4 bytes). Owner = OWNER_PK in .env; account from deployments.json (bun scripts/deploy.ts).
//   bun scripts/smoke.ts            parity + Mode A (one tx)
//   bun scripts/smoke.ts --session  parity + Mode B (authorise once, then 3 txs signed by a session key)
//   bun scripts/smoke.ts --all      both
// Every step prints; a rejection prints the simulator's frame-doctor report before exiting non-zero.
import { readFileSync, writeFileSync } from "node:fs";
import { getAddress, hashTypedData, http, parseAbi, toHex, zeroAddress, createPublicClient, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx } from "@altpool/core";
import { checkAdmission, renderReport } from "@altpool/simulator";
import {
  altpoolActions, bridgeAccount, createAltMempoolClient, encodeFrameTx, estimationProbe, signFrameTransaction, typedDataSigner,
  type BridgeAccount, type FrameTx,
} from "altpool";
import { envKey, pub } from "./lib";

const profile = getProfile(DEVNET.profile);
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);
const deployments = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
const owner = privateKeyToAccount(envKey("OWNER_PK"));
const entry = deployments.accounts[owner.address];
if (!entry) throw new Error(`no BridgeAccount for ${owner.address} in deployments.json: run bun scripts/deploy.ts`);
const bridge = bridgeAccount({ address: entry.address, owner: owner.address, profile });
const SEND_URL = process.env.SEND_URL ?? DEVNET.minerSidecarUrl;
const sidecar = createAltMempoolClient({ httpUrl: SEND_URL, profile, name: "send", timeoutMs: 60_000 });
const sdk = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000 }) }).extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));
const explorer = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(SEND_URL)}`;
const recipient = privateKeyToAccount(envKey("DEPLOYER_PK")).address; // exists already: a 1-wei transfer needs no state gas
const mode = process.argv.includes("--all") ? "all" : process.argv.includes("--session") ? "session" : "owner";
const results: Record<string, unknown> = { ...(deployments.smoke ?? {}) };
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

console.log(`BridgeAccount ${bridge.address}, owner ${owner.address}, sidecar ${SEND_URL}`);

// ---- 1. EIP-712 digest parity: the contract's view helpers vs viem's hashTypedData
const parityAbi = parseAbi([
  "function frameTxDigest((bytes32 sigHash,address to,uint256 value,uint256 nonce,uint256 frameCount,uint256 maxFeePerGas) t) view returns (bytes32)",
  "function sessionDigest((address key,uint64 validUntil,uint256 maxValuePerTx,uint256 maxCostPerTx,address target) s) view returns (bytes32)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
{
  const { typedData } = bridge.buildTx({ calls: [{ to: recipient, value: 1n }], nonce: 8n, fees: { maxFeePerGas: 10n ** 9n } });
  const onchain = await pub.readContract({ address: bridge.address, abi: parityAbi, functionName: "frameTxDigest", args: [typedData.message] });
  const session = bridge.authorizeSession({ key: recipient, validUntil: 2n ** 40n, maxValuePerTx: 5n, maxCostPerTx: 10n ** 16n, target: zeroAddress });
  const onchainS = await pub.readContract({ address: bridge.address, abi: parityAbi, functionName: "sessionDigest", args: [session.message] });
  const hash = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const msgSig = await owner.signTypedData({ domain: session.domain, types: { Message: [{ name: "hash", type: "bytes32" }] }, primaryType: "Message", message: { hash } });
  const v1271 = await pub.readContract({ address: bridge.address, abi: parityAbi, functionName: "isValidSignature", args: [hash, msgSig] });
  const ok = onchain === hashTypedData(typedData) && onchainS === hashTypedData(session) && v1271 === "0x1626ba7e";
  console.log(`parity: FrameTx ${onchain === hashTypedData(typedData)}, Session ${onchainS === hashTypedData(session)}, EIP-1271 ${v1271}`);
  if (!ok) process.exit(1);
}

/** Simulate, run the simulator's checkAdmission, measure gas, submit, wait. Exits with the doctor report on rejection. */
async function land(label: string, tx: FrameTx, signer?: Parameters<typeof signFrameTransaction>[2]) {
  const sim: any = await ethrex().call("ethrex_simulateFrameTransaction", [encodeFrameTx(profile, tx), "latest", {}]);
  console.log(`[${label}] ethrex simulate: status=${sim.executionStatus} prefix=${sim.prefixShape} public=${sim.canonicalMempoolValid ? "valid" : sim.canonicalMempoolViolation}`);
  if (sim.frames) console.log(`  frames gasUsed ${sim.frames.map((f: any, i: number) => `${i}:${BigInt(f.gasUsed)}`).join(" ")}`);
  if (sim.executionError) console.log(`  executionError ${sim.executionError} revertData ${sim.revertData}`);
  const verifyLimit = tx.frames.filter((f) => f.mode === profile.frameModes.VERIFY && (f.target === null || getAddress(f.target) === bridge.address)).reduce((s, f) => s + f.limits.execution, 0n);
  let est: unknown;
  if (signer) {
    // The estimator rewrites body-frame limits before checking signatures, so it needs a probe signed over them.
    est = await sidecar.estimateFrameTransactionGas(await signFrameTransaction(profile, estimationProbe(profile, tx), signer)).then((r) => r, (e) => `error ${e.message}`);
    console.log(`  eth_estimateFrameTransactionGas: ${show(est)}`);
  }
  const report = await checkAdmission(tx);
  console.log(renderReport(report, { title: `  frame-doctor (${label})` }).split("\n").map((l) => `  ${l}`).join("\n"));
  try {
    const sent = await sdk.altpool.submitFrameTransaction({ transaction: tx });
    console.log(`  ADMITTED ${sent.hash}`);
    const { receipt } = await sdk.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 240_000 });
    console.log(`  included block ${receipt.blockNumber} status ${receipt.status}; frames ${receipt.frames.map((f) => `${f.index}:${f.status}/${f.gasUsed.execution}`).join(" ")}`);
    console.log(`  ${explorer(sent.hash)}`);
    return { hash: sent.hash, raw: encodeFrameTx(profile, tx), explorer: explorer(sent.hash), block: Number(receipt.blockNumber), status: receipt.status, verifyLimit: Number(verifyLimit),
      verifyGasUsed: sim.frames?.map((f: any) => Number(BigInt(f.gasUsed))), estimate: est === undefined ? undefined : JSON.parse(show(est)) };
  } catch (e) {
    console.log(`  REJECTED: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function modeA(b: BridgeAccount) {
  const nonce = BigInt(await pub.getTransactionCount({ address: b.address }));
  const gp = await sidecar.getGasPrice();
  const { tx, typedData } = b.buildTx({ calls: [{ to: recipient, value: 1n }], nonce, fees: { maxFeePerGas: gp.maxFeePerGas * 2n, maxPriorityFeePerGas: gp.maxPriorityFeePerGas } });
  console.log(`\nMode A typed data the wallet shows: ${show(typedData.message)}`);
  const signer = typedDataSigner(owner, b);
  const signed = await signFrameTransaction(profile, tx, signer);
  console.log(`  owner signature ${signed.signatures[0]!.signature} recovers owner: ${await b.isOwnerSignature(signed, signed.signatures[0]!.signature)}`);
  results.modeA = await land("Mode A", signed, signer);
}

async function modeB(b: BridgeAccount) {
  const sessionPk = generatePrivateKey();
  const key = privateKeyToAccount(sessionPk).address;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const session = { key, validUntil: now + 3600n, maxValuePerTx: 1000n, maxCostPerTx: 10n ** 16n, target: recipient };
  const ownerSignature = await owner.signTypedData(b.authorizeSession(session)); // the one wallet popup
  console.log(`\nMode B session ${show(session)} authorised by the owner`);
  const gp = await sidecar.getGasPrice();
  const out = [];
  for (let i = 0; i < 3; i++) {
    // Distinct EIP-8250 nonce keys: the sidecar keeps one pending tx per (sender, key), so these can be in flight together.
    const nonceKey = BigInt(toHex(crypto.getRandomValues(new Uint8Array(24))));
    const tx = b.buildSessionTx({
      session, ownerSignature, calls: [{ to: recipient, value: BigInt(i + 1) }], nonce: 0n, nonceKey, deadline: now + 600n,
      fees: { maxFeePerGas: gp.maxFeePerGas * 2n, maxPriorityFeePerGas: gp.maxPriorityFeePerGas },
    });
    const signed = await signFrameTransaction(profile, tx, { privateKey: sessionPk });
    out.push(await land(`Mode B #${i + 1}`, signed, { privateKey: sessionPk }));
  }
  results.modeB = out;
}

if (mode !== "session") await modeA(bridge);
if (mode !== "owner") await modeB(bridge);
deployments.smoke = { ...results, account: bridge.address, at: new Date().toISOString() };
writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + "\n");
console.log("\nrecorded results in deployments.json");
