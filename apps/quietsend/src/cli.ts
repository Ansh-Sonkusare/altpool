#!/usr/bin/env tsx
// quietsend deposit | withdraw <note> [recipient]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway } from "@altpool/core";
import { createNote, noteToString, parseNote, prove } from "@altpool/prover";
import { EXIT_FEE, deployments, depositNote, exitTx, sendExit } from "@altpool/contracts";

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
  const sim = await ethrex().simulateFrameTransaction(encodeTx(getProfile(DEVNET.profile), tx));
  console.log(sim.canonicalMempoolValid ? "public: accepted" : `public: rejected (${sim.canonicalMempoolViolation ?? "?"})`);
  const before = await pub.getBalance({ address: recipient });
  const r = await sendExit(tx);
  console.log(`included in block ${r.blockNumber}, status ${r.status}, gasUsed ${r.gasUsed}`);
  r.frames.forEach((f, i) => console.log(`  frame ${i}: status ${f.status} gasUsed ${f.gasUsed} stateGasUsed ${f.stateGasUsed}`));
  const after = await pub.getBalance({ address: recipient });
  console.log(`recipient ${recipient}: ${formatEther(before)} -> ${formatEther(after)} ETH\n${explorerTx(r.hash)}`);
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
  process.exit(1);
}
