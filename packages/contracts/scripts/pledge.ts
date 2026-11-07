// Pledge Paid (research repo derisk/notes/r16): one 9-frame tx withdraws a WETH note to a proof-bound Settler, unwraps,
// swaps on Uniswap v4 to fgUSD, settles an invoice, returns the change and checks nothing is left.
//   bun scripts/pledge.ts [--deploy] [--runs pay,revert] [--invoice <id>]
// `pay` creates an invoice and pays it. `revert` points a fresh note at the same, now paid, invoice: frame 6 reverts,
// frames 3..8 roll back, the withdraw and the relay's fee stay, the funds wait at the Settler address, and refund()
// returns them to the change address.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import { altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET, altDevnet, explorerTx, gateway } from "@altpool/core";
import { createNote, prove } from "@altpool/prover";
import { createSimulator } from "@altpool/simulator";
import { EXIT_FEE } from "../src/exit";
import { MINER_SIDECAR, depositNoteWeth, explorerExit } from "../src/flow";
import { invoiceBookAbi, payTx, settlerAbi, settlerAddress, settlerFactoryAbi, type Terms } from "../src/pay";
import { WETH9, wethAbi } from "../src/pools";
import { deployerKey, ensureFunded, mergeDeployments, readDeployments } from "./deployer";

const POOL_MANAGER: Address = "0x6bF9Aa9c04fd001385742d61f6818C3236429848";
const STATE_VIEW: Address = "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB";
const QUOTER: Address = "0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D";
/** fgUSD ("FrameGas USD", 6 decimals): another team's test token on the hookless ETH/fgUSD 0.3% pool (r5). */
const FGUSD: Address = "0x1f9abb072fe931007f58cd7fc56459615e35b908";
const ETH: Address = "0x0000000000000000000000000000000000000000";
const POOL_KEY = [ETH, FGUSD, 3000, 60, ETH] as const;
/** ~0.023 ETH of a pool ~1 ETH deep (~2% impact at the Nov 7 price). */
const INVOICE_AMOUNT = 50_000_000n;
const SLIPPAGE_PCT = 3n;
const FLOAT = parseEther("0.05");
const STAKE = parseEther("0.012");

const arg = (name: string) => process.argv.find((_, i) => process.argv[i - 1] === name);
const runs = (arg("--runs") ?? "pay,revert").split(",");
const profile = getProfile(DEVNET.profile);
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const sidecar = createAltMempoolClient({ httpUrl: MINER_SIDECAR, profile, name: "miner" });
const ap = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(altpoolActions({ sidecar })).altpool;
const deployer = privateKeyToAccount(deployerKey());
const wallet = createWalletClient({ account: deployer, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** Our VERIFY pin for this relay is 600k (PayChecks.PAY_VERIFY_GAS_MAX), not the simulator's 450k exit default. */
/** Its explorer verdict comes from the miner sidecar, the node these txs are sent to. */
const simulator = createSimulator({ verifyGasMax: 600_000n, gateway: gateway(MINER_SIDECAR) });
const checkAdmission = simulator.check;
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

async function mined(hash: Hex, what: string) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${what} ${hash} reverted`);
  return r;
}

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), "utf8"));

async function deployContract(name: string, args: unknown[], value = 0n): Promise<{ address: Address; tx: Hex }> {
  const art = artifact(name);
  const tx = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args, value, type: "legacy" });
  const address = (await mined(tx, `deploy ${name}`)).contractAddress!;
  console.log(`${name} ${address} (${explorerTx(tx)})`);
  return { address, tx };
}

await ensureFunded(pub, deployer, parseEther("0.3"));
const prior = readDeployments() ?? {};
if (process.argv.includes("--deploy") || !prior.payRelayWETH) {
  const factory = await deployContract("SettlerFactory", [WETH9, POOL_MANAGER, FGUSD, 3000, 60]);
  const book = await deployContract("InvoiceBook", []);
  const relay = await deployContract("PayRelayWETH", [prior.wethPool, prior.verifier, EXIT_FEE, WETH9, factory.address, book.address], FLOAT);
  const stakedAt = await wallet.writeContract({
    address: relay.address,
    abi: artifact("PayRelayWETH").abi,
    functionName: "stake",
    args: [DEVNET.stakingRegistry, DEVNET.unstakeDelaySec],
    value: STAKE,
    gas: 300_000n,
    type: "legacy",
  });
  await mined(stakedAt, "stake");
  const stake = await ap.getEntityStake(relay.address);
  console.log(`staked ${j(stake)}`);
  mergeDeployments({
    settlerFactory: factory.address,
    settlerFactoryTx: factory.tx,
    invoiceBook: book.address,
    invoiceBookTx: book.tx,
    payRelayWETH: relay.address,
    payRelayWETHDeployTx: relay.tx,
    payRelayWETHStakedAt: stakedAt,
  });
}
const d = readDeployments()!;
const [payRelay, factory, book, wethPool] = [d.payRelayWETH, d.settlerFactory, d.invoiceBook, d.wethPool] as Address[];
const settlerCodeHash = await pub.readContract({ address: factory, abi: settlerFactoryAbi, functionName: "settlerCodeHash" });

/** Third-party liquidity: read it fresh and price the invoice with the v4 quoter. */
async function quoteInvoice(): Promise<bigint> {
  const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], POOL_KEY));
  const sv = parseAbi(["function getLiquidity(bytes32) view returns (uint128)", "function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)"]);
  const liquidity = await pub.readContract({ address: STATE_VIEW, abi: sv, functionName: "getLiquidity", args: [id] });
  const [sqrtP] = await pub.readContract({ address: STATE_VIEW, abi: sv, functionName: "getSlot0", args: [id] });
  const quoterAbi = parseAbi(["function quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256 amountIn, uint256 gasEstimate)"]);
  const r = await pub.call({ to: QUOTER, account: deployer.address, data: encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactOutputSingle", args: [[POOL_KEY, true, INVOICE_AMOUNT, "0x"]] }) });
  const [amountIn] = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactOutputSingle", data: r.data! });
  const price = (Number(sqrtP) / 2 ** 96) ** 2 * 1e12;
  console.log(`fgUSD pool ${id}: liquidity ${liquidity}, ~${price.toFixed(1)} fgUSD/ETH; ${formatUnits(INVOICE_AMOUNT, 6)} fgUSD costs ${formatEther(amountIn)} ETH`);
  if (liquidity === 0n) throw new Error("fgUSD pool has no liquidity: re-scan Initialize logs for another pool (r5)");
  return amountIn;
}

async function createInvoice(payee: Address): Promise<bigint> {
  const hash = await wallet.writeContract({ address: book, abi: invoiceBookAbi, functionName: "create", args: [payee, FGUSD, INVOICE_AMOUNT], type: "legacy" });
  const [created] = parseEventLogs({ abi: invoiceBookAbi, eventName: "Created", logs: (await mined(hash, "create invoice")).logs });
  console.log(`invoice ${created!.args.id}: ${formatUnits(INVOICE_AMOUNT, 6)} fgUSD to the fund (${explorerTx(hash)})`);
  return created!.args.id;
}

async function freshDonor() {
  const donor = privateKeyToAccount(generatePrivateKey());
  console.log(`donor ${donor.address}, faucet ${j(await gateway().faucet(donor.address))}`);
  for (let i = 0; i < 60 && (await pub.getBalance({ address: donor.address })) < DEVNET.denomination + parseEther("0.01"); i++) await sleep(2000);
  return createWalletClient({ account: donor, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
}

const wethOf = (a: Address) => pub.readContract({ address: WETH9, abi: wethAbi, functionName: "balanceOf", args: [a] });
const fgOf = (a: Address) => pub.readContract({ address: FGUSD, abi: erc20, functionName: "balanceOf", args: [a] });
const snapshot = async (fund: Address, change: Address, settler: Address) => ({
  fundFg: await fgOf(fund),
  changeEth: await pub.getBalance({ address: change }),
  relayWeth: await wethOf(payRelay),
  relayEth: await pub.getBalance({ address: payRelay }),
  settlerWeth: await wethOf(settler),
  settlerEth: await pub.getBalance({ address: settler }),
  settlerFg: await fgOf(settler),
  settlerCode: ((await pub.getCode({ address: settler })) ?? "0x").length > 2,
});

function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
}

async function pledge(kind: "pay" | "revert", invoiceId: bigint, fund: Address) {
  console.log(`\n=== ${kind} run ===`);
  const maxIn = ((await quoteInvoice()) * (100n + SLIPPAGE_PCT)) / 100n;
  const donor = await freshDonor();
  const note = createNote();
  const depositTx = await depositNoteWeth(donor, note, wethPool);
  console.log(`deposited 0.1 WETH (${explorerTx(depositTx)})`);
  const change = privateKeyToAccount(generatePrivateKey()).address; // the donor's fresh change address; key never printed
  const terms: Terms = { invoiceId, book, amount: INVOICE_AMOUNT, maxIn, change };
  const settler = settlerAddress(factory, settlerCodeHash, terms);
  const onChain = await pub.readContract({ address: factory, abi: settlerFactoryAbi, functionName: "addressOf", args: [terms] });
  if (!isAddressEqual(settler, onChain)) throw new Error(`TS Settler ${settler} != factory.addressOf ${onChain}`);
  const proof = await prove(note, { recipient: settler, relayer: payRelay, fee: EXIT_FEE, refund: 0n }, wethPool);
  console.log(`proved: recipient = Settler ${settler}, change ${change}, rootIdx ${proof.rootIdx}`);
  const gp = await ap.getGasPrice();
  const cap = payTx(proof, { payRelay, pool: wethPool, factory, settlerCodeHash, terms }).fees.maxFeePerGas; // the tip must not exceed the fee cap
  const tx: FrameTx = payTx(proof, { payRelay, pool: wethPool, factory, settlerCodeHash, terms, maxPriorityFeePerGas: gp.maxPriorityFeePerGas < cap ? gp.maxPriorityFeePerGas : cap });

  const admission = await checkAdmission(tx);
  console.log(`checkAdmission (before send): ${j(admission.verdicts)}`);
  const sim = await ap.simulateFrameTransaction({ transaction: tx });
  console.log(`ethrex_simulateFrameTransaction: status ${sim.executionStatus}${sim.executionError ? ` (${sim.executionError})` : ""}, valid ${sim.valid}${sim.violation ? ` (${sim.violation})` : ""}`);
  sim.frames?.forEach((f, i) => console.log(`  sim frame ${i}: ${f.succeeded ? "ok" : "FAILED"} gas ${f.gasUsed}`));
  const simOk = sim.frames?.length === 9 && (kind === "pay" ? sim.frames.every((f) => f.succeeded) : !sim.frames[6]!.succeeded && sim.frames.slice(0, 6).every((f) => f.succeeded));
  if (!simOk) throw new Error(`simulation does not match the ${kind} run; not sending`);

  const before = await snapshot(fund, change, settler);
  const { hash } = await ap.submitFrameTransaction({ transaction: tx });
  console.log(`sent ${hash}`);
  const { receipt: r } = await ap.waitForFrameTransactionReceipt({ hash, timeoutMs: 180_000 });
  console.log(`included in block ${r.blockNumber}, tx status ${r.status}, payer ${(r as { payer?: Address }).payer ?? "?"}`);
  const names = ["expiry", "VERIFY PayRelayWETH", "withdraw", "factory.deploy", "unwrap", "swap", "settle", "sweep", "assertSettled"];
  r.frames.forEach((f, i) => console.log(`  frame ${i} ${names[i]}: ${f.status}, gas ${f.gasUsed.execution} + state ${f.gasUsed.state}, logs ${f.logs?.length ?? 0}`));
  const after = await snapshot(fund, change, settler);
  console.log(`before ${j(before)}\nafter  ${j(after)}`);
  const paidOut = DEVNET.denomination - EXIT_FEE;

  check(after.relayWeth - before.relayWeth === EXIT_FEE, `relay WETH +${formatEther(after.relayWeth - before.relayWeth)} (fee repaid), relay ETH ${formatEther(after.relayEth - before.relayEth)} (gas)`);
  check(r.frames[2]!.status === "success" && (r.frames[2]!.logs?.length ?? 0) > 0, "frame 2 withdraw kept (success, logs)");
  if (kind === "pay") {
    check(r.status === "success" && r.frames.every((f) => f.status === "success"), "all 9 frames success");
    check(after.fundFg - before.fundFg === INVOICE_AMOUNT, `fund +${formatUnits(after.fundFg - before.fundFg, 6)} fgUSD`);
    check(await pub.readContract({ address: book, abi: invoiceBookAbi, functionName: "paid", args: [invoiceId] }), `invoice ${invoiceId} paid`);
    check(after.settlerCode && after.settlerEth === 0n && after.settlerWeth === 0n && after.settlerFg === 0n, "Settler deployed and empty");
    check(after.changeEth > 0n && after.changeEth < paidOut, `change ${formatEther(after.changeEth)} ETH at the fresh address`);
  } else {
    check(r.frames[6]!.status !== "success", `frame 6 settle ${r.frames[6]!.status}`);
    check(r.frames.slice(3).every((f) => (f.logs?.length ?? 0) === 0), "frames 3..8 rolled back (no logs)");
    check(!after.settlerCode && after.settlerWeth === paidOut && after.changeEth === 0n, `${formatEther(after.settlerWeth)} WETH parked at the code-less Settler address`);
    check(after.fundFg === before.fundFg, "fund unchanged");
    await rescue(terms, settler, change, paidOut);
  }
  console.log(`checkAdmission (after send): ${j((await checkAdmission(tx)).verdicts)}`);
  const rep = await ap.getAdmissionReport({ hash });
  console.log(`miner admission record: outcome ${rep?.outcome}, failed ${j(rep?.failed)}, events ${rep?.events.map((e) => e.kind).join(",")}`);
  console.log(`tx ${explorerExit(hash)}`);
  return hash;
}

/** The parked funds' way home: anyone deploys the Settler with the same terms and calls refund() (invoice already paid). */
async function rescue(terms: Terms, settler: Address, change: Address, paidOut: bigint) {
  const deploy = await wallet.writeContract({ address: factory, abi: settlerFactoryAbi, functionName: "deploy", args: [terms], type: "legacy" });
  await mined(deploy, "rescue deploy");
  const refund = await wallet.writeContract({ address: settler, abi: settlerAbi, functionName: "refund", gas: 300_000n, type: "legacy" });
  await mined(refund, "refund");
  check((await wethOf(change)) === paidOut && (await wethOf(settler)) === 0n, `rescue: deploy ${explorerTx(deploy)}, refund ${explorerTx(refund)}: change holds ${formatEther(paidOut)} WETH`);
}

console.log(`PayRelayWETH ${payRelay}, SettlerFactory ${factory}, InvoiceBook ${book}`);
let fund: Address;
let invoiceId: bigint;
if (arg("--invoice")) {
  invoiceId = BigInt(arg("--invoice")!);
  [fund] = await pub.readContract({ address: book, abi: invoiceBookAbi, functionName: "invoices", args: [invoiceId] });
} else {
  fund = privateKeyToAccount(generatePrivateKey()).address;
  invoiceId = await createInvoice(fund);
}
console.log(`invoice ${invoiceId}, fund ${fund}`);
for (const kind of runs) await pledge(kind as "pay" | "revert", invoiceId, fund);
