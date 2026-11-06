#!/usr/bin/env tsx
// quietsend deposit | withdraw <note> [recipient]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { AltpoolSdkError, altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET, altDevnet, explorerTx, gateway } from "@altpool/core";
import { createNote, noteToString, parseNote, prove } from "@altpool/prover";
import { EXIT_FEE, MINER_SIDECAR, deployments, depositNote, explorerExit, exitTx } from "@altpool/contracts";
import { createSimulator, renderChecks, renderVerdict } from "@altpool/simulator";

const [cmd, noteArg, recipientArg] = process.argv.slice(2);
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const envFile = new URL("../.env", import.meta.url);

function walletKey(): Hex {
  const fromEnv = process.env.QS_PK ?? (existsSync(envFile) ? readFileSync(envFile, "utf8").match(/^QS_PK=(0x[0-9a-fA-F]{64})$/m)?.[1] : undefined);
  if (fromEnv) return fromEnv as Hex;
  const pk = generatePrivateKey();
  appendFileSync(envFile, `QS_PK=${pk}\n`);
  console.log(`generated wallet key, saved to ${envFile.pathname}`);
  return pk;
}

async function deposit() {
  const account = privateKeyToAccount(walletKey());
  const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const need = DEVNET.denomination + parseEther("0.01");
  if ((await pub.getBalance({ address: account.address })) < need) {
    await gateway().faucet(account.address);
    for (let i = 0; i < 60 && (await pub.getBalance({ address: account.address })) < need; i++) await sleep(2000);
  }
  const note = createNote();
  appendFileSync(envFile, `NOTE_${note.commitment.slice(2, 10)}=${noteToString(note)}\n`);
  const hash = await depositNote(wallet, note);
  console.log(`deposited ${formatEther(DEVNET.denomination)} ETH from ${account.address}\nnote ${noteToString(note)}\n${explorerTx(hash)}`);
}

async function withdraw(noteStr: string, to?: string) {
  const exitRelay = deployments.exitRelay as Address | null;
  if (!exitRelay) throw new Error("deployments.json has no exitRelay: deploy ExitRelay first");
  if (to && !isAddress(to)) throw new Error(`bad recipient ${to}`);
  let recipient = to as Address | undefined;
  if (!recipient) {
    const key = generatePrivateKey();
    recipient = privateKeyToAccount(key).address;
    appendFileSync(envFile, `RECIPIENT_${recipient}=${key}\n`);
    console.log(`recipient ${recipient} (key saved to apps/quietsend/.env)`);
  }
  const proof = await prove(parseNote(noteStr), { recipient, relayer: exitRelay, fee: EXIT_FEE });
  const tx = exitTx(proof, { exitRelay });
  // Prefix budget, not one frame: the model sums expiry (10k) + VERIFY (450k); core's 350k default would reject every exit.
  try {
    const sim = await createSimulator({ verifyGasMax: 460_000n, explorer: false }).check(tx);
    console.log("simulator (checkAdmission):");
    for (const v of [sim.verdicts.public, sim.verdicts.alt]) console.log(renderVerdict(v).join("\n"));
    if (sim.verdicts.alt.checks?.length) console.log(renderChecks(sim.verdicts.alt.checks));
  } catch (e) {
    console.log(`simulator: unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
  const sidecar = createAltMempoolClient({ httpUrl: MINER_SIDECAR, profile, name: "miner" });
  const client = pub.extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));
  const pre = await client.altpool.preflightFrameTransaction({ transaction: tx });
  for (const [label, m] of [["public", pre.public], ["alt", pre.alternative]] as const) {
    console.log(`preflight ${label}: ${m.status}`);
    for (const c of m.checks) if (c.status !== "pass") console.log(`  ${c.stage} ${c.rule} ${c.status}: ${c.message}`);
  }
  if (pre.alternative.checks.some((c) => c.stage === "estimate" && c.status === "fail")) {
    console.log("note: the estimator rewrites body-frame gas to 10M, so ExitRelay's withdraw-gas pin rejects the probe (prediction only)");
  }
  const before = await pub.getBalance({ address: recipient });
  // submit, not send: the exit sender is the ExitRelay contract (zero signatures) and ExitRelay pins frame gas.
  const sent = await client.altpool.submitFrameTransaction({ transaction: tx });
  console.log(`submitted ${sent.hash}`);
  const { receipt: r } = await client.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 180_000, throwOnRevert: true });
  console.log(`included in block ${r.blockNumber}, status ${r.status}${r.gasUsed === undefined ? "" : `, gasUsed ${r.gasUsed}`}`);
  r.frames.forEach((f) => console.log(`  frame ${f.index}: status ${f.status} gasUsed ${f.gasUsed.execution} stateGasUsed ${f.gasUsed.state}`));
  const report = await client.altpool.getAdmissionReport({ hash: sent.hash });
  if (!report) console.log("admission report: none on this node");
  else {
    console.log(`admission report: ${report.outcome}`);
    for (const c of report.checks) console.log(`  ${c.rule} ${c.verdict}${c.frameIndex !== undefined ? ` frame ${c.frameIndex}` : ""}${c.entity ? ` ${c.entity}` : ""}${c.detail ? `: ${c.detail}` : ""}`);
  }
  const after = await pub.getBalance({ address: recipient });
  console.log(`recipient ${recipient}: ${formatEther(before)} -> ${formatEther(after)} ETH\n${explorerExit(sent.hash)}`);
  const want = DEVNET.denomination - EXIT_FEE;
  if (after - before !== want) throw new Error(`recipient balance rose by ${after - before}, expected ${want}`);
}

try {
  if (cmd === "deposit") await deposit();
  else if (cmd === "withdraw" && noteArg) await withdraw(noteArg, recipientArg);
  else {
    console.error("usage: quietsend deposit | withdraw <note> [recipient]");
    process.exit(2);
  }
} catch (e) {
  console.error(`quietsend: ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof AltpoolSdkError && e.fix) console.error(`fix: ${e.fix}`);
  process.exit(1);
}
