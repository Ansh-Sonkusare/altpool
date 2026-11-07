// Write tools: build, sign, check, submit and follow frame txs, plus the repair actions an agent needs to act on a
// frame-doctor fix (fund, stake). Handlers never throw: failures come back as { isError } with a Fix: line.
//
// Every submit path runs frame-doctor on the SIGNED tx first and refuses to send a tx the alt mempool is predicted to
// reject (pass force: true to send anyway and read the node's own verdict with get_admission_report).
import { formatEther, getAddress, isAddress, parseAbi, parseEther, type Address, type Hex } from "viem";
import { setTimeout as sleep } from "node:timers/promises";
import { frame, newTx, randomNonceKey, secp256k1Placeholder, signFrameTransaction, toWire, fromWire, type BridgeCall, type FrameTx } from "altpool";
import { decodeTx } from "@forshtat/hegota-support/tx";
import { gateway } from "@altpool/core";
import { checkAdmission, renderReport, summarize } from "@altpool/simulator";
import { bridgeAccountAbi } from "@altpool/wallet-bridge";
import { bridgeAccount } from "altpool";
import { agent, ctx, explorerLink, loadSession, profile } from "./context";
import { fail, msgOf, ok, toJson, type ToolResult } from "./result";

export interface CallInput { to: string; value?: string; data?: string; gas?: string; state?: string }

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Wire-style call input (decimal or 0x strings) -> BridgeCall. Throws with what is wrong. */
export function parseCalls(calls: CallInput[] | undefined): BridgeCall[] {
  if (!calls?.length) throw new Error("Give at least one call.");
  if (calls.length > 6) throw new Error("At most 6 calls per tx (BridgeAccount's session mode caps SENDER frames at 6).");
  const big = (v: string | undefined, what: string) => {
    if (v === undefined) return undefined;
    try { return BigInt(v); } catch { throw new Error(`${what} "${v}" is not a number (decimal or 0x hex).`); }
  };
  return calls.map((c, i) => {
    if (!isAddress(c.to, { strict: false })) throw new Error(`calls[${i}].to "${c.to}" is not an address.`);
    if (c.data !== undefined && !HEX.test(c.data)) throw new Error(`calls[${i}].data is not 0x hex.`);
    return { to: getAddress(c.to), value: big(c.value, `calls[${i}].value`) ?? 0n, data: (c.data as Hex | undefined) ?? "0x", gas: big(c.gas, `calls[${i}].gas`), state: big(c.state, `calls[${i}].state`) };
  });
}

/** frame-doctor on the signed tx; submit unless the alt mempool is predicted to reject it. */
async function checkAndSubmit(tx: FrameTx, opts: { dryRun?: boolean; force?: boolean; label: string }): Promise<ToolResult> {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  let report: Awaited<ReturnType<typeof checkAdmission>>, text: string;
  try {
    report = await checkAdmission(tx);
    text = `${summarize(report)}\n${renderReport(report, { verbose: false })}`;
  } finally { prev === undefined ? delete process.env.NO_COLOR : (process.env.NO_COLOR = prev); }
  const alt = report.verdicts.alt;
  const wire = toJson(toWire(tx));
  if (opts.dryRun) return ok(`${opts.label}: dry run, not submitted.\n${text}`, wire);
  if (alt.verdict === "rejected" && !opts.force) {
    return { isError: true, content: [{ type: "text", text: `${opts.label}: NOT submitted, frame-doctor predicts the alt mempool rejects it.\n${text}\nFix: apply the fix above (fund_from_faucet / stake_entity / change the calls) and retry, or pass force: true to send anyway.` }, { type: "text", text: toJson(report) }] };
  }
  try {
    const { hash } = await ctx().sdk.altpool.submitFrameTransaction({ transaction: tx });
    return ok(`${opts.label}: admitted by the alt mempool. hash ${hash}\nexplorer ${explorerLink(hash)}\nNext: wait_for_receipt { hash: "${hash}" }.\n${text}`, toJson({ hash, explorer: explorerLink(hash), tx: toWire(tx) }));
  } catch (e) {
    const fix = (e as { fix?: string }).fix;
    return fail(`${opts.label}: the node rejected it: ${msgOf(e)}`, fix ?? "Read the rule above, fix it, and retry; get_admission_report has the node's checks for a hash it saw.");
  }
}

// ------------------------------------------------------------------------------------------- agent_info ------

export async function agentInfoTool(): Promise<ToolResult> {
  try {
    const { sdk, pub } = ctx();
    const a = agent();
    const [balance, staked, params] = await Promise.all([
      pub.getBalance({ address: a.address }),
      sdk.altpool.isEntityStaked(a.address).then((s) => s.staked).catch(() => undefined),
      sdk.altpool.getStakingParameters().catch(() => undefined),
    ]);
    const lines = [`agent EOA ${a.address}: ${formatEther(balance)} ETH, ${staked === undefined ? "stake unknown" : staked ? "staked" : "not staked"} (key in packages/mcp/.env or ALTPOOL_AGENT_PK; never printed).`];
    let session: unknown = null;
    try {
      const s = loadSession();
      if (s) {
        const left = Number(s.session.validUntil) - Math.floor(Date.now() / 1000);
        const bal = await pub.getBalance({ address: s.account });
        lines.push(`session on BridgeAccount ${s.account} (owner ${s.owner}, balance ${formatEther(bal)} ETH): key ${s.session.key}, target ${s.session.target === "0x0000000000000000000000000000000000000000" ? "any" : s.session.target}, max value ${s.session.maxValuePerTx} wei/tx, max fee ${formatEther(s.session.maxCostPerTx)} ETH/tx, ${left > 0 ? `expires in ${Math.floor(left / 60)} min` : "EXPIRED"}.`);
        session = { account: s.account, owner: s.owner, session: s.session, expiresInSec: left };
      } else lines.push("no session (set ALTPOOL_SESSION to the file wallet-bridge-web exports to act for a user's BridgeAccount).");
    } catch (e) { lines.push(`ALTPOOL_SESSION is set but unusable: ${msgOf(e)}`); }
    if (params) lines.push(`staking registry ${params.registry}, minStake ${formatEther(params.minStake)} ETH (stake must be strictly above), min unstake delay ${params.minUnstakeDelaySec}s.`);
    return ok(lines.join("\n"), toJson({ agent: { address: a.address, balance, staked }, session, staking: params }));
  } catch (e) {
    return fail(`Could not read agent info: ${msgOf(e)}`, "Check the devnet RPC is reachable (ETHREX_URL / MINER_SIDECAR_URL).");
  }
}

// ------------------------------------------------------------------------------------------- send_calls ------

export async function sendCallsTool(args: { calls: CallInput[]; via?: "agent" | "session"; parallel?: boolean; dryRun?: boolean; force?: boolean }): Promise<ToolResult> {
  let calls: BridgeCall[];
  try { calls = parseCalls(args.calls); } catch (e) { return fail(msgOf(e), 'Pass calls as [{ to: "0x…", value?: "wei", data?: "0x…" }].'); }
  const via = args.via ?? "agent";
  try {
    const { sdk, sidecar, pub } = ctx();
    if (via === "session") {
      const s = loadSession();
      if (!s) return fail("No session configured.", "Authorise a session in apps/wallet-bridge-web, export it, and set ALTPOOL_SESSION to the file path (restart the MCP server).");
      if (s.session.validUntil <= BigInt(Math.floor(Date.now() / 1000))) return fail("The session has expired.", "Authorise a new session in apps/wallet-bridge-web and export it again.");
      const tx = await s.bridge.prepareSessionTx({ client: pub, sidecar, session: s.session, ownerSignature: s.ownerSignature, calls });
      const signed = await signFrameTransaction(profile, tx, { privateKey: s.sessionPrivateKey });
      return checkAndSubmit(signed, { dryRun: args.dryRun, force: args.force, label: `session tx from ${s.account}` });
    }
    // The agent EOA is a default-code account: [VERIFY self, approves execution+payment] [SENDER call]...
    const a = agent();
    const key = args.parallel ? randomNonceKey() : 0n;
    const { seq } = await sdk.altpool.getKeyedNonce({ sender: a.address, key });
    const draft = newTx({
      chainId: profile.devnet.chainId ?? 1337,
      sender: a.address,
      nonceKeys: [key],
      nonceSeq: seq,
      fees: { maxFeePerGas: 1n },
      signatures: [secp256k1Placeholder(profile)],
      frames: [
        frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 60_000n }),
        ...calls.map((c) => frame(profile, "SENDER", { target: c.to, value: c.value ?? 0n, data: c.data ?? "0x", execution: c.gas ?? 50_000n, state: c.state ?? 200_000n })),
      ],
    });
    // A local key is not interactive, so the SDK may sign the estimator's probe: real gas numbers for each call.
    const { transaction } = await sdk.altpool.prepareFrameTransaction({ transaction: draft, signer: a.account, feeMultiplierPercent: 200n });
    const signed = await signFrameTransaction(profile, transaction, a.account);
    return checkAndSubmit(signed, { dryRun: args.dryRun, force: args.force, label: `agent tx from ${a.address}` });
  } catch (e) {
    const fix = (e as { fix?: string }).fix;
    return fail(`Could not build or send the tx: ${msgOf(e)}`, fix ?? (via === "agent" ? "If the agent has no ETH, run fund_from_faucet first." : "Check the BridgeAccount has ETH and the calls fit the session limits (agent_info)."));
  }
}

// ----------------------------------------------------------------------------- owner (human) signs: prepare ------

async function ownerOf(account: Address): Promise<Address> {
  const o = await ctx().pub.readContract({ address: account, abi: bridgeAccountAbi, functionName: "OWNER" }).catch(() => undefined);
  if (!o) throw new Error(`${account} is not a BridgeAccount (no OWNER()).`);
  return getAddress(o as Address);
}

export async function prepareOwnerTxTool(args: { account: string; calls: CallInput[] }): Promise<ToolResult> {
  if (!isAddress(args.account, { strict: false })) return fail(`"${args.account}" is not an address.`, "Pass the BridgeAccount address.");
  let calls: BridgeCall[];
  try { calls = parseCalls(args.calls); } catch (e) { return fail(msgOf(e), 'Pass calls as [{ to: "0x…", value?: "wei", data?: "0x…" }].'); }
  try {
    const account = getAddress(args.account);
    const owner = await ownerOf(account);
    const { pub, sidecar } = ctx();
    const { tx, typedData } = await bridgeAccount({ address: account, owner, profile }).prepareTx({ client: pub, sidecar, calls });
    return ok(
      `Unsigned Mode A tx for BridgeAccount ${account}. The owner ${owner} must sign the EIP-712 typed data below in their wallet (eth_signTypedData_v4; every field is re-checked on-chain).\nNext: submit_frame_tx { tx: <the tx JSON>, ownerSignature: "0x…" }.`,
      toJson({ tx: toWire(tx), typedData, signWith: "eth_signTypedData_v4", owner }),
    );
  } catch (e) {
    return fail(`Could not prepare the tx: ${msgOf(e)}`, "Check the account is a deployed BridgeAccount (apps/wallet-bridge-web deploys one).");
  }
}

export async function submitFrameTxTool(args: { tx?: unknown; raw?: string; ownerSignature?: string; dryRun?: boolean; force?: boolean }): Promise<ToolResult> {
  if ((args.tx === undefined) === (args.raw === undefined)) return fail("Pass exactly one of `tx` or `raw`.", "Give the wire-JSON tx (from prepare_owner_tx) as `tx`, or the 0x encoding as `raw`.");
  try {
    let tx: FrameTx = args.raw !== undefined ? decodeTx(profile, args.raw as Hex) : fromWire(args.tx);
    if (args.ownerSignature !== undefined) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(args.ownerSignature)) return fail("ownerSignature must be the 65-byte eth_signTypedData_v4 result.", "Pass the wallet's signature exactly as returned (0x + 130 hex chars).");
      const owner = await ownerOf(tx.sender);
      const bridge = bridgeAccount({ address: tx.sender, owner, profile });
      tx = bridge.attachSignature(tx, args.ownerSignature as Hex);
      if (!(await bridge.isOwnerSignature(tx, args.ownerSignature as Hex))) {
        return fail(`The signature does not recover the account owner ${owner}.`, "Sign the typedData from prepare_owner_tx, unchanged, with the owner's wallet on chain 1337.");
      }
    }
    return checkAndSubmit(tx, { dryRun: args.dryRun, force: args.force, label: `tx from ${tx.sender}` });
  } catch (e) {
    return fail(`Could not submit: ${msgOf(e)}`, "Pass the tx exactly as prepare_owner_tx returned it.");
  }
}

// ------------------------------------------------------------------------------------- wait_for_receipt ------

export async function waitForReceiptTool(args: { hash: string; timeoutSec?: number }): Promise<ToolResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.hash)) return fail(`"${args.hash}" is not a transaction hash.`, "Pass the 0x 32-byte hash send_calls / submit_frame_tx returned.");
  try {
    const { receipt, status } = await ctx().sdk.altpool.waitForFrameTransactionReceipt({ hash: args.hash as Hex, timeoutMs: Math.min(args.timeoutSec ?? 120, 600) * 1000 });
    const frames = receipt.frames.map((f) => `frame ${f.index} ${f.status} (gas ${f.gasUsed.execution}${f.gasUsed.state ? ` + state ${f.gasUsed.state}` : ""})`).join("; ");
    const allOk = receipt.status === "success" && receipt.frames.every((f) => f.status === "success");
    return ok(`${allOk ? "Included, every frame succeeded" : "Included, but something FAILED"}: block ${receipt.blockNumber}, ${frames}.\nexplorer ${explorerLink(args.hash as Hex)}`, toJson({ receipt: { ...receipt, raw: undefined }, status }));
  } catch (e) {
    // Say what the node did with it: the sidecar can admit a tx and later cancel it (seen live: "relayed 4 times
    // without being included in a block", ethrex's builder dropping a contract-sender tx).
    const { sdk } = ctx();
    const status = await sdk.altpool.sidecar.getTransactionStatus(args.hash as Hex).catch(() => null);
    const report = await sdk.altpool.getAdmissionReport({ hash: args.hash as Hex }).catch(() => null);
    const last = report?.events?.at(-1);
    const why = status?.reason ?? (last && "reason" in last ? (last as { reason?: string }).reason : undefined);
    if (status?.status === "Cancelled" || status?.status === "Reverted" || last?.kind === "dropped") {
      return fail(
        `Not included: the node ${status?.status === "Reverted" ? "saw it revert" : "dropped it"} (${status?.status ?? last?.kind}${why ? `: ${why}` : ""}). Admission had succeeded; the block builder did not include it.`,
        "Its nonce is still free: build and sign it again (send_calls / prepare_owner_tx) and resubmit. ethrex intermittently drops 2-frame contract-sender txs; a resend usually lands.",
      );
    }
    return fail(`No receipt yet: ${msgOf(e)}${status?.status ? ` (node status ${status.status})` : ""}`, "Call wait_for_receipt again (blocks are 6 s; the shared devnet can lag), or get_admission_report to see whether the node dropped it.");
  }
}

// -------------------------------------------------------------------------------------- repair actions ------

export async function fundFromFaucetTool(args: { address?: string }): Promise<ToolResult> {
  const target = args.address ?? agent().address;
  if (!isAddress(target, { strict: false })) return fail(`"${target}" is not an address.`, "Pass a 0x 20-byte address, or omit it to fund the agent.");
  try {
    const { pub } = ctx();
    const before = await pub.getBalance({ address: target as Address });
    const r = await gateway().faucet(target as Address);
    let after = before;
    for (let i = 0; i < 30 && after <= before; i++) { await sleep(2000); after = await pub.getBalance({ address: target as Address }); }
    return ok(`Faucet ${after > before ? `sent ${formatEther(after - before)} ETH` : "answered, balance not up yet"}: ${target} now has ${formatEther(after)} ETH.`, toJson({ faucet: r, before, after }));
  } catch (e) {
    return fail(`Faucet failed: ${msgOf(e)}`, "The faucet limit is in memory per address; wait or fund from another funded key.");
  }
}

const stakeAbi = parseAbi(["function stake(address registry, uint32 delay) payable"]);

export async function stakeEntityTool(args: { contract?: string; amountEth?: string; unstakeDelaySec?: number }): Promise<ToolResult> {
  try {
    const { sdk, pub } = ctx();
    const a = agent();
    const p = await sdk.altpool.getStakingParameters();
    const amount = args.amountEth !== undefined ? parseEther(args.amountEth) : p.minStake + parseEther("0.002");
    if (amount <= p.minStake) return fail(`${formatEther(amount)} ETH is not above minStake ${formatEther(p.minStake)} ETH.`, `Stake more than ${formatEther(p.minStake)} ETH (strictly above).`);
    const delay = args.unstakeDelaySec ?? Math.max(p.minUnstakeDelaySec, 86_400);
    let hash: Hex, entity: Address;
    if (args.contract) {
      // The registry keys stakes on msg.sender, so a contract entity must call addStake itself. Convention (ExitRelay,
      // BridgeAccount-style paymasters): an external payable stake(registry, delay) that forwards to addStake.
      if (!isAddress(args.contract, { strict: false })) return fail(`"${args.contract}" is not an address.`, "Pass the contract to stake.");
      entity = getAddress(args.contract);
      await pub.simulateContract({ account: a.account, address: entity, abi: stakeAbi, functionName: "stake", args: [p.registry, delay], value: amount });
      hash = await a.wallet.writeContract({ address: entity, abi: stakeAbi, functionName: "stake", args: [p.registry, delay], value: amount });
    } else {
      entity = a.address;
      hash = await sdk.altpool.stakeEntity({ wallet: a.wallet, amount, unstakeDelaySec: delay });
    }
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") return fail(`Stake tx ${hash} reverted.`, args.contract ? "The contract needs a payable stake(address registry, uint32 delay) that calls registry.addStake{value}(delay)." : "Check the agent has the ETH (fund_from_faucet).");
    const staked = await sdk.altpool.isEntityStaked(entity).catch(() => undefined);
    return ok(`Staked ${formatEther(amount)} ETH for ${entity} (delay ${delay}s) in tx ${hash}. Node sees it as ${staked?.staked ? "staked" : "NOT yet staked (retry agent_info in a block)"}.`, toJson({ hash, entity, amount, delay, staked }));
  } catch (e) {
    const fix = (e as { fix?: string }).fix;
    return fail(`Could not stake: ${msgOf(e)}`, fix ?? (args.contract ? "The contract needs a payable stake(address registry, uint32 delay) that forwards to registry.addStake; or stake from its own code." : "Fund the agent first (fund_from_faucet)."));
  }
}
