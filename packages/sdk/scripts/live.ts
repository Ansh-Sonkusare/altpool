// Live devnet integration run. Uses a FRESH in-memory key funded by the faucet (never printed, never saved).
// Writes a summary (hashes, explorer links, verdicts; no keys) to packages/sdk/live/latest.json.
//   bun run --filter altpool live
import { mkdirSync, writeFileSync } from "node:fs";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  altDevnet, altpoolActions, createAltMempoolClient, DEVNET, explainAdmissionFailure, frame, InsufficientStakeError, newTx,
  NonceConflictError, randomNonceKey, RecentRootExpiredError, replacementFees, secp256k1Placeholder, StakeConfigurationError,
  type AltpoolSdkError, type FrameTx, type LifecycleEvent,
} from "../src";

// NETWORK=local targets altpool-localnet (quietsend-research/altpool-localnet): ethrex :8555, sidecar :14337.
const LOCAL = process.env.NETWORK === "local";
const GATEWAY = process.env.GATEWAY_URL || (LOCAL ? "http://127.0.0.1:14337/rpc" : DEVNET.gatewayUrl);
const GATEWAY_WS = process.env.GATEWAY_WS_URL || GATEWAY.replace(/^http/, "ws");
const ETHREX = process.env.ETHREX_URL || (LOCAL ? "http://127.0.0.1:8555" : DEVNET.ethrexUrl);
const EXPLORER = LOCAL ? undefined : DEVNET.explorerUrl;
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;

const out: Record<string, unknown> = { startedAt: new Date().toISOString(), gateway: GATEWAY, gatewayWs: GATEWAY_WS, ethrex: ETHREX, profile: profile.id, network: LOCAL ? "local" : "public", steps: [] };
const steps = out.steps as unknown[];
const log = (step: string, data: Record<string, unknown> = {}) => {
  const row = { step, ...data };
  steps.push(row);
  console.log(JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
};
const save = () => {
  mkdirSync(new URL("../live/", import.meta.url), { recursive: true });
  writeFileSync(new URL(`../live/${LOCAL ? "local" : "public"}-latest.json`, import.meta.url), JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
const me = account.address;
const signer = { privateKey: key };

const sidecar = createAltMempoolClient({ httpUrl: GATEWAY, webSocketUrl: GATEWAY_WS, profile, name: LOCAL ? "localnet" : "public-gateway" });
const client = createPublicClient({ chain: altDevnet, transport: http(ETHREX) }).extend(altpoolActions({ sidecar, explorerUrl: EXPLORER }));
const wallet = createWalletClient({ account, chain: altDevnet, transport: http(ETHREX) });
const ap = client.altpool;

const selfPaid = (o: { keys: bigint[]; seq: bigint; value?: bigint; fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } }): FrameTx =>
  newTx({
    chainId: DEVNET.chainId, sender: me, nonceKeys: o.keys, nonceSeq: o.seq,
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
      frame(profile, "SENDER", { target: RECIPIENT, execution: 50_000n, value: o.value ?? 1n }),
    ],
    signatures: [secp256k1Placeholder(profile)],
    fees: o.fees ?? { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  });

const events: LifecycleEvent[] = [];
const fail = (e: unknown) => ({ name: (e as Error).name, message: (e as Error).message, fix: (e as AltpoolSdkError).fix, detail: (e as AltpoolSdkError).detail, code: (e as AltpoolSdkError).rpc?.code });

try {
  // 1-4. connect, config, capabilities
  const caps = await ap.assertCompatible();
  log("capabilities", { chainId: caps.chainId, sidecar: caps.sidecar, p2p: caps.p2p, explorer: caps.explorer, staking: caps.staking, mempools: caps.mempools, warnings: caps.warnings });

  // 10. WebSocket lifecycle stream for the whole run
  const stopEvents = ap.watchExplorerEvents({ onEvent: (e) => events.push(e), onError: (e) => log("ws-error", { message: e.message }) });

  // fund
  const f = await ap.faucet(me);
  for (let i = 0; i < 40 && (await client.getBalance({ address: me })) === 0n; i++) await sleep(1500);
  log("funded", { address: me, faucetTx: f.txHash, balance: await client.getBalance({ address: me }) });

  // 5. preflight + estimate + submit (key 0 = account nonce)
  const k0 = await ap.prepareNonceKeys({ sender: me, keys: [0n] });
  const tx1 = selfPaid({ keys: k0.nonceKeys, seq: k0.nonceSeq });
  const pf = await ap.preflightFrameTransaction({ transaction: tx1, signer });
  log("preflight", { public: pf.public.status, alternative: pf.alternative.status, checks: pf.alternative.checks.map((c) => `${c.stage}/${c.rule}:${c.status}`), publicChecks: pf.public.checks.map((c) => `${c.stage}/${c.rule}:${c.status}`) });
  const prepared = await ap.prepareFrameTransaction({ transaction: tx1, signer });
  log("estimate", { frames: prepared.gas.frames.map((r) => ({ i: r.index, mode: r.mode, prefix: r.inPrefix, declared: r.declared, measured: r.measured, suggested: r.suggested, auto: r.autoEstimated })), cumulative: prepared.gas.cumulativeGasUsed, fees: prepared.gas.fees });
  // 6. sign with a viem account (raw digest) to exercise that path
  const sent1 = await ap.sendFrameTransaction({ transaction: prepared.transaction, signer: account });
  log("submitted", { hash: sent1.hash, hashMatches: sent1.hashMatches, explorer: ap.explorerLink(sent1.hash) });
  // 7-9. status, receipt, admission
  log("status-after-submit", { status: (await ap.getTransactionStatus({ hash: sent1.hash }))?.status });
  const r1 = await ap.waitForFrameTransactionReceipt({ hash: sent1.hash });
  log("receipt", { status: r1.receipt.status, block: r1.receipt.blockNumber, frames: r1.receipt.frames.map((x) => ({ status: x.status, gas: x.gasUsed })), finalStatus: r1.status?.status });
  const rep1 = await ap.getAdmissionReport({ hash: sent1.hash });
  log("admission-report", { outcome: rep1?.outcome, failed: rep1?.failed.length, checks: rep1?.checks.length, events: rep1?.events.map((e) => e.kind), explorer: rep1?.explorerUrl });
  out.admittedTx = { hash: sent1.hash, explorer: ap.explorerLink(sent1.hash), block: r1.receipt.blockNumber };

  // 12. keyed nonces: two fresh keys pending at once, then read them back from NONCE_MANAGER
  const [ka, kb] = [randomNonceKey(), randomNonceKey()];
  const pa = await ap.prepareNonceKeys({ sender: me, keys: [ka] });
  const pb = await ap.prepareNonceKeys({ sender: me, keys: [kb] });
  const sa = await ap.sendFrameTransaction({ transaction: selfPaid({ keys: pa.nonceKeys, seq: pa.nonceSeq }), signer });
  const sb = await ap.sendFrameTransaction({ transaction: selfPaid({ keys: pb.nonceKeys, seq: pb.nonceSeq }), signer });
  const both = await Promise.all([ap.getTransactionStatus({ hash: sa.hash }), ap.getTransactionStatus({ hash: sb.hash })]);
  log("keyed-two-pending", { a: sa.hash, b: sb.hash, statuses: both.map((s) => s?.status) });
  await Promise.all([ap.waitForFrameTransactionReceipt({ hash: sa.hash }), ap.waitForFrameTransactionReceipt({ hash: sb.hash })]);
  const after = await Promise.all([ap.getKeyedNonce({ sender: me, key: ka }), ap.getKeyedNonce({ sender: me, key: kb })]);
  log("keyed-after-inclusion", { seqs: after.map((k) => k.seq), slotDerivationVerified: after.every((k) => k.seq === 1n) });
  out.keyedTxs = [sa.hash, sb.hash].map((h) => ({ hash: h, explorer: ap.explorerLink(h) }));

  // replacement: same (sender, keys, seq); +5% rejected, +10% accepted
  const kr = randomNonceKey();
  const base = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  const orig = await ap.sendFrameTransaction({ transaction: selfPaid({ keys: [kr], seq: 0n, fees: base }), signer });
  try {
    await ap.sendFrameTransaction({ transaction: selfPaid({ keys: [kr], seq: 0n, fees: { maxFeePerGas: base.maxFeePerGas * 105n / 100n, maxPriorityFeePerGas: base.maxPriorityFeePerGas * 105n / 100n } }), signer });
    log("replace+5%", { unexpected: "admitted" });
  } catch (e) {
    log("replace+5%-rejected", { ...fail(e), isNonceConflict: e instanceof NonceConflictError });
  }
  const repl = await ap.sendFrameTransaction({ transaction: selfPaid({ keys: [kr], seq: 0n, fees: replacementFees(profile, base) }), signer });
  log("replace+10%", { original: orig.hash, replacement: repl.hash });
  await ap.waitForFrameTransactionReceipt({ hash: repl.hash });
  const origReport = await ap.getAdmissionReport({ hash: orig.hash });
  log("replaced-original", { outcome: origReport?.outcome, events: origReport?.events.map((e) => `${e.kind}${e.reason ? `(${e.reason})` : ""}`) });

  // rejection with an explanation: an uncommitted recent root
  const head = await ap.getCurrentSlot();
  const bogus = { sourceId: keccak256(toHex("altpool-live-bogus")), slot: head.headSlot - 1n, root: keccak256(toHex(`never-${Date.now()}`)) };
  const local = await ap.validateRecentRootReferences([bogus]);
  log("recent-root-local-check", { ok: local.ok, checks: local.checks.map((c) => `${c.rule}:${c.status}`) });
  const rejTx = { ...selfPaid({ keys: [randomNonceKey()], seq: 0n }), recentRootReferences: [bogus] };
  try {
    await ap.sendFrameTransaction({ transaction: rejTx, signer });
    log("rejection", { unexpected: "admitted" });
  } catch (e) {
    const x = explainAdmissionFailure(e as AltpoolSdkError);
    log("rejection", { ...fail(e), isRecentRoot: e instanceof RecentRootExpiredError, explanation: x });
    out.rejection = { message: (e as Error).message, rule: x.rule, fix: x.fix };
  }

  // 13. recent roots: write a root (plain tx to the predeploy), wait a slot, reference it
  const pre = await ap.verifyRecentRootPredeploy();
  const salt = keccak256(toHex(`altpool-salt-${Date.now()}`));
  const root = keccak256(toHex(`altpool-root-${Date.now()}`));
  const wtx = await wallet.sendTransaction({ to: pre.address, data: ap.encodeRecentRootWrite(salt, root), value: 0n });
  const wr = await client.waitForTransactionReceipt({ hash: wtx });
  const wblock: any = await client.request({ method: "eth_getBlockByNumber", params: [toHex(wr.blockNumber), false] });
  const ref = { sourceId: ap.recentRootSourceId(me, salt), slot: BigInt(wblock.slotNumber), root };
  const got = await ap.getRecentRoot(ref);
  log("recent-root-written", { predeployOk: pre.ok, writeTx: wtx, slot: ref.slot, committed: got.committed });
  for (let i = 0; i < 30 && (await ap.getCurrentSlot()).currentSlot <= ref.slot + 1n; i++) await sleep(1000);
  const rrTx = await ap.prepareRecentRootReferences({ transaction: selfPaid({ keys: [randomNonceKey()], seq: 0n }), references: [ref] });
  const rrSent = await ap.sendFrameTransaction({ transaction: rrTx, signer });
  const rrRc = await ap.waitForFrameTransactionReceipt({ hash: rrSent.hash });
  log("recent-root-tx", { hash: rrSent.hash, status: rrRc.receipt.status, explorer: ap.explorerLink(rrSent.hash) });
  out.recentRootTx = { hash: rrSent.hash, explorer: ap.explorerLink(rrSent.hash) };

  // 11. staking lifecycle (EOA staking itself); minimums from skandha_config
  const min = await ap.getMinimumStake();
  try { await ap.stakeEntity({ wallet, amount: min.minStake }); } catch (e) { log("stake-too-low", { ...fail(e), isInsufficient: e instanceof InsufficientStakeError }); }
  try { await ap.stakeEntity({ wallet, amount: min.minStake + 1n, entity: min.registry }); } catch (e) { log("stake-for-contract", { ...fail(e), isConfig: e instanceof StakeConfigurationError }); }
  const delay = min.minUnstakeDelaySec;
  const stx = await ap.stakeEntity({ wallet, amount: min.minStake + parseEther("0.001"), unstakeDelaySec: delay });
  await client.waitForTransactionReceipt({ hash: stx });
  log("staked", { tx: stx, stake: await ap.getEntityStake(me).then((s) => ({ amount: s.amount, state: s.state, delay: s.unstakeDelaySec, meets: s.meetsMinimum })), node: await ap.isEntityStaked(me) });
  const utx = await ap.unlockEntityStake({ wallet });
  await client.waitForTransactionReceipt({ hash: utx });
  const unlocked = await ap.getEntityStake(me);
  log("unlocked", { tx: utx, state: unlocked.state, withdrawTime: unlocked.withdrawTime, node: await ap.isEntityStaked(me) });
  for (let i = 0; i < 10 && (await ap.getEntityStake(me)).state !== "withdrawable"; i++) await sleep(1500);
  try {
    const wdx = await ap.withdrawEntityStake({ wallet });
    await client.waitForTransactionReceipt({ hash: wdx });
    log("withdrawn", { tx: wdx, state: (await ap.getEntityStake(me)).state });
  } catch (e) {
    log("withdraw", fail(e));
  }
  out.stakeTxs = { stake: stx, unlock: utx };

  await sleep(3000);
  stopEvents();
  const mine = new Set([sent1.hash, sa.hash, sb.hash, orig.hash, repl.hash, rrSent.hash].map((h) => h.toLowerCase()));
  log("ws-events", { total: events.length, ours: events.filter((e) => mine.has(e.hash.toLowerCase())).map((e) => `${e.seq}:${e.kind}:${e.hash.slice(0, 10)}`) });
  out.ok = true;
} catch (e) {
  log("FAILED", fail(e));
  out.ok = false;
  process.exitCode = 1;
} finally {
  out.finishedAt = new Date().toISOString();
  save();
  sidecar.close();
}
