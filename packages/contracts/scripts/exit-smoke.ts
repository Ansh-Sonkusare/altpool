// IP3 lever: deposit a fresh note, exit it through the deployed ExitRelay to a 0-ETH recipient, then replay it.
// `--junk` instead sends one exit with a zeroed proof against a known root: reaching BadProof proves every frame
// opcode read in ExitRelay's VERIFY worked on this devnet.
// `--rr` runs the same exit through ExitRelayRR: publish the pool root to EIP-8272, prove against it, carry it as a
// recent-root reference, and assert from the ERC-7562 trace that VERIFY read no foreign storage.
// `--weth` exits a WETH note from the ERC20Tornado pool through ExitRelayToken (fee paid in WETH, ETH `refund` to the
// recipient), has the recipient unwrap its own WETH, then unwraps the relay's fees.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatEther,
  http,
  isAddressEqual,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway, toWire, type WithdrawProof } from "@altpool/core";
import { createNote, noteToString, prove, proveForRoot } from "@altpool/prover";
import { EXIT_FEE, WETH_EXIT_REFUND, exitTx, exitTxRR } from "../src/exit";
import { MINER_SIDECAR, depositNote, depositNoteWeth, explorerExit, sendExit } from "../src/flow";
import { WETH9, wethAbi } from "../src/pools";
import deployments from "../deployments.json";

const rr = process.argv.includes("--rr");
const weth = process.argv.includes("--weth");
if (rr && weth) throw new Error("--rr and --weth are separate flows");
const contract = rr ? "ExitRelayRR" : weth ? "ExitRelayToken" : "ExitRelay";
const deployed = deployments as Record<string, unknown>;
const exitKey = rr ? "exitRelayRR" : weth ? "exitRelayWETH" : "exitRelay";
const exitRelay = deployed[exitKey] as Address | null | undefined;
if (!exitRelay) throw new Error(`deployments.json has no ${exitKey}: run \`bun run --filter @altpool/contracts deploy${weth ? " -- --weth" : ""}\` first`);
const pool = (weth ? deployed.wethPool : DEVNET.pool) as Address | undefined;
if (!pool) throw new Error("deployments.json has no wethPool: run `bun scripts/deploy-weth-pool.ts` first");
const errorAbi = (JSON.parse(readFileSync(new URL(`../out/${contract}.sol/${contract}.json`, import.meta.url), "utf8")).abi as Abi).filter(
  (x) => x.type === "error",
);
const poolAbi = parseAbi([
  "function getLastRoot() view returns (bytes32)",
  "function roots(uint256) view returns (bytes32)",
]);
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const gw = gateway();
// SEND_URL: submit to another sidecar (e.g. the miner's own, https://altmempool.forshtat.com/rpc) when gateway gossip stalls.
const send = gateway(process.env.SEND_URL ?? MINER_SIDECAR);
const profile = getProfile(DEVNET.profile);
const randomAddress = () => privateKeyToAccount(generatePrivateKey()).address;

/** The ExitRelay custom error inside a node's rejection text, else the text itself. */
function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  for (const data of msg.match(/0x[0-9a-fA-F]{8,}/g) ?? []) {
    try {
      return `${decodeErrorResult({ abi: errorAbi, data: data as Hex }).errorName} (${msg})`;
    } catch {}
  }
  return msg;
}

async function exitFor(p: WithdrawProof & { rootIdx: number }): Promise<FrameTx> {
  return report(exitTx(p, { exitRelay: exitRelay!, pool }));
}

async function report(tx: FrameTx): Promise<FrameTx> {
  const sim = await ethrex().simulateFrameTransaction(encodeTx(profile, tx)).then(
    (r) => `valid=${r.canonicalMempoolValid} violation=${r.canonicalMempoolViolation ?? "-"} maxCost=${"maxCost" in r ? String(r.maxCost) : "-"}`,
    (e) => `error ${reason(e)}`,
  );
  console.log(`public simulate (ethrex_simulateFrameTransaction): ${sim}`);
  const est = await send.estimateFrameTransactionGas(toWire(tx)).then((r) => JSON.stringify(r), (e) => `error ${reason(e)}`);
  console.log(`alt estimate (eth_estimateFrameTransactionGas): ${est}`);
  return tx;
}

if (process.argv.includes("--junk")) {
  const root = await pub.readContract({ address: pool!, abi: poolAbi, functionName: "getLastRoot" });
  let rootIdx = -1;
  for (let i = 0; i < DEVNET.rootHistorySize && rootIdx < 0; i++) {
    if ((await pub.readContract({ address: pool!, abi: poolAbi, functionName: "roots", args: [BigInt(i)] })) === root) rootIdx = i;
  }
  if (rootIdx < 0) throw new Error(`last root ${root} not in roots(0..99)`);
  const tx = await exitFor({
    proof: toHex(new Uint8Array(256)),
    root,
    nullifierHash: toHex(crypto.getRandomValues(new Uint8Array(31)), { size: 32 }),
    recipient: randomAddress(),
    relayer: exitRelay,
    fee: EXIT_FEE,
    refund: 0n,
    rootIdx,
  });
  try {
    const hash = await send.sendFrameTransaction(toWire(tx));
    console.log(`junk exit ADMITTED ${hash}: ExitRelay approved a zeroed proof`);
    process.exit(1);
  } catch (e) {
    const r = reason(e);
    console.log(`junk exit rejected: ${r}`);
    process.exit(r.startsWith("BadProof ") ? 0 : 1);
  }
}

const depositorKey = generatePrivateKey();
const depositor = privateKeyToAccount(depositorKey);
const wallet = createWalletClient({ account: depositor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
console.log(`depositor ${depositor.address}, faucet ${JSON.stringify(await gw.faucet(depositor.address))}`);
const minBalance = DEVNET.denomination + parseEther("0.01");
for (let i = 0; i < 60 && (await pub.getBalance({ address: depositor.address })) < minBalance; i++) await sleep(2000);

const note = createNote();
const depositTx = weth ? await depositNoteWeth(wallet, note, pool) : await depositNote(wallet, note);
console.log(`deposited ${formatEther(DEVNET.denomination)} ${weth ? "WETH" : "ETH"} (${depositTx}); note ${noteToString(note)}`);

const recipientKey = generatePrivateKey(); // never printed
const recipient = privateKeyToAccount(recipientKey).address;
let tx: FrameTx;
if (rr) tx = await exitRR();
else {
  const proof = await prove(note, { recipient, relayer: exitRelay, fee: EXIT_FEE, refund: weth ? WETH_EXIT_REFUND : 0n }, pool);
  console.log(`proved for recipient ${recipient}, rootIdx ${proof.rootIdx}`);
  tx = await exitFor(proof);
}

const wethOf = (address: Address) => pub.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [address] });
const relayWethBefore = weth ? await wethOf(exitRelay) : 0n;

const r = await sendExit(tx, { sendUrl: send.url });
const exitHash = r.hash;
console.log(`exit sent ${exitHash}`);
console.log(`included in block ${r.blockNumber}, status ${r.status}${r.gasUsed === undefined ? "" : `, gasUsed ${r.gasUsed}`}`);
r.frames.forEach((f, i) => console.log(`  frame ${i}: status ${f.status} gasUsed ${f.gasUsed} stateGasUsed ${f.stateGasUsed}`));

const want = DEVNET.denomination - EXIT_FEE;
if (weth) {
  // The recipient is paid in WETH plus the pool-forwarded ETH refund; the fee WETH lands on the relay, not in its ETH float.
  const [gotWeth, gotEth, relayWeth] = [await wethOf(recipient), await pub.getBalance({ address: recipient }), await wethOf(exitRelay)];
  console.log(`recipient ${formatEther(gotWeth)} WETH (want ${formatEther(want)}), ${formatEther(gotEth)} ETH (want ${formatEther(WETH_EXIT_REFUND)})`);
  if (gotWeth !== want) throw new Error(`recipient WETH ${gotWeth} != ${want}`);
  if (gotEth !== WETH_EXIT_REFUND) throw new Error(`recipient ETH ${gotEth} != ${WETH_EXIT_REFUND}`);
  console.log(`relay WETH +${formatEther(relayWeth - relayWethBefore)} (want ${formatEther(EXIT_FEE)})`);
  if (relayWeth - relayWethBefore !== EXIT_FEE) throw new Error(`relay WETH rose by ${relayWeth - relayWethBefore}, want ${EXIT_FEE}`);
} else {
  const got = await pub.getBalance({ address: recipient });
  console.log(`recipient balance ${formatEther(got)} ETH (want ${formatEther(want)})`);
  if (got !== want) throw new Error(`recipient balance ${got} != ${want}`);
}

// The replay is a different tx for the same note (priority fee + 1 wei: new hash, same nullifier nonce key). Re-sending
// the identical tx would file the rejection under the real exit's hash, and the explorer would show the exit "Rejected".
const replayTx: FrameTx = { ...tx, fees: { ...tx.fees, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas + 1n } };
for (const sidecar of new Set([send.url, gw.url])) {
  try {
    const replay = await gateway(sidecar).sendFrameTransaction(toWire(replayTx));
    throw new Error(`replay ADMITTED ${replay} by ${sidecar}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("replay ADMITTED")) throw e;
    console.log(`replay rejected by ${sidecar}: ${reason(e)}`);
  }
}

// Replay gate. The sidecars' rejection text is the public-mempool violation, not the cause, so re-simulate the
// replay after inclusion and require the consumed nonce key or ExitRelay's NullifierSpent.
const after: unknown = await ethrex().call("ethrex_simulateFrameTransaction", [encodeTx(profile, replayTx), "latest"]);
const sim = after && typeof after === "object" ? (after as { executionError?: string; revertData?: string }) : {};
const cause = reason(new Error(`${sim.executionError ?? ""} ${sim.revertData ?? ""}`.trim()));
console.log(`replay re-simulated: ${cause || JSON.stringify(after)}`);
if (!/NullifierSpent|nonce/i.test(cause)) throw new Error(`replay not rejected for nonce key / NullifierSpent: ${JSON.stringify(after)}`);

if (weth) {
  await recipientUnwraps();
  await unwrapFees();
}

console.log(`deposit ${explorerTx(depositTx)}`);
console.log(`exit    ${explorerExit(exitHash)}`);

/** Anyone can convert the relay's fee WETH into its ETH float; the depositor pays that tx's gas, so the relay's ETH moves only by the unwrap. */
async function unwrapFees() {
  const abi = parseAbi(["function unwrapFees() returns (uint256)"]);
  const ethBefore = await pub.getBalance({ address: exitRelay! });
  const fees = await wethOf(exitRelay!);
  const hash = await wallet.writeContract({ address: exitRelay!, abi, functionName: "unwrapFees", gas: 500_000n, type: "legacy" });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`unwrapFees ${hash} reverted`);
  const rose = (await pub.getBalance({ address: exitRelay! })) - ethBefore;
  console.log(`unwrapFees ${hash}: relay WETH ${formatEther(fees)} -> ${formatEther(await wethOf(exitRelay!))}, relay ETH +${formatEther(rose)}, gasUsed ${receipt.gasUsed}`);
  if (rose !== fees || (await wethOf(exitRelay!)) !== 0n) throw new Error(`unwrap: relay ETH rose ${rose}, WETH was ${fees}`);
}

/** The refund's point: the recipient, holding no other ETH, pays its own gas to turn the 0.09 WETH into ETH. */
async function recipientUnwraps() {
  const own = createWalletClient({ account: privateKeyToAccount(recipientKey), chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const ethBefore = await pub.getBalance({ address: recipient });
  const hash = await own.writeContract({ address: WETH9, abi: wethAbi, functionName: "withdraw", args: [want], gas: 100_000n, type: "legacy" });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`recipient unwrap ${hash} reverted`);
  const cost = receipt.gasUsed * receipt.effectiveGasPrice;
  const [eth, weth0] = [await pub.getBalance({ address: recipient }), await wethOf(recipient)];
  console.log(`recipient unwrap ${explorerTx(hash)}: gasUsed ${receipt.gasUsed}, cost ${formatEther(cost)} ETH; now ${formatEther(eth)} ETH, ${formatEther(weth0)} WETH`);
  if (weth0 !== 0n || eth !== ethBefore + want - cost) throw new Error(`recipient unwrap: ETH ${eth}, WETH ${weth0}, want ETH ${ethBefore + want - cost}`);
}

/** The `--rr` half: publish the root, prove against it, then gate on VERIFY touching no foreign storage. */
async function exitRR(): Promise<FrameTx> {
  const rrAbi = parseAbi(["function publishRoot()", "event RootPublished(bytes32 indexed root)"]);
  const publishTx = await wallet.writeContract({ address: exitRelay!, abi: rrAbi, functionName: "publishRoot", gas: 400_000n, type: "legacy" });
  const receipt = await pub.waitForTransactionReceipt({ hash: publishTx, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`publishRoot ${publishTx} reverted`);
  const [published] = parseEventLogs({ abi: rrAbi, eventName: "RootPublished", logs: receipt.logs });
  if (!published) throw new Error(`publishRoot ${publishTx} emitted no RootPublished`);
  const root = published.args.root;
  // slotNumber is an EIP-8272-devnet header field viem does not type, so read the raw block.
  const slotOf = async (block: Hex | "latest") => {
    const b = (await ethrex().call("eth_getBlockByNumber", [block, false])) as { slotNumber?: Hex } | null;
    if (!b?.slotNumber) throw new Error(`block ${block} has no slotNumber`);
    return BigInt(b.slotNumber);
  };
  const rootSlot = await slotOf(toHex(receipt.blockNumber));
  console.log(`published root ${root} at block ${receipt.blockNumber} slot ${rootSlot} (${explorerTx(publishTx)})`);
  // A root written in slot S is referenceable from S+1 on (r13 §2).
  for (let i = 0; i < 60 && (await slotOf("latest")) <= rootSlot; i++) await sleep(2000);

  const proof = await proveForRoot(note, root, { recipient, relayer: exitRelay!, fee: EXIT_FEE });
  console.log(`proved for recipient ${recipient} against published root`);
  const tx = await report(exitTxRR({ ...proof, rootSlot }, { exitRelayRR: exitRelay! }));

  // ERC-7562 trace (ethrex erc7562_tracer.rs): erc7562Trace = [{ frameIndex, root: call scope }], each scope
  // { from, to, type, calls?, accessedSlots: { reads, writes, ... } }; storage belongs to `from` under DELEGATECALL, else `to`.
  type Scope = { from: Address; to?: Address | null; type: string; calls?: Scope[]; accessedSlots: { reads: object; writes: object } };
  const traced = (await ethrex().simulateFrameTransaction(encodeTx(profile, tx), true)) as {
    erc7562Trace?: { frameIndex: number; root: Scope }[] | null;
    erc7562TraceError?: string | null;
  };
  const verify = traced.erc7562Trace?.find((f) => f.frameIndex === 1);
  if (!verify) throw new Error(`no VERIFY frame 1 trace: ${traced.erc7562TraceError ?? JSON.stringify(traced)}`);
  const foreign = new Set<string>();
  const walk = (c: Scope) => {
    const owner = c.type === "DELEGATECALL" ? c.from : c.to;
    const touched = Object.keys(c.accessedSlots.reads).length + Object.keys(c.accessedSlots.writes).length > 0;
    if (touched && (!owner || !isAddressEqual(owner, exitRelay!))) foreign.add(owner ?? "<create>");
    c.calls?.forEach(walk);
  };
  walk(verify.root);
  console.log(`foreign storage reads in VERIFY: ${foreign.size ? [...foreign].join(", ") : "none"}`);
  if (foreign.size) process.exit(1);
  return tx;
}
