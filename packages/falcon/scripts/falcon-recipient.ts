// F2, live: a QuietSend exit pays a Falcon wallet that does not exist yet; the wallet is then deployed at the
// predicted address and spends the exit proceeds with a Falcon-signed frame tx, paying its own gas. The spend goes
// through the SDK (falconAccount + sendFrameTransaction with prepare), the path an app would use.
import { bytesToHex, createWalletClient, formatEther, http, parseAbi, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET, altDevnet, explorerTx } from "@altpool/core";
import { createNote, noteToString, prove } from "@altpool/prover";
import { EXIT_FEE, deployments, depositNote, exitTx, explorerExit, sendExit } from "@altpool/contracts";
import { falconKeygen } from "../src/falcon";
import { falconAccount } from "../src/account";
import { artifact, deployer, eth, fund, mined, persistEnv, pub, readDeployments, sharedVerifier, writeDeployments } from "./lib";

const profile = getProfile(DEVNET.profile);
const exitRelay = deployments.exitRelay as Address | null;
if (!exitRelay) throw new Error("@altpool/contracts deployments.json has no exitRelay");

// 1. Shared verifier + factory (deployed once, kept in deployments.json).
const { account, wallet: deployerWallet } = deployer();
await fund(account.address, parseEther("0.3"));
const verifier = await sharedVerifier(deployerWallet);
let { factory } = readDeployments();
if (!factory || !(await pub.getCode({ address: factory }))) {
  const art = artifact("FalconWalletFactory");
  const hash = await deployerWallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [verifier], gas: 18_000_000n, type: "legacy" });
  const r = await mined(hash);
  factory = r.contractAddress!;
  writeDeployments({ ...readDeployments(), factory, factoryTx: hash });
  console.log(`FalconWalletFactory ${factory} (${hash}) gasUsed ${r.gasUsed}`);
}
const factoryAbi = parseAbi(["function predictAddress(bytes32) view returns (address)", "function deploy(bytes32) returns (address)"]);

// 2. A Falcon key and its wallet address, before the wallet exists.
const key = falconKeygen();
const pq = falconAccount({ key, factory, verifier });
const { pkHash, address: predicted } = pq;
persistEnv(`FALCON_RECIPIENT_SK_${pkHash.slice(2, 10)}`, bytesToHex(key.secretKey));
const onChain = await pub.readContract({ address: factory, abi: factoryAbi, functionName: "predictAddress", args: [pkHash] });
if (predicted.toLowerCase() !== onChain.toLowerCase()) throw new Error(`predicted ${predicted} != factory ${onChain}`);
if ((await pub.getCode({ address: predicted })) !== undefined) throw new Error("predicted address already has code");
console.log(`Falcon wallet address (not deployed yet): ${predicted}\n  TS prediction == factory.predictAddress(pkHash)`);

// 3. QuietSend: fresh depositor deposits, then withdraws to the predicted address through the live ExitRelay.
const depositor = privateKeyToAccount(generatePrivateKey());
const depositorWallet = createWalletClient({ account: depositor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
await fund(depositor.address, DEVNET.denomination + parseEther("0.01"));
const note = createNote();
const depositHash = await depositNote(depositorWallet, note);
console.log(`deposited ${formatEther(DEVNET.denomination)} ETH from fresh ${depositor.address}: ${explorerTx(depositHash)}\n  note ${noteToString(note)}`);
const proof = await prove(note, { recipient: predicted, relayer: exitRelay, fee: EXIT_FEE });
const exit = await sendExit(exitTx(proof, { exitRelay }));
console.log(`exit ${exit.hash} included in block ${exit.blockNumber}: ${exit.frames.map((f, i) => `frame ${i} ${f.status} ${f.gasUsed}`).join(", ")}\n  ${explorerExit(exit.hash)}`);
const landed = await pub.getBalance({ address: predicted });
const want = DEVNET.denomination - EXIT_FEE;
if (landed !== want) throw new Error(`predicted address holds ${landed}, want ${want}`);
if ((await pub.getCode({ address: predicted })) !== undefined) throw new Error("code appeared at the predicted address before deploy");
console.log(`${eth(landed)} landed at ${predicted} (no code yet)`);

// 4. Deploy the wallet at that address from the funded EOA (CREATE2 onto a funded account keeps the balance).
const deployHash = await deployerWallet.sendTransaction({ ...pq.deployCall(), gas: 18_000_000n, type: "legacy" });
const dr = await mined(deployHash);
if (!(await pq.isDeployed(pub))) throw new Error("no code at predicted address after deploy");
if ((await pub.getBalance({ address: predicted })) !== want) throw new Error("balance changed by deploy");
console.log(`wallet deployed at ${predicted} via factory (${deployHash}) gasUsed ${dr.gasUsed}: ${explorerTx(deployHash)}`);

// 5. Spend 0.01 ETH with a Falcon-signed frame tx; the wallet pays its own gas, nobody else signs.
const dest = privateKeyToAccount(generatePrivateKey()).address;
const value = parseEther("0.01");
const nonce = await pq.getNonce(pub);
const before = await pub.getBalance({ address: predicted });
const sdk = pub.extend(altpoolActions({ sidecar: createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, profile, name: "miner" }), explorerUrl: DEVNET.explorerUrl }));
// The miner admitted a first spend once and then dropped it after 4 relays without a block (48 s); an identical resubmit
// at the same nonce was included in 8 s. So: wait for inclusion, and on a drop resubmit once (fresh signature, same nonce).
let sent: Awaited<ReturnType<typeof sdk.altpool.sendFrameTransaction>> | undefined;
let r: Awaited<ReturnType<typeof sdk.altpool.waitForFrameTransactionReceipt>>["receipt"] | undefined;
for (let attempt = 1; !r; attempt++) {
  // prepare: the sidecar estimates the body frame on a Falcon-signed probe, then the SDK re-signs the real tx.
  sent = await sdk.altpool.sendFrameTransaction({ transaction: pq.buildTx({ nonce, to: dest, value, maxFeePerGas: 2n * 10n ** 9n }), signer: pq.signer, prepare: true, mempool: "alt" });
  console.log(`spend attempt ${attempt}: submitted ${sent.hash} via the SDK${sent.gas ? ` (SENDER limit ${sent.gas.frames[1]?.suggested.execution}, measured ${sent.gas.frames[1]?.measured.execution})` : ""}`);
  try {
    r = (await sdk.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 180_000 })).receipt;
  } catch (e) {
    console.log(`  not included: ${(e as Error).message}`);
    if (attempt >= 2) throw e;
  }
}
const failed = r.frames.find((f) => f.status !== "success");
if (failed) throw new Error(`spend frame ${failed.index} ${failed.status}`);
console.log(`spend ${sent!.hash} included in block ${r.blockNumber}: ${r.frames.map((f) => `frame ${f.index} ${f.status} exec ${f.gasUsed.execution} state ${f.gasUsed.state}`).join(", ")}`);
const got = await pub.getBalance({ address: dest });
if (got !== value) throw new Error(`destination received ${got}, want ${value}`);
const after = await pub.getBalance({ address: predicted });
console.log(`destination ${dest} received ${eth(got)}; wallet ${eth(before)} -> ${eth(after)} (gas paid by the wallet: ${eth(before - value - after)})`);
console.log(`  ${explorerExit(sent!.hash)}`);
console.log("FALCON RECIPIENT FLOW PASSED");
