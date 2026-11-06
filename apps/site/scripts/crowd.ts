// Runs the demo crowd: about 8 persistent devnet accounts that deposit 0.1 WETH into the WETH pool at random times
// and withdraw the crowd's notes (any account's, random order) through ExitRelayToken to fresh recipients.
// Usage: bun scripts/crowd.ts [--minutes M] [--accounts 8] [--deposit-mean 120] [--withdraw-mean 240] [--keep 2]
//        bun scripts/crowd.ts --status
// State (keys and notes) lives in apps/site/.crowd.local.json, gitignored. Nothing secret is ever printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";
import { createNote, parseNote, noteToString, prove } from "@altpool/prover";
import { EXIT_FEE, depositNoteWeth, deployments, exitTx, sendExit } from "@altpool/contracts";
import { WETH_EXIT_REFUND } from "../../../packages/contracts/src/exit";

const STATE_FILE = new URL("../.crowd.local.json", import.meta.url);
const FAUCET_GAP_MS = 61 * 60_000; // faucet: 1 ETH per address per hour
const FAUCET_PER_HOUR = 20; // gateway allows ~100/hour globally; stay far under
const HOUR = 3_600_000;

interface State {
  accounts: { key: Hex; lastFaucet?: number }[];
  notes: { note: string; attempts: number }[];
  faucetLog: number[];
  deposits: number;
  withdrawals: number;
}

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? d : Number(process.argv[i + 1]);
};
const dep = deployments as Record<string, unknown>;
const pool = dep.wethPool as Address;
const exitRelay = dep.exitRelayWETH as Address;
if (!pool || !exitRelay) throw new Error("deployments.json needs wethPool and exitRelayWETH");

const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const gw = gateway();
const need = DEVNET.denomination + parseEther("0.02");
const wallets = (s: State) => s.accounts.map((a) => privateKeyToAccount(a.key));

function load(n: number): State {
  const s: State = existsSync(STATE_FILE)
    ? { deposits: 0, withdrawals: 0, faucetLog: [], ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }
    : { accounts: [], notes: [], faucetLog: [], deposits: 0, withdrawals: 0 };
  while (s.accounts.length < n) s.accounts.push({ key: generatePrivateKey() });
  return s;
}
const save = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), { mode: 0o600 });
const exp = (meanSec: number) => -Math.log(1 - Math.random()) * meanSec * 1000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const n = arg("accounts", 8);
const state = load(n);

save(state);
if (process.argv.includes("--status")) {
  for (const [i, a] of wallets(state).entries()) {
    console.log(`#${i} ${a.address} ${formatEther(await pub.getBalance({ address: a.address }))} ETH`);
  }
  const drips = state.faucetLog.filter((t) => Date.now() - t < HOUR).length;
  console.log(`pending notes ${state.notes.length}, deposits ${state.deposits}, withdrawals ${state.withdrawals}, faucet drips last hour ${drips}`);
  process.exit(0);
}

save(state);
let stop = false;
process.on("SIGINT", () => ((stop = true), log("stopping after the current action")));
const deadline = process.argv.includes("--minutes") ? Date.now() + arg("minutes", 30) * 60_000 : Infinity;
const running = () => !stop && Date.now() < deadline;
// Sleep in slices so Ctrl-C and --minutes end the run promptly.
async function wait(ms: number) {
  const end = Date.now() + ms;
  while (running() && Date.now() < end) await sleep(Math.min(1000, end - Date.now()));
}

/** Ask the faucet for account i if it is empty, due, and the hourly budget allows. Returns whether it is funded. */
async function fund(i: number): Promise<boolean> {
  const a = wallets(state)[i];
  if ((await pub.getBalance({ address: a.address })) >= need) return true;
  const rec = state.accounts[i];
  state.faucetLog = state.faucetLog.filter((t) => Date.now() - t < HOUR);
  if ((rec.lastFaucet && Date.now() - rec.lastFaucet < FAUCET_GAP_MS) || state.faucetLog.length >= FAUCET_PER_HOUR) return false;
  rec.lastFaucet = Date.now();
  state.faucetLog.push(Date.now());
  save(state);
  try {
    const res = await gw.faucet(a.address);
    log(`faucet #${i} ${short(a.address)} ${JSON.stringify(res)}`);
  } catch (e) {
    log(`faucet #${i} refused: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  for (let k = 0; k < 60 && running(); k++) {
    if ((await pub.getBalance({ address: a.address })) >= need) return true;
    await sleep(2000);
  }
  return false;
}

async function depositLoop() {
  for (let first = true; running(); first = false) {
    await wait(first ? 5000 : exp(arg("deposit-mean", 120)));
    if (!running()) break;
    const order = state.accounts.map((_, i) => i).sort(() => Math.random() - 0.5);
    let done = false;
    for (const i of order) {
      if (!(await fund(i))) continue;
      const a = wallets(state)[i];
      const wallet = createWalletClient({ account: a, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
      const note = createNote();
      try {
        const hash = await depositNoteWeth(wallet, note, pool);
        state.notes.push({ note: noteToString(note), attempts: 0 });
        state.deposits++;
        save(state);
        log(`deposit #${i} ${short(a.address)} ${hash}`);
        done = true;
      } catch (e) {
        log(`deposit #${i} failed: ${e instanceof Error ? e.message : e}`);
      }
      break;
    }
    if (!done) log("deposit skipped: no funded account (faucet budget or cooldown)");
  }
}

async function withdrawLoop() {
  const keep = arg("keep", 2); // leave a few notes in the pool so a payer always has company
  while (running()) {
    await wait(exp(arg("withdraw-mean", 240)));
    if (!running()) break;
    if (state.notes.length <= keep) continue;
    const idx = Math.floor(Math.random() * state.notes.length);
    const entry = state.notes[idx];
    const recipient = privateKeyToAccount(generatePrivateKey()).address; // key discarded
    try {
      const p = await prove(parseNote(entry.note), { recipient, relayer: exitRelay, fee: EXIT_FEE, refund: WETH_EXIT_REFUND }, pool);
      const r = await sendExit(exitTx(p, { exitRelay, pool }));
      state.notes.splice(state.notes.findIndex((x) => x.note === entry.note), 1);
      state.withdrawals++;
      save(state);
      log(`withdraw ${r.hash} to ${short(recipient)} block ${r.blockNumber}`);
    } catch (e) {
      entry.attempts++;
      if (entry.attempts >= 3) state.notes.splice(state.notes.indexOf(entry), 1);
      save(state);
      log(`withdraw failed (attempt ${entry.attempts}): ${e instanceof Error ? e.message.slice(0, 300) : e}`);
    }
  }
}

log(`crowd of ${n} accounts on ${short(pool)}; ${state.notes.length} pending notes from earlier runs`);
for (const [i, a] of wallets(state).entries()) log(`account #${i} ${a.address}`);
await Promise.all([depositLoop(), withdrawLoop()]);
save(state);
log(`stopped: ${state.deposits} deposits, ${state.withdrawals} withdrawals, ${state.notes.length} pending`);
process.exit(0);
