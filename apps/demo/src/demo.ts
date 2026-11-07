#!/usr/bin/env tsx
// Owner: Dev C. The demo (research repo docs/09). Each step prints what happened and an explorer link.
//   bun run demo             live, public devnet, on the deployed + staked ExitRelay (deployments.json): fresh key ->
//                            deposit -> prove -> check (public ✗, alt ✓) -> what-if unstaked (alt ✗) -> sendExit ->
//                            recipient 0 -> 0.1 − fee -> replay explained -> ExitRelay's reputation
//   bun run demo --prepare   the slow half before the talk: fund, deposit, prove (minutes); saves the proof
//   bun run demo --stage     the rest from the prepared proof, in about a minute
//   bun run demo --fixture   offline backup: the captured paymaster run (r9-demo), unstaked -> staked
// Live needs the prover artifacts (bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway, toWire, type AdmissionReport } from "@altpool/core";
import { checkAdmission, createSimulator, diagnoseError, renderReport, renderRoute, renderVerdict, replaySimulator, routeFromReport, summarize } from "@altpool/simulator";
import { entityStatus } from "@altpool/monitor";

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
let n = 0;
const step = (title: string) => console.log(`\n${bold(`${++n}. ${title}`)}`);
const info = (s: string) => console.log(`   ${s}`);
const linkTo = (h: string) => info(dim(explorerTx(h)));
const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n");

/** Stop the demo when a step's outcome is not the one the story needs: say what we got. */
const expect = (ok: boolean, what: string) => {
  if (!ok) { console.error(red(`\n✗ unexpected: ${what}`)); process.exit(1); }
};

// ---------------------------------------------------------------- offline backup

const fixtureDemo = async () => {
  const { fixture } = await import("@altpool/core/fixtures");
  console.log(bold("Altpool demo (offline replay of the captured paymaster run, r9-demo)"));
  const sim = fixture("public/29-ethrex_simulateFrameTransaction.json");

  step("Check before signing: a paymaster that reads its own storage, unstaked");
  const before = await replaySimulator(sim, { staked: false }).check(replaySimulator(sim).raw);
  console.log(indent(renderReport(before, { title: "frame-doctor" })));

  step("Stake the paymaster in the registry");
  const stake = fixture("r9-demo/10-stake.json").response.result as Hex;
  info(`addStake(86400) with 0.012 ETH: ${stake}`);

  step("Check again");
  const after = await replaySimulator(sim, { staked: true }).check(replaySimulator(sim).raw);
  console.log(indent(renderReport(after, { title: "frame-doctor" })));

  step("Send to the alt mempool");
  const sent = fixture("r9-demo/12-t1-alt-staked.json").response.result as Hex;
  const receipt = fixture("r9-demo/13-t1-receipt.json").response.result;
  const verifyGas = receipt.frameReceipts.slice(0, 2).reduce((s: bigint, f: any) => s + BigInt(f.gasUsed), 0n);
  info(`admitted ${sent}, mined in block ${Number(receipt.blockNumber)}, VERIFY gas ${verifyGas.toLocaleString("en-US")}`);

  step("The quota runs out: the node rejects, frame-doctor explains");
  const rejected = fixture("r9-demo/17-t3-exhausted-alt.json").response.error!;
  const d = diagnoseError(rejected, "alt");
  console.log(indent(renderVerdict({
    mempool: "alt", source: "send", verdict: "rejected", fix: d.fix,
    failed: { rule: d.rule, frameIndex: d.frameIndex }, error: { code: rejected.code, message: rejected.message, revertReason: d.revertReason },
  }).join("\n")));
  console.log(dim("\nReplayed from packages/core/fixtures (public/29 from the public devnet, r9-demo from altpool-localnet). Nothing was sent."));
};

// ---------------------------------------------------------------- live

const ROOT = new URL("../../../", import.meta.url);
const PROVER = [new URL("packages/prover/artifacts/withdraw.json", ROOT), new URL("packages/prover/artifacts/withdraw_proving_key.json", ROOT)];
const STATE = new URL("../.demo-state.json", import.meta.url);

type Mode = "full" | "prepare" | "stage";

const liveDemo = async (mode: Mode) => {
  if (mode !== "stage" && PROVER.some((p) => !existsSync(p))) {
    console.error("demo needs the prover artifacts: bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert\nor run the offline backup: bun run demo --fixture");
    process.exit(2);
  }
  const { EXIT_FEE, deployments, depositNote, explorerExit, exitTx, sendExit } = await import("@altpool/contracts");
  const exitRelay = deployments.exitRelay as Address | null;
  expect(Boolean(exitRelay), "packages/contracts/deployments.json has no exitRelay");

  console.log(bold(`Altpool + QuietSend demo · public devnet, chain ${DEVNET.chainId}${mode === "full" ? "" : ` · ${mode}`}`));
  const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const miner = gateway(DEVNET.minerSidecarUrl);
  const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
  const save = (o: Record<string, unknown>) =>
    writeFileSync(STATE, JSON.stringify({ ...load(), ...o }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  const show = (r: AdmissionReport, title: string) => console.log(indent(renderReport(r, { title: `${title} · ${summarize(r)}` })));

  step("ExitRelay: one staked contract sends every exit");
  const relay = await entityStatus(exitRelay!, miner);
  info(`${exitRelay} · ${relay.stake.isStaked ? "staked" : "UNSTAKED"} ${formatEther(relay.stake.amount)} ETH · reputation ${relay.reputation.status} (seen ${relay.reputation.opsSeen}, included ${relay.reputation.opsIncluded})`);
  expect(relay.stake.isStaked, "ExitRelay is not staked");

  type Prepared = Awaited<ReturnType<typeof import("@altpool/prover").prove>> & { depositTx: Hex };
  /** Fund, deposit, prove: the slow part (the proof takes minutes), so --prepare runs it before going on stage. */
  const prepare = async (): Promise<Prepared> => {
    // Imported here so --fixture and --stage run without the 70 MB prover key.
    const { createNote, noteToString, prove } = await import("@altpool/prover");
    const key = generatePrivateKey(); // fresh every run: never a published key
    const me = privateKeyToAccount(key);
    const wallet = createWalletClient({ account: me, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
    save({ startedAt: new Date().toISOString(), depositorKey: key, depositor: me.address, exitRelay, prepared: null });

    step("Deposit 0.1 ETH into the privacy pool from a fresh, faucet-funded key");
    const need = DEVNET.denomination + parseEther("0.01");
    await gateway().faucet(me.address);
    for (let i = 0; i < 60 && (await pub.getBalance({ address: me.address })) < need; i++) await sleep(2000);
    expect((await pub.getBalance({ address: me.address })) >= need, "the faucet did not pay out");
    const note = createNote();
    save({ note: noteToString(note) });
    const depositTx = await depositNote(wallet, note);
    save({ depositTx });
    info(`depositor ${me.address} ${dim("(key and note saved to apps/demo/.demo-state.json, git-ignored)")}`);
    linkTo(depositTx);

    step("Prove the withdrawal to a brand-new wallet holding 0 ETH");
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const t0 = Date.now();
    const proof = await prove(note, { recipient, relayer: exitRelay!, fee: EXIT_FEE });
    info(`recipient ${recipient}, proof in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Save the proof, not the tx: the tx carries a deadline (600 s grid) that must be fresh when it is sent.
    const prepared = { ...proof, depositTx };
    save({ prepared });
    return prepared;
  };

  let prepared: Prepared;
  if (mode === "stage") {
    const p = load().prepared;
    expect(Boolean(p), "nothing prepared: run bun run demo --prepare first");
    prepared = { ...p, fee: BigInt(p.fee), refund: BigInt(p.refund) };
    save({ prepared: null }); // one stage run per prepared note
    step("Prepared before the talk: a deposit and a proof to a brand-new wallet");
    info(`deposit ${dim(explorerTx(prepared.depositTx))}`);
  } else {
    prepared = await prepare();
    if (mode === "prepare") {
      console.log(`\n${bold("Ready.")} On stage: bun run demo --stage`);
      return;
    }
  }
  const { recipient, depositTx } = prepared;
  const tx = exitTx(prepared, { exitRelay: exitRelay! });
  info(`recipient ${recipient}: ${formatEther(await pub.getBalance({ address: recipient }))} ETH`);
  info(`frames: expiry VERIFY · ExitRelay VERIFY (proof check, reads the pool) · SENDER pool.withdraw · nonce key = nullifier hash · no signatures`);

  step("Before sending: will each mempool admit it?");
  const before = await checkAdmission(tx);
  show(before, "frame-doctor");
  expect(before.verdicts.public.verdict === "rejected", "the public mempool would admit the exit");
  if (before.verdicts.alt.failed?.rule === "unknown") info(dim("alt: no trace from ethrex to model the rules; the send below is the real test"));
  else expect(before.verdicts.alt.verdict === "admitted", "the alt mempool would reject the exit");
  // Altpool picks the mempool (the brief's mempool: 'auto'): public if it admits, else alt on the sidecar that carries it.
  const route = routeFromReport(before);
  console.log(indent(renderRoute(route)));
  expect(route.target === "alt", `the router picked ${route.target}, expected alt`);

  step("Prove it: send the same exit to the public mempool (ethrex) for real");
  try {
    const h: Hex = await ethrex().sendRawTransaction(encodeTx(getProfile(DEVNET.profile), tx));
    expect(false, `the public mempool admitted the exit (${h})`);
  } catch (e) {
    const err = e as { code?: number | string; message: string };
    const d = diagnoseError({ code: err.code ?? 0, message: err.message }, "public");
    console.log(indent(renderVerdict({
      mempool: "public", source: "send", verdict: "rejected", fix: d.fix, failed: { rule: d.rule, ercRule: d.ercRule },
      error: { code: 0, message: err.message },
    }).join("\n")));
    info(dim("rejected on send, as predicted: nothing was admitted or charged"));
  }

  step("Why the stake matters: the same exit if ExitRelay were unstaked");
  const whatIf = await createSimulator({ assumeUnstaked: true }).check(tx);
  show(whatIf, "frame-doctor (what-if, local model)");

  step(`Send to the alt mempool via the ${route.node}, as routed: no relayer, no ETH in the recipient, repaid from the fee`);
  const r = await sendExit(tx, { sendUrl: route.url });
  save({ exitHash: r.hash });
  const got = await pub.getBalance({ address: recipient });
  info(`block ${r.blockNumber}, frames ${r.frames.map((f) => f.gasUsed.toLocaleString("en-US")).join(" / ")} gas; recipient 0 → ${formatEther(got)} ETH`);
  info(dim(explorerExit(r.hash)));
  expect(got === DEVNET.denomination - EXIT_FEE, `recipient got ${formatEther(got)} ETH, expected ${formatEther(DEVNET.denomination - EXIT_FEE)}`);

  step("Replay the same note: frame-doctor gives the cause, the node only echoes the public gas cap");
  // A distinct tx for the same note (priority fee + 1 wei), so the rejection is not filed under the exit's hash.
  const replay = { ...tx, fees: { ...tx.fees, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas + 1n } };
  const verdict = await checkAdmission(replay);
  show(verdict, "frame-doctor");
  console.log(indent(renderRoute(routeFromReport(verdict))));
  try {
    const h: Hex = await miner.sendFrameTransaction(toWire(replay));
    expect(false, `replay admitted ${h}`);
  } catch (e) {
    info(`node: ${dim((e as Error).message)}`);
  }

  step("ExitRelay after the exit (watchEntity)");
  // The explorer marks the exit OnChain a few seconds after the receipt: wait for it.
  let after = await entityStatus(exitRelay!, miner);
  for (let i = 0; i < 15 && !after.inclusions.some((x) => x.hash === r.hash); i++) { await sleep(2000); after = await entityStatus(exitRelay!, miner); }
  info(`reputation ${after.reputation.status}, seen ${after.reputation.opsSeen}, included ${after.reputation.opsIncluded} · ${after.headroom.untilThrottled} sends until throttled`);
  const mine = after.inclusions.find((i) => i.hash === r.hash);
  if (mine) info(`this exit: block ${mine.block}, VERIFY gas ${mine.verifyGas?.toLocaleString("en-US") ?? "n/a"} (public cap ${DEVNET.publicVerifyGasCap.toLocaleString("en-US")})`);
  info(dim(`live view: cd apps/monitor-web && bunx vite, then ?entity=${exitRelay}&node=miner`));

  console.log(`\n${bold("Links")}`);
  info(`deposit ${explorerTx(depositTx)}`);
  info(`exit    ${explorerExit(r.hash)}`);
};

const mode: Mode = process.argv.includes("--prepare") ? "prepare" : process.argv.includes("--stage") ? "stage" : "full";
(process.argv.includes("--fixture") ? fixtureDemo() : liveDemo(mode)).catch((e) => {
  console.error(red(`\ndemo failed: ${(e as Error).message}`));
  process.exit(1);
});
