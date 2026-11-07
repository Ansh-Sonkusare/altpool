#!/usr/bin/env tsx
// Owner: Dev C. The demo (research repo docs/09). Each step prints what happened and an explorer link.
//   bun run demo             live, public devnet, on the deployed + staked ExitRelay (deployments.json): fresh key ->
//                            deposit -> prove -> check (public ✗, alt ✓) -> what-if unstaked (alt ✗) -> sendExit ->
//                            recipient 0 -> 0.1 − fee -> replay explained -> ExitRelay's reputation
//   bun run demo --prepare   the slow half before the talk: fund, deposit, prove (minutes); saves the proof
//   bun run demo --stage     the rest from the prepared proof, in about a minute
//   bun run demo --fixture   offline backup: the captured paymaster run (r9-demo), unstaked -> staked
//   --pq                     with --prepare/--stage/full: the recipient is a post-quantum Falcon-512 wallet (@altpool/falcon),
//                            which then spends the exit with a Falcon signature through the SDK (alt mempool only)
// Live needs the prover artifacts (bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { bytesToHex, createPublicClient, createWalletClient, formatEther, hexToBytes, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx, txHash } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, ethrex, explorerTx, gateway, toWire, type AdmissionReport } from "@altpool/core";
import { checkAdmission, createSimulator, diagnoseError, renderReport, renderRoute, renderVerdict, replaySimulator, routeFromReport, summarize } from "@altpool/simulator";
import { entityStatus } from "@altpool/monitor";
import { altpoolActions, createAltMempoolClient } from "altpool";

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

const liveDemo = async (mode: Mode, pq: boolean) => {
  if (mode !== "stage" && PROVER.some((p) => !existsSync(p))) {
    console.error("demo needs the prover artifacts: bun run --filter @altpool/prover fetch && bun run --filter @altpool/prover convert\nor run the offline backup: bun run demo --fixture");
    process.exit(2);
  }
  const { EXIT_FEE, deployments, depositNote, explorerExit, exitTx, sendExit } = await import("@altpool/contracts");
  const exitRelay = deployments.exitRelay as Address | null;
  expect(Boolean(exitRelay), "packages/contracts/deployments.json has no exitRelay");

  console.log(bold(`Altpool + QuietSend demo · public devnet, chain ${DEVNET.chainId}${mode === "full" ? "" : ` · ${mode}`}${pq ? " · post-quantum recipient" : ""}`));
  const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
  const miner = gateway(DEVNET.minerSidecarUrl);
  const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
  const save = (o: Record<string, unknown>) =>
    writeFileSync(STATE, JSON.stringify({ ...load(), ...o }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  const show = (r: AdmissionReport, title: string) => console.log(indent(renderReport(r, { title: `${title} · ${summarize(r)}` })));
  /** Errors after which the tx may still be in the node: a client-side timeout, or a resend of a tx it already holds. */
  const SENT_ANYWAY = /already known|timed out|timeout/i;
  /** A fresh key with faucet ETH: never a published key. */
  const freshFunded = async (need: bigint) => {
    const key = generatePrivateKey();
    const me = privateKeyToAccount(key);
    await gateway().faucet(me.address);
    for (let i = 0; i < 60 && (await pub.getBalance({ address: me.address })) < need; i++) await sleep(2000);
    expect((await pub.getBalance({ address: me.address })) >= need, "the faucet did not pay out");
    return { key, me, wallet: createWalletClient({ account: me, chain: altDevnet, transport: http(DEVNET.ethrexUrl) }) };
  };
  const sdkOn = (httpUrl: string) =>
    pub.extend(altpoolActions({ sidecar: createAltMempoolClient({ httpUrl, profile: getProfile(DEVNET.profile), name: "miner" }), explorerUrl: DEVNET.explorerUrl }));
  type Falcon = { secretKey: Hex; publicKey: Hex };
  const falconOf = async (f: Falcon) => {
    const { falconAccount } = await import("@altpool/falcon");
    return falconAccount({ key: { secretKey: hexToBytes(f.secretKey), publicKey: hexToBytes(f.publicKey) } });
  };

  step("ExitRelay: one staked contract sends every exit");
  const relay = await entityStatus(exitRelay!, miner);
  info(`${exitRelay} · ${relay.stake.isStaked ? "staked" : "UNSTAKED"} ${formatEther(relay.stake.amount)} ETH · reputation ${relay.reputation.status} (seen ${relay.reputation.opsSeen}, included ${relay.reputation.opsIncluded})`);
  expect(relay.stake.isStaked, "ExitRelay is not staked");

  type Prepared = Awaited<ReturnType<typeof import("@altpool/prover").prove>> & { depositTx: Hex; falcon?: Falcon };
  /** Fund, deposit, prove: the slow part (the proof takes minutes), so --prepare runs it before going on stage. */
  const prepare = async (): Promise<Prepared> => {
    // Imported here so --fixture and --stage run without the 70 MB prover key.
    const { createNote, noteToString, prove } = await import("@altpool/prover");
    step("Deposit 0.1 ETH into the privacy pool from a fresh, faucet-funded key");
    const { key, me, wallet } = await freshFunded(DEVNET.denomination + parseEther("0.01"));
    save({ startedAt: new Date().toISOString(), depositorKey: key, depositor: me.address, exitRelay, prepared: null });
    const note = createNote();
    save({ note: noteToString(note) });
    const depositTx = await depositNote(wallet, note);
    save({ depositTx });
    info(`depositor ${me.address} ${dim("(key and note saved to apps/demo/.demo-state.json, git-ignored)")}`);
    linkTo(depositTx);

    let falcon: Falcon | undefined;
    let recipient = privateKeyToAccount(generatePrivateKey()).address;
    if (pq) {
      step("Make the recipient post-quantum: a Falcon-512 wallet, deployed by an unrelated fresh key");
      const { falconKeygen } = await import("@altpool/falcon");
      const k = falconKeygen();
      falcon = { secretKey: bytesToHex(k.secretKey), publicKey: bytesToHex(k.publicKey) };
      const account = await falconOf(falcon);
      save({ falcon: { ...falcon, address: account.address } });
      // Anyone may deploy it (the wallet is bound to the key), so a stranger's key does it: no link to the depositor.
      const { wallet: deployer } = await freshFunded(parseEther("0.05"));
      const h = await deployer.sendTransaction({ ...account.deployCall(), gas: 18_000_000n, type: "legacy" });
      const dr = await pub.waitForTransactionReceipt({ hash: h, timeout: 180_000 });
      expect(dr.status === "success" && (await account.isDeployed(pub)), "the Falcon wallet did not deploy");
      recipient = account.address;
      info(`wallet ${recipient} · its only key is Falcon-512 (897-byte public key), no secp256k1 key exists`);
      linkTo(h);
    }

    step(`Prove the withdrawal to a brand-new ${pq ? "Falcon wallet" : "wallet"} holding 0 ETH`);
    const t0 = Date.now();
    const proof = await prove(note, { recipient, relayer: exitRelay!, fee: EXIT_FEE });
    info(`recipient ${recipient}, proof in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // Save the proof, not the tx: the tx carries a deadline (600 s grid) that must be fresh when it is sent.
    const prepared = { ...proof, depositTx, falcon };
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
      console.log(`\n${bold("Ready.")} On stage: bun run demo --stage${pq ? " --pq" : ""}`);
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
  const r = await sendExit(tx, { sendUrl: route.url }).catch(async (e: Error) => {
    if (!SENT_ANYWAY.test(e.message)) throw e;
    // A send that timed out on a slow devnet can still have reached the node: wait for that tx instead of failing.
    info(dim(`the send reported "${e.message.split("\n")[0]}"; the node may hold it anyway: waiting for it`));
    const hash = txHash(getProfile(DEVNET.profile), tx);
    const { receipt } = await sdkOn(route.url ?? DEVNET.minerSidecarUrl).altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 180_000, throwOnRevert: true });
    expect(receipt.frames.every((f) => f.status === "success"), `exit ${hash}: a frame failed`);
    return { hash, blockNumber: Number(receipt.blockNumber), frames: receipt.frames.map((f) => ({ gasUsed: Number(f.gasUsed.execution) })) };
  });
  save({ exitHash: r.hash });
  const got = await pub.getBalance({ address: recipient });
  info(`block ${r.blockNumber}, frames ${r.frames.map((f) => f.gasUsed.toLocaleString("en-US")).join(" / ")} gas; recipient 0 → ${formatEther(got)} ETH`);
  info(dim(explorerExit(r.hash)));
  expect(got === DEVNET.denomination - EXIT_FEE, `recipient got ${formatEther(got)} ETH, expected ${formatEther(DEVNET.denomination - EXIT_FEE)}`);

  let pqSpend: Hex | undefined;
  if (pq) {
    expect(Boolean(prepared.falcon), "--pq on stage, but the prepared note has no Falcon wallet: run --prepare --pq");
    const { FALCON_VERIFY_GAS } = await import("@altpool/falcon");
    const account = await falconOf(prepared.falcon!);
    const sdk = sdkOn(DEVNET.minerSidecarUrl);

    step("Spend it post-quantum: a Falcon-512 signature, checked on-chain by the wallet's own VERIFY frame");
    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const value = parseEther("0.01");
    const nonce = await account.getNonce(pub);
    const sign = () => sdk.altpool.signFrameTransaction({ transaction: account.buildTx({ nonce, to: dest, value, maxFeePerGas: 2n * 10n ** 9n }), signer: account.signer });
    let signed = await sign();
    info(`frames: VERIFY wallet (Falcon verify) · SENDER wallet.execute(${dest}, ${formatEther(value)} ETH) · signature ${(signed.signatures[0]!.signature.length - 2) / 2} bytes (secp256k1: 65)`);
    // Falcon VERIFY is ~3.9M gas: our 450k ExitRelay pin does not apply; the sidecar allows 10M.
    const check = await createSimulator({ verifyGasMax: FALCON_VERIFY_GAS }).check(signed);
    show(check, "frame-doctor");
    expect(check.verdicts.public.verdict === "rejected", "the public mempool would admit a Falcon spend");
    if (check.verdicts.alt.verdict !== "admitted") info(dim(`alt: ${check.verdicts.alt.failed?.rule ?? "?"} in the model; the send below is the real test`));
    // The miner once admitted a Falcon spend and dropped it without a block; a resubmit (new signature, same nonce) landed.
    type Receipt = Awaited<ReturnType<typeof sdk.altpool.waitForFrameTransactionReceipt>>["receipt"];
    const wait = (hash: Hex) => sdk.altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 180_000 }).then((x) => x.receipt);
    const tried: Hex[] = [];
    let receipt: Receipt | undefined;
    for (let attempt = 1; !receipt; attempt++) {
      const hash = txHash(getProfile(DEVNET.profile), signed);
      tried.push(hash);
      try {
        await sdk.altpool.submitFrameTransaction({ transaction: signed, mempool: "alt" }).catch((e: Error) => {
          if (!SENT_ANYWAY.test(e.message)) throw e;
          info(dim(`submit reported "${e.message.split("\n")[0]}": waiting for ${hash} anyway`));
        });
        receipt = await wait(hash);
      } catch (e) {
        // An earlier attempt may have landed after all: same nonce, other signature.
        if ((await account.getNonce(pub)) > nonce) {
          for (const h of tried) receipt ??= await wait(h).catch(() => undefined);
          expect(Boolean(receipt), `nonce ${nonce} was used, but by none of ${tried.join(", ")}`);
          break;
        }
        expect(attempt < 2, `the Falcon spend was not included: ${(e as Error).message}`);
        info(dim(`not included (${(e as Error).message.split("\n")[0]}); resubmitting with a fresh signature`));
        signed = await sign();
      }
    }
    pqSpend = receipt!.hash;
    expect(receipt!.frames.every((f) => f.status === "success"), `a spend frame failed: ${receipt!.frames.map((f) => f.status).join(", ")}`);
    const landed = await pub.getBalance({ address: dest });
    info(`block ${receipt!.blockNumber}, VERIFY ${receipt!.frames[0]!.gasUsed.execution.toLocaleString("en-US")} gas (public cap ${DEVNET.publicVerifyGasCap.toLocaleString("en-US")}); ${dest} 0 → ${formatEther(landed)} ETH, gas paid by the wallet`);
    info(dim(explorerExit(pqSpend!)));
    expect(landed === value, `destination got ${formatEther(landed)} ETH, expected ${formatEther(value)}`);
  }

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
  if (pqSpend) info(`pq spend ${explorerExit(pqSpend)}`);
};

const mode: Mode = process.argv.includes("--prepare") ? "prepare" : process.argv.includes("--stage") ? "stage" : "full";
(process.argv.includes("--fixture") ? fixtureDemo() : liveDemo(mode, process.argv.includes("--pq"))).catch((e) => {
  console.error(red(`\ndemo failed: ${(e as Error).message}`));
  process.exit(1);
});
