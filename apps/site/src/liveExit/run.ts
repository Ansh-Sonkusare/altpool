// One live QuietSend exit, end to end in the browser: fresh depositor -> faucet -> deposit -> tree -> proof -> exit tx ->
// checkAdmission -> miner sidecar -> receipt -> recipient balance. Keys and the note stay in this function's locals.
import "./shim";
import { createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { modeName, scopeName } from "altpool";
import { DEVNET, altDevnet, explorerTx, gateway } from "@altpool/core";
import { EXIT_FEE, depositNote, exitTx } from "@altpool/contracts";
import { renderReport } from "@altpool/simulator";
import { addrUrl, client, exitUrl, profile, simulator } from "../altpool";
import { EXIT_RELAY, PAYOUT } from "../live";
import { createNote } from "./note";
import { prove } from "./prove";
import { blankSteps, type Fact, type RunResult, type StepId, type Steps, type StepState } from "./steps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const n = (x: number | bigint) => x.toLocaleString("en-US");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const FRAME_LABELS = ["deadline check", "ExitRelay proof check, pays the gas", "pool.withdraw"];

export async function runLiveExit(onChange: (s: Steps) => void): Promise<RunResult> {
  const t0 = performance.now();
  const steps = blankSteps();
  const put = (id: StepId, patch: Partial<StepState>) => { steps[id] = { ...steps[id], ...patch }; onChange({ ...steps }); };
  /** Add a fact, or replace the one with the same key in place. */
  const fact = (id: StepId, f: Fact) => {
    const facts = steps[id].facts;
    put(id, { facts: facts.some((x) => x.k === f.k) ? facts.map((x) => (x.k === f.k ? f : x)) : [...facts, f] });
  };
  const step = async <T,>(id: StepId, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    put(id, { status: "running", startedAt: Date.now() });
    try {
      const r = await fn();
      put(id, { status: "done", ms: performance.now() - t });
      return r;
    } catch (e) {
      put(id, { status: "error", ms: performance.now() - t, error: msg(e) });
      throw e;
    }
  };

  const { account, recipient, note } = await step("keys", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey()).address; // its key is dropped here: the payout stays at this address
    const note = createNote();
    fact("keys", { k: "depositor", v: account.address, href: addrUrl(account.address) });
    fact("keys", { k: "recipient", v: recipient, href: addrUrl(recipient) });
    fact("keys", { k: "note commitment", v: short(note.commitment) });
    return { account, recipient, note };
  });

  await step("faucet", async () => {
    const need = DEVNET.denomination + parseEther("0.01");
    const res: unknown = await gateway().faucet(account.address);
    const hash = typeof res === "string" ? res : (res as { hash?: string; txHash?: string } | null)?.hash ?? (res as { txHash?: string } | null)?.txHash;
    if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) fact("faucet", { k: "faucet tx", v: short(hash), href: explorerTx(hash) });
    for (let i = 0; i < 60; i++) {
      // A dropped poll is not a failed faucet: skip it and ask again.
      const balance = await client.getBalance({ address: account.address }).catch(() => undefined);
      if (balance !== undefined) {
        fact("faucet", { k: "depositor balance", v: `${formatEther(balance)} ETH`, tone: balance >= need ? "ok" : undefined });
        if (balance >= need) return;
      }
      await sleep(2000);
    }
    throw new Error("the faucet did not pay out within 120 s");
  });

  await step("deposit", async () => {
    const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
    const hash = await depositNote(wallet, note);
    fact("deposit", { k: "deposit tx", v: short(hash), href: explorerTx(hash) });
    fact("deposit", { k: "amount", v: `${formatEther(DEVNET.denomination)} ETH, one pool denomination` });
  });

  const path = await step("tree", async () => {
    const { rebuildTree } = await import("./tree");
    const p = await rebuildTree(note);
    fact("tree", { k: "leaves", v: `${n(p.leafCount)} deposits rebuilt; ours is leaf ${p.leafIndex}` });
    fact("tree", { k: "local root", v: short(p.root) });
    fact("tree", { k: "pool getLastRoot()", v: short(p.chainRoot), tone: "ok" });
    fact("tree", { k: "match", v: `local root = pool root; roots(${p.rootIdx}) read back`, tone: "ok" });
    return p;
  });

  const proved = await step("prove", () =>
    prove(note, path, { recipient, relayer: EXIT_RELAY, fee: EXIT_FEE }, (why) => {
      fact("prove", { k: "browser prover", v: `failed: ${why}`, tone: "bad" });
      put("prove", { note: "Fell back to the prover server, which received this run's note secret. Anyone running that server can link the deposit to the exit." });
    }),
  );
  fact("prove", { k: "prover", v: proved.via === "browser" ? "websnark (wasm) in this tab" : "server fallback", tone: proved.via === "browser" ? "ok" : "warn" });
  if (proved.via === "browser") fact("prove", { k: "circuit + key", v: `${(proved.loadMs / 1000).toFixed(1)} s to fetch and unpack` });
  fact("prove", { k: "witness + proof", v: `${(proved.proveMs / 1000).toFixed(1)} s` });

  const tx = await step("frames", async () => {
    const tx = exitTx(proved.proof, { exitRelay: EXIT_RELAY });
    tx.frames.forEach((f, i) => {
      const mode = modeName(profile, f.mode);
      const scope = mode === "VERIFY" ? ` ${scopeName(profile, f.flags)}` : "";
      fact("frames", { k: `frame ${i}`, v: `${mode}${scope} · ${FRAME_LABELS[i] ?? ""} · ${f.target ? short(f.target) : "sender"} · gas ${n(f.limits.execution)}${f.limits.state ? ` + state ${n(f.limits.state)}` : ""}` });
    });
    fact("frames", { k: "sender", v: `ExitRelay ${short(tx.sender)}, no signatures; nonce key = nullifier hash` });
    return tx;
  });

  await step("check", async () => {
    const report = await simulator.check(tx);
    for (const [name, v] of [["public mempool", report.verdicts.public], ["alt mempool", report.verdicts.alt]] as const) {
      const rule = v.failed ? ` (${v.failed.rule}${v.failed.frameIndex !== undefined ? `, frame ${v.failed.frameIndex}` : ""})` : "";
      fact("check", { k: name, v: `${v.verdict}${rule} · source: ${v.source}`, tone: v.verdict === "admitted" ? "ok" : name === "alt mempool" ? "bad" : "warn" });
    }
    put("check", { detail: renderReport(report, { title: "checkAdmission" }) });
    const alt = report.verdicts.alt;
    // A rejection from our own rule model is unverified: the send below is the real test. A node's word stops the run.
    if (alt.verdict === "rejected" && alt.source !== "model") throw new Error(`the alt mempool would reject this exit: ${alt.failed?.rule ?? "unknown rule"}${alt.fix ? `. ${alt.fix}` : ""}`);
  });

  const before = await client.getBalance({ address: recipient });
  const hash = await step("submit", async () => {
    // submit, not send: the sender is the ExitRelay contract (zero signatures) and ExitRelay pins the frame gas.
    const sent = await client.altpool.submitFrameTransaction({ transaction: tx });
    fact("submit", { k: "exit tx", v: short(sent.hash), href: exitUrl(sent.hash) });
    fact("submit", { k: "sidecar", v: `${DEVNET.minerSidecarUrl} accepted it` });
    return sent.hash as Hex;
  });

  await step("receipt", async () => {
    let polling = true;
    const poll = setInterval(() => {
      // A response that lands after the receipt must not overwrite the final status.
      client.altpool.getTransactionStatus({ hash }).then((s) => s && polling && fact("receipt", { k: "sidecar status", v: s.status }), () => {});
    }, 3000);
    try {
      const { receipt: r } = await client.altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 180_000, throwOnRevert: true });
      fact("receipt", { k: "sidecar status", v: "OnChain", tone: "ok" });
      fact("receipt", { k: "block", v: `${r.blockNumber} · ${r.status}${r.gasUsed === undefined ? "" : ` · ${n(r.gasUsed)} gas in total`}`, tone: "ok" });
      for (const f of r.frames) {
        fact("receipt", { k: `frame ${f.index} gas`, v: `${n(f.gasUsed.execution)} execution + ${n(f.gasUsed.state)} state · ${f.status}`, tone: f.status === "success" ? "ok" : "bad" });
      }
      // throwOnRevert checks only the tx status; a frame can fail inside a successful tx.
      const failed = r.frames.find((f) => f.status !== "success");
      if (failed) throw new Error(`frame ${failed.index} ${failed.status}`);
    } finally {
      polling = false;
      clearInterval(poll);
    }
  });

  await step("balance", async () => {
    let after = before;
    for (let i = 0; i < 10 && after === before; i++) {
      after = await client.getBalance({ address: recipient }).catch(() => before);
      if (after === before) await sleep(1500);
    }
    const ok = after - before === PAYOUT;
    fact("balance", { k: "recipient", v: `${formatEther(before)} → ${formatEther(after)} ETH`, tone: ok ? "ok" : "bad" });
    fact("balance", { k: "expected", v: `${formatEther(DEVNET.denomination)} − ${formatEther(EXIT_FEE)} fee = ${formatEther(PAYOUT)} ETH` });
    if (!ok) throw new Error(`recipient balance rose by ${after - before} wei, expected ${PAYOUT}`);
  });

  return { exitHash: hash, totalMs: performance.now() - t0 };
}
