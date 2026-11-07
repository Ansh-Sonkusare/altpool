// Measure one real ExitRelayRR exit on the public devnet and write evidence/exit-rr.json.
// Flow: fresh depositor -> deposit -> publishRoot -> prove -> exitTxRR -> simulate (VERIFY gas, public verdict) -> miner -> receipt.
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway, toWire } from "@altpool/core";
import { createNote, noteToString, proveForRoot } from "@altpool/prover";
import { EXIT_FEE, exitTxRR } from "../src/exit";
import { MINER_SIDECAR, depositNote, explorerExit, sendExit } from "../src/flow";
import deployments from "../deployments.json";

const exitRelayRR = (deployments as Record<string, unknown>).exitRelayRR as Address | undefined;
if (!exitRelayRR) throw new Error("deployments.json has no exitRelayRR");
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const gw = gateway();
const send = gateway(process.env.SEND_URL ?? MINER_SIDECAR);
const profile = getProfile(DEVNET.profile);

const depositor = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account: depositor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
console.log(`depositor ${depositor.address}, faucet ${JSON.stringify(await gw.faucet(depositor.address))}`);
const minBalance = DEVNET.denomination + parseEther("0.01");
for (let i = 0; i < 60 && (await pub.getBalance({ address: depositor.address })) < minBalance; i++) await sleep(2000);

const note = createNote();
const depositTx = await depositNote(wallet, note);
console.log(`deposited (${depositTx}); note ${noteToString(note)}`);

const rrAbi = parseAbi(["function publishRoot()", "event RootPublished(bytes32 indexed root)"]);
const publishTx = await wallet.writeContract({ address: exitRelayRR, abi: rrAbi, functionName: "publishRoot", gas: 400_000n, type: "legacy" });
const receipt = await pub.waitForTransactionReceipt({ hash: publishTx, timeout: 180_000 });
if (receipt.status !== "success") throw new Error(`publishRoot ${publishTx} reverted`);
const [published] = parseEventLogs({ abi: rrAbi, eventName: "RootPublished", logs: receipt.logs });
if (!published) throw new Error("no RootPublished event");
const root = published.args.root;
const slotOf = async (block: Hex | "latest") => {
  const b = (await ethrex().call("eth_getBlockByNumber", [block, false])) as { slotNumber?: Hex } | null;
  if (!b?.slotNumber) throw new Error(`block ${block} has no slotNumber`);
  return BigInt(b.slotNumber);
};
const rootSlot = await slotOf(toHex(receipt.blockNumber));
console.log(`published root ${root} block ${receipt.blockNumber} slot ${rootSlot}`);
for (let i = 0; i < 60 && (await slotOf("latest")) <= rootSlot; i++) await sleep(2000);

const recipient = privateKeyToAccount(generatePrivateKey()).address;
const balanceBefore = await pub.getBalance({ address: recipient });
const proof = await proveForRoot(note, root, { recipient, relayer: exitRelayRR, fee: EXIT_FEE });
const tx = exitTxRR({ ...proof, rootSlot }, { exitRelayRR });

let sim: unknown;
try {
  sim = await ethrex().simulateFrameTransaction(encodeTx(profile, tx), true);
} catch (e) {
  sim = { error: e instanceof Error ? e.message : String(e) };
}
const simObj = sim as Record<string, unknown>;
console.log(`simulate: ${json({ ...simObj, erc7562Trace: simObj.erc7562Trace ? "(omitted)" : simObj.erc7562Trace })}`);
const est = await send.estimateFrameTransactionGas(toWire(tx)).then((r) => r as unknown, (e) => ({ error: e instanceof Error ? e.message : String(e) }));
console.log(`alt estimate: ${json(est)}`);

const r = await sendExit(tx, { sendUrl: send.url });
console.log(`exit ${r.hash} block ${r.blockNumber} status ${r.status} gasUsed ${r.gasUsed}`);
r.frames.forEach((f, i) => console.log(`  frame ${i}: status ${f.status} gasUsed ${f.gasUsed} stateGasUsed ${f.stateGasUsed}`));
const balanceAfter = await pub.getBalance({ address: recipient });
console.log(`recipient ${formatEther(balanceBefore)} -> ${formatEther(balanceAfter)} ETH`);

mkdirSync(new URL("../evidence/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../evidence/exit-rr.json", import.meta.url),
  json({
    measuredAt: new Date().toISOString(),
    exitRelayRR,
    comparison: { exitRelayVerifyGas: 374217 },
    depositTx,
    publishRootTx: publishTx,
    root,
    rootSlot,
    recipient,
    recipientBalanceBeforeWei: balanceBefore,
    recipientBalanceAfterWei: balanceAfter,
    exitTx: r.hash,
    exitExplorer: explorerExit(r.hash),
    blockNumber: r.blockNumber,
    status: r.status,
    gasUsed: r.gasUsed,
    frames: r.frames,
    simulate: { ...simObj, erc7562Trace: undefined },
    estimate: est,
  }) + "\n",
);
console.log(`deposit ${explorerTx(depositTx)}\nexit    ${explorerExit(r.hash)}`);
