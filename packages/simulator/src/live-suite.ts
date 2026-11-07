// Live devnet suite: for each case, FIRST predict with createSimulator({ explorer: false, estimate: false }) on the
// signed raw tx (before it is sent, so the node has no record of it), THEN send it and record what the node did.
//   bun run --filter @altpool/simulator live-suite        (tsx src/live-suite.ts)
// Uses fresh in-memory keys funded by the faucet (never printed, never saved). Writes accuracy/LIVE.md and
// accuracy/live-results.json. Public sends go through ethrex eth_sendRawTransaction, alt sends to the miner sidecar.
//
// Every case builds two txs (one per mempool, on different nonce keys) so one send cannot consume the other's nonce.
// Rejected cases send the same shape to both.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { createPublicClient, createWalletClient, encodeDeployData, http, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { altDevnet, altpoolActions, createAltMempoolClient, DEVNET, frame, newTx, registryCalldata, secp256k1Placeholder, type FrameTx } from "altpool";
import { diagnoseError } from "./rules";
import { deployments } from "@altpool/contracts";
import { entityStatus } from "@altpool/monitor";
import { decodeAbiParameters, getAddress } from "viem";
import { toWire } from "altpool";
import { ethrex as ethrexClient, gateway, gateway as gatewayClient, type MempoolVerdict } from "@altpool/core";
import { decodeTx, encodeTx, txHash } from "@forshtat/hegota-support/tx";
import { createSimulator } from "./check";

const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;
const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141" as const;
const ATOMIC_BATCH = 0x4;
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const NODE = encodeURIComponent(DEVNET.minerSidecarUrl);
const link = (h: string) => `${DEVNET.explorerUrl}/tx/${h}?node=${NODE}`;
const art = (n: string) => JSON.parse(readFileSync(new URL(`../live/${n}.json`, import.meta.url), "utf8")) as { abi: any; bytecode: Hex };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.error(s);

type Target = "public" | "alt";
interface Row {
  case: number;
  name: string;
  mempool: Target;
  expectation: string;
  hash: string;
  explorer: string;
  prediction: { verdict: "admitted" | "rejected"; source: MempoolVerdict["source"]; verified: boolean; rule?: string; message?: string };
  outcome: { verdict: "admitted" | "rejected"; rule?: string; code?: number | string; message?: string; included?: boolean; block?: number; frameStatuses?: unknown; status?: string };
  match: boolean;
  ruleMatch?: boolean;
}
interface Skip { case: number; name: string; reason: string }
const rows: Row[] = [];
const skipped: Skip[] = [];
const waiters: Promise<void>[] = [];

const funder = generatePrivateKey();
const owner = privateKeyToAccount(funder);
const wrongKey = generatePrivateKey();

const gatewaySidecar = createAltMempoolClient({ httpUrl: DEVNET.gatewayUrl, webSocketUrl: DEVNET.gatewayUrl.replace(/^http/, "ws"), profile, name: "gateway" });
const minerSidecar = createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, webSocketUrl: DEVNET.minerSidecarUrl.replace(/^http/, "ws"), profile, name: "miner" });
const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) }).extend(
  altpoolActions({ sidecar: minerSidecar, mempools: { gateway: gatewaySidecar }, explorerUrl: DEVNET.explorerUrl }),
);
const wallet = createWalletClient({ account: owner, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const ap = client.altpool;
interface Capture { endpoint?: string; request: { method: string; params: unknown[] }; response: { result?: unknown; error?: { code: number | string; message: string; data?: unknown } } }
const FIXTURES = new URL("../accuracy/fixtures/", import.meta.url);
let fixtureNo = 0;
const saveFixture = (slug: string, method: string, c: Capture) => {
  mkdirSync(FIXTURES, { recursive: true });
  const body = { endpoint: c.endpoint, request: { jsonrpc: "2.0", id: 1, ...c.request }, response: { jsonrpc: "2.0", id: 1, ...c.response } };
  writeFileSync(new URL(`${String(++fixtureNo).padStart(2, "0")}-${slug}-${method}.json`, FIXTURES), JSON.stringify(body, null, 2) + "\n");
};
// The simulator reads the node through these wrappers, so what the model saw before the send is captured as it happens.
const recorded: Capture[] = [];
const realNode = ethrexClient();
const realGateway = gatewayClient();
const err = (e: any) => ({ code: e?.code ?? -32000, message: e?.message ?? String(e), ...(e?.data !== undefined ? { data: e.data } : {}) });
const node = {
  ...realNode,
  simulateFrameTransaction: async (raw: Hex, trace = false) => {
    const request = { method: "ethrex_simulateFrameTransaction", params: [raw, "latest", { trace }] };
    try {
      const result = await realNode.simulateFrameTransaction(raw, trace);
      recorded.push({ endpoint: DEVNET.ethrexUrl, request, response: { result } });
      return result;
    } catch (e) {
      recorded.push({ endpoint: DEVNET.ethrexUrl, request, response: { error: err(e) } });
      throw e;
    }
  },
  call: async (method: string, params: any[] = []) => {
    const result = await realNode.call(method, params);
    if (method === "eth_call") recorded.push({ endpoint: DEVNET.ethrexUrl, request: { method, params }, response: { result } });
    return result;
  },
};
const gw = {
  ...realGateway,
  // The page the model reads reputation and stake from in the benchmark replay: kept to entities that hold a stake
  // (an address the page leaves out reads as unstaked), plus the live getDepositInfo read for staked entities the page lacks.
  listReputation: async (limit = 100) => {
    const page: any = await realGateway.listReputation(limit);
    const items: any[] = (page?.items ?? []).filter((i: any) => BigInt(i.stake ?? 0) > 0n);
    recorded.push({ endpoint: DEVNET.gatewayUrl, request: { method: "skandha_explorer_listReputation", params: [{ limit }] }, response: { result: { items, note: "trimmed to staked entities; items added from the live getDepositInfo read are marked by opsSeen 0" } } });
    return page;
  },
};
const sim = createSimulator({ explorer: false, estimate: false, ethrex: node as typeof realNode, gateway: gw as typeof realGateway });

const signWith = (tx: FrameTx, key: Hex = funder) => ap.signFrameTransaction({ transaction: tx, signer: { privateKey: key } });

const selfTx = async (o: { verify?: bigint; flagsLast?: number; expiredDeadline?: bigint; sender?: Address; verifyData?: Hex; signer?: Hex; seq?: bigint; keys?: bigint[]; to?: Address; senderData?: Hex; senderValue?: bigint; senderState?: bigint }): Promise<FrameTx> => {
  const sender = o.sender ?? owner.address;
  const k = o.keys ? { nonceKeys: o.keys, nonceSeq: o.seq ?? 0n } : await ap.prepareNonceKeys({ sender });
  const frames = [
    ...(o.expiredDeadline !== undefined ? [frame(profile, "VERIFY", { target: EXPIRY_VERIFIER, execution: 10_000n, data: toHex(o.expiredDeadline, { size: 8 }) })] : []),
    frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: o.verify ?? 60_000n, data: o.verifyData }),
    frame(profile, "SENDER", { target: o.to ?? RECIPIENT, execution: o.senderData ? 150_000n : 50_000n, state: o.senderState ?? 200_000n, value: o.senderValue ?? 1n, data: o.senderData, flags: o.flagsLast }),
  ];
  return newTx({ chainId: DEVNET.chainId, sender, nonceKeys: k.nonceKeys, nonceSeq: k.nonceSeq, frames, signatures: [secp256k1Placeholder(profile, o.signer)], fees: FEES });
};

/** Predict (pre-send), then send, then record. `wait` > 0 polls for a receipt after an admission. */
async function attempt(c: number, name: string, mempool: Target, expectation: string, tx: FrameTx, wait = 45_000): Promise<Row> {
  const raw = encodeTx(profile, tx);
  const hash = txHash(profile, tx);
  recorded.length = 0;
  const report = await sim.check(raw);
  const pre = recorded.splice(0);
  // Merge the live getDepositInfo reads into the reputation capture, so a staked entity the page lacks still replays as staked.
  const rep = pre.find((p) => p.request.method === "skandha_explorer_listReputation");
  if (rep) {
    const items = (rep.response.result as { items: any[] }).items;
    const have = new Set(items.map((i) => String(i.address).toLowerCase()));
    for (const c of pre) {
      if (c.request.method !== "eth_call") continue;
      const addr = `0x${String((c.request.params[0] as any)?.data ?? "").slice(-40)}`.toLowerCase();
      const [stake, delay, wt] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], c.response.result as Hex);
      if (stake > 0n && !have.has(addr)) {
        have.add(addr);
        items.push({ address: getAddress(addr), opsSeen: 0, opsIncluded: 0, status: "ok", isWhitelisted: false, isBlacklisted: false, stake: toHex(stake), unstakeDelaySec: Number(delay), withdrawTime: toHex(wt), isStaked: wt === 0n });
      }
    }
  }
  const v = report.verdicts[mempool];
  const prediction: Row["prediction"] = {
    verdict: v.verdict, source: v.source, verified: v.source !== "model",
    rule: v.failed?.rule, message: v.error?.message ?? v.fix,
  };
  const slug = `case${String(c).padStart(2, "0")}-${mempool}`;
  // Pre-send captures: the ethrex simulation, the stake reads, and the reputation page the model used.
  const dup = c === 9 && mempool === "alt";
  for (const p of pre) {
    if (dup && p.request.method === "ethrex_simulateFrameTransaction") continue;
    saveFixture(slug, p.request.method === "eth_call" ? "eth_call-getDepositInfo" : p.request.method, p);
  }
  let outcome: Row["outcome"];
  let sendCapture: Capture;
  try {
    const r = await ap.submitFrameTransaction({ transaction: tx, mempool: mempool === "public" ? "public" : "alt" });
    outcome = { verdict: "admitted" };
    if (r.hash.toLowerCase() !== hash.toLowerCase()) outcome.message = `node hash ${r.hash} differs from local hash`;
    sendCapture = mempool === "public"
      ? { endpoint: DEVNET.ethrexUrl, request: { method: "eth_sendRawTransaction", params: [raw] }, response: { result: r.hash } }
      : { endpoint: DEVNET.minerSidecarUrl, request: { method: "eth_sendFrameTransaction", params: [toWire(tx)] }, response: { result: r.hash } };
  } catch (e: any) {
    const msg: string = e?.rpc?.message ?? e?.message ?? String(e);
    const error = { code: e?.rpc?.code ?? -32000, message: msg, ...(e?.rpc?.data !== undefined ? { data: e.rpc.data } : {}) };
    outcome = { verdict: "rejected", rule: diagnoseError(error, mempool).rule, code: error.code, message: msg.slice(0, 300) };
    sendCapture = mempool === "public"
      ? { endpoint: DEVNET.ethrexUrl, request: { method: "eth_sendRawTransaction", params: [raw] }, response: { error } }
      : { endpoint: DEVNET.minerSidecarUrl, request: { method: "eth_sendFrameTransaction", params: [toWire(tx)] }, response: { error } };
  }
  saveFixture(slug, sendCapture.request.method, sendCapture);
  if (mempool === "alt") {
    // The sidecar's own admission record for the tx (it keeps rejected ones too).
    try {
      const rec = await gateway(DEVNET.minerSidecarUrl).admission(hash);
      saveFixture(slug, "skandha_explorer_getTransaction", { endpoint: DEVNET.minerSidecarUrl, request: { method: "skandha_explorer_getTransaction", params: [hash] }, response: { result: rec } });
    } catch { /* no record: nothing to capture */ }
  }
  const row: Row = {
    case: c, name, mempool, expectation, hash, explorer: link(hash), prediction, outcome,
    match: prediction.verdict === outcome.verdict,
    ruleMatch: outcome.verdict === "rejected" && prediction.verdict === "rejected" ? prediction.rule === outcome.rule : undefined,
  };
  rows.push(row);
  say(`case ${c} ${mempool}: predicted ${prediction.verdict} (${prediction.source}), node ${outcome.verdict}${outcome.rule ? ` [${outcome.rule}]` : ""} ${row.match ? "MATCH" : "MISMATCH"}`);
  if (outcome.verdict === "admitted" && wait > 0) {
    waiters.push(
      ap.waitForFrameTransactionReceipt({ hash, timeoutMs: wait }).then(
        ({ receipt }) => { row.outcome.included = true; row.outcome.block = Number(receipt.blockNumber); row.outcome.frameStatuses = receipt.frames.map((f: any) => f.status); },
        async () => {
          row.outcome.included = false;
          row.outcome.status = await ap.getTransactionStatus({ hash }).then((s) => s?.status ?? "unknown", () => "unknown");
        },
      ),
    );
  }
  return row;
}
const settle = async () => { await Promise.all(waiters.splice(0)); };
const receiptOf = async (hash: Hex, timeoutMs = 90_000) => ap.waitForFrameTransactionReceipt({ hash, timeoutMs });

async function legacy(to: Address | null, data: Hex, value: bigint, gas: bigint) {
  // eth_gasPrice on this devnet is inflated (~238 gwei) while the base fee is 7 wei; a fixed low legacy price is accepted.
  const hash = await wallet.sendTransaction({ type: "legacy", to: to as any, data, value, gas, gasPrice: 2_000_000n } as any);
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`tx ${hash} reverted`);
  return rc;
}

let ok = false;
const startedAt = new Date().toISOString();
const t0 = Date.now();
let caps: { staking: { registry?: Address; minUnstakeDelaySec: number } } | undefined;
try {
  caps = await ap.assertCompatible("gateway");
  const f = await ap.faucet(owner.address, "gateway");
  say(`funded ${owner.address}: faucet tx ${f.txHash}`);
  for (let i = 0; i < 30 && (await client.getBalance({ address: owner.address })) === 0n; i++) await sleep(1000);

  // ---- 1. plain self-paid tx on each mempool
  const plainPub = await signWith(await selfTx({}));
  const plainAlt = await signWith(await selfTx({}));
  const r1p = await attempt(1, "plain self-paid frame tx (VERIFY 60k)", "public", "admitted", plainPub, 90_000);
  const r1a = await attempt(1, "plain self-paid frame tx (VERIFY 60k)", "alt", "admitted", plainAlt, 240_000);

  // ---- 2. VERIFY gas over the public cap
  await attempt(2, "VERIFY gas 150k, over the 100k public cap", "public", "rejected (cap)", await signWith(await selfTx({ verify: 150_000n })));
  await attempt(2, "VERIFY gas 150k, over the 100k public cap", "alt", "admitted", await signWith(await selfTx({ verify: 150_000n })), 30_000);

  // ---- 3/4. a contract wallet whose VERIFY reads another contract's storage
  const fw = art("Foreign");
  const vw = art("ViolatingWallet");
  const foreign = (await legacy(null, fw.bytecode, 0n, 500_000n)).contractAddress as Address;
  const walletAddr = (await legacy(null, encodeDeployData({ abi: vw.abi, bytecode: vw.bytecode, args: [owner.address, foreign] }), parseEther("0.04"), 6_000_000n)).contractAddress as Address;
  say(`deployed Foreign ${foreign} and ViolatingWallet ${walletAddr}`);
  const violating = async (verifyData: Hex | undefined, extra: Parameters<typeof selfTx>[0] = {}) =>
    signWith(await selfTx({ sender: walletAddr, signer: owner.address, verifyData, ...extra, verify: 70_000n }));
  const stakeTx = async () => signWith(await selfTx({ sender: walletAddr, signer: owner.address, verify: 70_000n, to: caps!.staking.registry as Address, senderValue: parseEther("0.012"), senderData: registryCalldata.addStake(caps!.staking.minUnstakeDelaySec), senderState: 300_000n }));

  const N3 = "unstaked contract whose VERIFY reads another contract's storage";
  await attempt(3, N3, "public", "rejected (storage)", await violating("0x01"));
  await attempt(3, N3, "alt", "rejected (unstaked)", await violating("0x01"));

  // Stake the wallet from its own code (a SENDER frame calls addStake as the wallet; sent public, which mines fast). Clean VERIFY path, so it is admissible.
  const st = await stakeTx();
  const stakeHash = txHash(profile, st);
  await ap.submitFrameTransaction({ transaction: st, mempool: "public" });
  await receiptOf(stakeHash);
  say(`wallet staked: ${stakeHash}`);
  const stakeInfo = await ap.getEntityStake(walletAddr);
  const nodeStaked = await ap.isEntityStaked(walletAddr).catch(() => undefined);

  const N4 = "the same contract, staked";
  await attempt(4, N4, "public", "rejected (storage)", await violating("0x01"));
  await attempt(4, N4, "alt", "admitted", await violating("0x01"));

  // ---- 5. bad signature (signed by a key that is not the sender's)
  const N5 = "bad signature";
  await attempt(5, N5, "public", "rejected", await signWith(await selfTx({}), wrongKey));
  await attempt(5, N5, "alt", "rejected", await signWith(await selfTx({}), wrongKey));

  // ---- 6. ATOMIC_BATCH flag on the last frame
  const N6 = "ATOMIC_BATCH flag on the last frame";
  await attempt(6, N6, "public", "rejected at submit", await signWith(await selfTx({ flagsLast: ATOMIC_BATCH })));
  await attempt(6, N6, "alt", "rejected at submit", await signWith(await selfTx({ flagsLast: ATOMIC_BATCH })));

  // ---- 7. nonce replay: the case-1 txs again, once they are included
  await settle();
  const N7 = "nonce replay of an included tx";
  for (const [r, tx, m] of [[r1p, plainPub, "public"], [r1a, plainAlt, "alt"]] as const) {
    if (r.outcome.included) await attempt(7, N7, m, "rejected (nonce)", tx);
    else skipped.push({ case: 7, name: `${N7} (${m})`, reason: `the case-1 ${m} tx was not included within the wait, so there is no included tx to replay` });
  }

  // ---- 8. expiry deadline in the past
  const N8 = "expiry deadline in the past";
  const past = BigInt(Math.floor(Date.now() / 1000) - 3600);
  await attempt(8, N8, "public", "rejected (expired)", await signWith(await selfTx({ expiredDeadline: past })));
  await attempt(8, N8, "alt", "rejected (expired)", await signWith(await selfTx({ expiredDeadline: past })));

  // ---- 9. double-spend: the newest included ExitRelay exit, sent again (as apps/site/src/live.ts doctorReplay does)
  const N9 = "double-spend: newest included ExitRelay exit, re-sent";
  try {
    // The miner sidecar keeps its history in memory, so look on both nodes and every ExitRelay variant; take the newest block.
    const nodes = [{ name: "miner", url: DEVNET.minerSidecarUrl }, { name: "gateway", url: DEVNET.gatewayUrl }];
    const relays = [deployments.exitRelay, deployments.exitRelayRR, deployments.exitRelayWETH] as Address[];
    let newest: { hash: Hex; block: number; node: string } | undefined;
    for (const n of nodes) for (const a of relays) {
      const inc = (await entityStatus(a, gateway(n.url)).catch(() => undefined))?.inclusions ?? [];
      for (const i of inc) if (!newest || i.block > newest.block) newest = { hash: i.hash, block: i.block, node: n.name };
    }
    if (!newest) throw new Error("no ExitRelay inclusions on the miner sidecar or the gateway");
    const known = (await ap.getTransactionStatus({ hash: newest.hash, mempool: newest.node === "miner" ? undefined : "gateway" }))?.tx;
    if (!known) throw new Error(`${newest.node} no longer has ${newest.hash}`);
    const exit = decodeTx(profile, encodeTx(profile, known));
    say(`replaying exit ${newest.hash} (block ${newest.block}, from ${newest.node})`);
    await attempt(9, `${N9} (block ${newest.block}, original ${newest.hash})`, "public", "rejected (nonce used)", exit, 0);
    await attempt(9, `${N9} (block ${newest.block}, original ${newest.hash})`, "alt", "rejected (nonce used)", exit, 0);
  } catch (e: any) {
    skipped.push({ case: 9, name: N9, reason: String(e?.message ?? e) });
  }

  await settle();
  (globalThis as any).__stake = { wallet: walletAddr, foreign, stakeHash, stakedAmount: stakeInfo.amount.toString(), stakeDelaySec: stakeInfo.unstakeDelaySec, stakeState: stakeInfo.state, nodeStaked: nodeStaked?.staked };
  ok = true;
} catch (e: any) {
  say(`FAILED: ${e?.stack ?? e}`);
  skipped.push({ case: 0, name: "suite aborted", reason: String(e?.message ?? e) });
  process.exitCode = 1;
} finally {
  await settle().catch(() => {});
  const finishedAt = new Date().toISOString();
  const matched = rows.filter((r) => r.match).length;
  const verifiedRows = rows.filter((r) => r.prediction.verified);
  const extra = (globalThis as any).__stake;
  const results = {
    startedAt, finishedAt, seconds: Math.round((Date.now() - t0) / 1000), complete: ok,
    devnet: { chainId: DEVNET.chainId, ethrex: DEVNET.ethrexUrl, gateway: DEVNET.gatewayUrl, minerSidecar: DEVNET.minerSidecarUrl },
    simulator: { options: { explorer: false, estimate: false }, note: "predicted before sending; public = ethrex_simulateFrameTransaction (verified source), alt = local rule model (unverified)" },
    totals: { attempts: rows.length, matched, mismatched: rows.length - matched, skipped: skipped.length, predictedByEthrex: verifiedRows.length, matchedOfEthrex: verifiedRows.filter((r) => r.match).length, predictedByModel: rows.length - verifiedRows.length, matchedOfModel: rows.filter((r) => !r.prediction.verified && r.match).length },
    entities: extra,
    rows, skipped,
  };
  mkdirSync(new URL("../accuracy/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../accuracy/live-results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
  const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
  const lines = [
    "# Live devnet suite",
    "",
    `Run: ${startedAt} to ${finishedAt} (${results.seconds}s), chain ${DEVNET.chainId}.`,
    "",
    "Each tx is predicted by `createSimulator({ explorer: false, estimate: false })` on the signed raw tx before it is sent, so the node has no record of it. It is then sent (public: ethrex `eth_sendRawTransaction`; alt: the miner sidecar) and the node's answer is recorded.",
    "",
    "Prediction source: `simulate` = ethrex's own simulation (verified). `model` = our local alt rule model (unverified).",
    "",
    `**Matched ${matched} of ${rows.length} attempts.** Predicted by ethrex: ${results.totals.matchedOfEthrex} of ${results.totals.predictedByEthrex} matched. Predicted by the model: ${results.totals.matchedOfModel} of ${results.totals.predictedByModel} matched. Skipped: ${skipped.length}.`,
    "",
    "| Case | Mempool | Prediction (source) | Node outcome | Match | Tx |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => {
      const p = `${r.prediction.verdict}${r.prediction.rule ? ` [${r.prediction.rule}]` : ""} (${r.prediction.source}, ${r.prediction.verified ? "verified" : "unverified"})`;
      const o = r.outcome.verdict === "admitted"
        ? `admitted${r.outcome.included === true ? `, included in block ${r.outcome.block}` : r.outcome.included === false ? `, not included within the wait (sidecar status ${r.outcome.status ?? "unknown"})` : ""}`
        : `rejected [${r.outcome.rule}] ${r.outcome.code ?? ""}: ${r.outcome.message ?? ""}`;
      return `| ${r.case}. ${cell(r.name)} | ${r.mempool} | ${cell(p)} | ${cell(o)} | ${r.match ? "yes" : "no"} | [${short(r.hash)}](${r.explorer}) |`;
    }),
    "",
    "Rejected txs never reach a block. Their links use the locally computed hash and may show no record on the explorer.",
    "",
    "## Notes",
    "",
    "Match means the predicted verdict (admitted or rejected) equals the node's. `[rule]` is our rule id, derived from the node's own error text for the outcome. Rejections whose rule ids differ:",
    "",
    ...(rows.filter((r) => r.ruleMatch === false).map((r) => `- Case ${r.case} ${r.mempool}: predicted ${r.prediction.rule}, node ${r.outcome.rule}.`).concat(rows.some((r) => r.ruleMatch === false) ? [] : ["None."])),
    "",
    ...(rows.some((r) => !r.match) ? ["Verdict mismatches:", "", ...rows.filter((r) => !r.match).map((r) => `- Case ${r.case} ${r.mempool}: predicted ${r.prediction.verdict} ${r.prediction.rule ? `[${r.prediction.rule}] ` : ""}(${r.prediction.source}); node ${r.outcome.verdict}. ${r.prediction.message ?? ""}`.trim()), ""] : []),
    "",
    "## Skipped",
    "",
    ...(skipped.length ? skipped.map((s) => `- Case ${s.case}, ${s.name}: ${s.reason}`) : ["None."]),
    "",
    ...(extra ? ["## Entities", "", `- Violating wallet: \`${extra.wallet}\`, Foreign: \`${extra.foreign}\``, `- Wallet stake tx: [${short(extra.stakeHash)}](${link(extra.stakeHash)}); stake ${extra.stakedAmount} wei, unstake delay ${extra.stakeDelaySec}s, state ${extra.stakeState}, node says staked: ${String(extra.nodeStaked)}`, ""] : []),
    "Reproduce: `bun run --filter @altpool/simulator live-suite`. It uses a fresh key each run.",
    "",
  ];
  writeFileSync(new URL("../accuracy/LIVE.md", import.meta.url), lines.join("\n"));
  gatewaySidecar.close();
  minerSidecar.close();
  console.log(`matched ${matched}/${rows.length}, skipped ${skipped.length}`);
}
