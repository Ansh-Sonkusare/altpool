// IP3 lever: deposit a fresh note, exit it through the deployed ExitRelay to a 0-ETH recipient, then replay it.
// `--junk` instead sends one exit with a zeroed proof against a known root: reaching BadProof proves every frame
// opcode read in ExitRelay's VERIFY worked on this devnet.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatEther,
  http,
  parseAbi,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway, toWire, type WithdrawProof } from "@altpool/core";
import { createNote, noteToString, prove } from "../../prover/src/index";
import { EXIT_FEE, exitTx } from "../src/exit";
import { MINER_SIDECAR, depositNote, sendExit } from "../src/flow";
import deployments from "../deployments.json";

const exitRelay = deployments.exitRelay as Address | null;
if (!exitRelay) throw new Error("deployments.json has no exitRelay: run `bun run --filter @altpool/contracts deploy` first");
const errorAbi = (JSON.parse(readFileSync(new URL("../out/ExitRelay.sol/ExitRelay.json", import.meta.url), "utf8")).abi as Abi).filter(
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
  const tx = exitTx(p, { exitRelay: exitRelay! });
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
  const root = await pub.readContract({ address: DEVNET.pool, abi: poolAbi, functionName: "getLastRoot" });
  let rootIdx = -1;
  for (let i = 0; i < DEVNET.rootHistorySize && rootIdx < 0; i++) {
    if ((await pub.readContract({ address: DEVNET.pool, abi: poolAbi, functionName: "roots", args: [BigInt(i)] })) === root) rootIdx = i;
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
const depositTx = await depositNote(wallet, note);
console.log(`deposited ${formatEther(DEVNET.denomination)} ETH (${depositTx}); note ${noteToString(note)}`);

const recipient = randomAddress();
const proof = await prove(note, { recipient, relayer: exitRelay, fee: EXIT_FEE });
console.log(`proved for recipient ${recipient}, rootIdx ${proof.rootIdx}`);
const tx = await exitFor(proof);

const r = await sendExit(tx, { sendUrl: send.url });
const exitHash = r.hash;
console.log(`exit sent ${exitHash}`);
console.log(`included in block ${r.blockNumber}, status ${r.status}, gasUsed ${r.gasUsed}`);
r.frames.forEach((f, i) => console.log(`  frame ${i}: status ${f.status} gasUsed ${f.gasUsed} stateGasUsed ${f.stateGasUsed}`));

const got = await pub.getBalance({ address: recipient });
const want = DEVNET.denomination - EXIT_FEE;
console.log(`recipient balance ${formatEther(got)} ETH (want ${formatEther(want)})`);
if (got !== want) throw new Error(`recipient balance ${got} != ${want}`);

for (const sidecar of new Set([send.url, gw.url])) {
  try {
    const replay = await gateway(sidecar).sendFrameTransaction(toWire(tx));
    throw new Error(`replay ADMITTED ${replay} by ${sidecar}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("replay ADMITTED")) throw e;
    console.log(`replay rejected by ${sidecar}: ${reason(e)}`);
  }
}

// Replay gate. The sidecars' rejection text is the public-mempool violation, not the cause, so re-simulate the
// same tx after inclusion and require the consumed nonce key or ExitRelay's NullifierSpent.
const after: unknown = await ethrex().call("ethrex_simulateFrameTransaction", [encodeTx(profile, tx), "latest"]);
const sim = after && typeof after === "object" ? (after as { executionError?: string; revertData?: string }) : {};
const cause = reason(new Error(`${sim.executionError ?? ""} ${sim.revertData ?? ""}`.trim()));
console.log(`replay re-simulated: ${cause || JSON.stringify(after)}`);
if (!/NullifierSpent|nonce/i.test(cause)) throw new Error(`replay not rejected for nonce key / NullifierSpent: ${JSON.stringify(after)}`);

console.log(`deposit ${explorerTx(depositTx)}`);
console.log(`exit    ${explorerTx(exitHash)}`);
