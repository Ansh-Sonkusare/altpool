// F1 gate, live: deploy the shared ZKNOX verifier + a FalconWallet, fund it, then
//  (a) simulate a Falcon-signed spend (ethrex_simulateFrameTransaction): VERIFY gas, executionError
//  (b) the same with one flipped signature byte: must fail in VERIFY
//  (c) submit the good tx to the miner sidecar, wait for inclusion, check the 0.001 ETH arrived, print the admission report.
import { bytesToHex, formatEther, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { encodeTx, txHash, type FrameTx } from "@forshtat/hegota-support/tx";
import { altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET, explorerTx } from "@altpool/core";
import { falconKeygen, falconSpendTx, pkHashOf } from "../src/falcon";
import { artifact, deployer, eth, fund, mined, persistEnv, pub, sharedVerifier } from "./lib";

const MINER = DEVNET.minerSidecarUrl;
const explorerOn = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(MINER)}`;
const profile = getProfile(DEVNET.profile);

const { account, wallet } = deployer();
await fund(account.address, parseEther("0.3"));
console.log(`deployer ${account.address}: ${eth(await pub.getBalance({ address: account.address }))}`);
const verifier = await sharedVerifier(wallet);

const key = falconKeygen();
persistEnv(`FALCON_SMOKE_SK_${pkHashOf(key.publicKey).slice(2, 10)}`, bytesToHex(key.secretKey));
const art = artifact("FalconWallet");
// Nine HegotaSupport helper CREATEs dominate (ExitRelay: ~14.9M estimated); give it room.
const deployHash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [verifier, pkHashOf(key.publicKey)], gas: 18_000_000n, type: "legacy" });
const dr = await mined(deployHash);
const walletAddr = dr.contractAddress as Address;
console.log(`FalconWallet ${walletAddr} (${deployHash}) gasUsed ${dr.gasUsed}`);

const fundHash = await wallet.sendTransaction({ to: walletAddr, value: parseEther("0.02"), gas: 100_000n, type: "legacy" });
await mined(fundHash);
console.log(`funded wallet ${eth(await pub.getBalance({ address: walletAddr }))} (${fundHash})`);

const nonce = BigInt(await pub.getTransactionCount({ address: walletAddr }));
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const value = parseEther("0.001");
const spend = (tamper?: (s: Hex) => Hex): FrameTx =>
  falconSpendTx({ wallet: walletAddr, key, nonce, to: recipient, value, maxFeePerGas: 2n * 10n ** 9n, tamper });
const good = spend();
const flip = (s: Hex): Hex => {
  const b = Buffer.from(s.slice(2), "hex");
  b[100] ^= 1; // inside s2
  return `0x${b.toString("hex")}`;
};
const bad = spend(flip);

const sdk = pub.extend(altpoolActions({ sidecar: createAltMempoolClient({ httpUrl: MINER, profile, name: "miner" }), explorerUrl: DEVNET.explorerUrl }));

type Sim = { canonicalMempoolValid?: boolean; canonicalMempoolViolation?: string; executionStatus?: string; executionError?: string; failedFrameIndex?: number; revertData?: string; frames?: { gasUsed: string; succeeded: boolean }[] | null; gasUsed?: string | null };
async function simulate(label: string, tx: FrameTx): Promise<Sim> {
  const x = (await pub.request({ method: "ethrex_simulateFrameTransaction" as never, params: [encodeTx(profile, tx), "latest", { trace: false }] as never })) as Sim;
  console.log(`${label}: ${x.frames ? x.frames.map((f, i) => `frame ${i} ${f.succeeded ? "ok" : "FAILED"} gas ${BigInt(f.gasUsed)}`).join(", ") : "no frame results"}; execution ${x.executionStatus ?? "-"}; error ${x.executionError ?? "-"}`);
  console.log(`    public-mempool verdict: valid=${x.canonicalMempoolValid} (${x.canonicalMempoolViolation ?? "-"})`);
  return x;
}
const goodSim = await simulate("(a) good signature   ", good);
if (!goodSim.frames?.[0]?.succeeded || goodSim.executionStatus !== "success") throw new Error("good tx did not simulate to success");
const badSim = await simulate("(b) one flipped byte ", bad);
if (badSim.failedFrameIndex !== 0) throw new Error("tampered tx did not fail in VERIFY (frame 0)");
console.log(`    failed frame ${badSim.failedFrameIndex} (VERIFY), revertData ${badSim.revertData} = BadFalconSignature()`);

try {
  const h = await sdk.altpool.submitFrameTransaction({ transaction: bad });
  console.log(`(b) TAMPERED TX WAS ADMITTED ${h.hash}`);
  process.exit(1);
} catch (e) {
  console.log(`(b) tampered tx rejected by the sidecar: ${(e as Error).message}`);
}

const before = await pub.getBalance({ address: recipient });
const sent = await sdk.altpool.submitFrameTransaction({ transaction: good });
console.log(`(c) submitted ${sent.hash} (local ${txHash(profile, good)})`);
const { receipt: r } = await sdk.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 240_000, throwOnRevert: true });
console.log(`(c) included in block ${r.blockNumber}, status ${r.status}, gasUsed ${r.gasUsed}`);
for (const f of r.frames) console.log(`    frame ${f.index}: ${f.status}, execution gas ${f.gasUsed.execution}, state gas ${f.gasUsed.state}`);
const failed = r.frames.find((f) => f.status !== "success");
if (failed) throw new Error(`frame ${failed.index} ${failed.status}`);
const after = await pub.getBalance({ address: recipient });
if (after - before !== value) throw new Error(`recipient got ${formatEther(after - before)} ETH, want ${formatEther(value)}`);
console.log(`recipient ${recipient} received ${eth(after - before)}; wallet now ${eth(await pub.getBalance({ address: walletAddr }))}`);
console.log(`explorer: ${explorerOn(sent.hash)}`);
const report = await sdk.altpool.getAdmissionReport({ hash: sent.hash });
console.log(`admission report: outcome ${report?.outcome}`);
for (const c of report?.checks ?? []) console.log(`    ${c.verdict.padEnd(7)} ${c.rule}${c.frameIndex === undefined ? "" : ` frame ${c.frameIndex}`}${c.detail ? ` (${c.detail})` : ""}`);
console.log("FALCON GATE PASSED");
