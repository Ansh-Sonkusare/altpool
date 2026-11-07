// The viem extension. Usage:
//   const sidecar = createAltMempoolClient({ httpUrl, webSocketUrl, profile })
//   const client = createPublicClient({ chain, transport: http(EXECUTION_RPC) }).extend(altpoolActions({ sidecar }))
//   await client.altpool.getConfig()
// The execution client (ethrex) and the sidecar are separate endpoints. Everything lives under `altpool` so it never
// collides with viem's own future frame-transaction actions.
import type { AdmissionChecker, Address, Hex } from "@altpool/core";
import { encodeTx, txHash, type FrameTx, type RecentRootReference } from "@forshtat/hegota-support/tx";
import type { BlockTag, Client } from "viem";
import { getChainId } from "viem/actions";
import {
  compareMempoolProfiles, explainAdmissionFailure, getAdmissionReport, preflightFrameTransaction, simulateFrameTransaction,
  type NodeProfile, type PreflightArgs,
} from "./admission";
import { AltpoolSdkError, decodeRpcError, FrameAdmissionError, InteractiveSignerError, ProfileMismatchError, ReceiptTimeoutError, UnsupportedCapabilityError } from "./errors";
import type { AdmissionRecord, ExplorerInfo, FrameReceipt, FrameTxStatus, SidecarConfig } from "./normalize";
import { FINAL_STATUSES, parseReceipt } from "./normalize";
import { getKeyedNonce, getNonceSequence, prepareNonceKeys, validateNonceKeys } from "./nonces";
import { profileExtras } from "./profiles";
import { encodeRecentRootWrite, getCurrentSlot, getRecentRoot, prepareRecentRootReferences, recentRootSourceId, validateRecentRootReferences, verifyRecentRootPredeploy } from "./recentRoots";
import type { AltMempoolClient, SubmitResult } from "./sidecar";
import { getEntityStake, stakeEntity, stakingParameters, unlockEntityStake, withdrawEntityStake, type StakeEntityArgs, type StakingParameters } from "./staking";
import {
  applyGasReport, estimationProbe, gasReport, isInteractiveSigner, signFrameTransaction, validationPrefixLength,
  type FrameGasReport, type FrameSigner, type GasMargin,
} from "./transaction";
import {
  findReputation, watchEntityReputation, watchEntityStake, watchExplorerEvents, watchOnChainTransactions, watchPendingTransactions,
  watchSubmittedTransactions, watchTransaction, type ExplorerWatchArgs, type MempoolEvent, type WatchTransactionArgs,
} from "./watch";

export interface AltpoolActionsOptions {
  /** The default alt-mempool node. */
  sidecar: AltMempoolClient;
  /**
   * Other named alt-mempool nodes. A node joins one mempool through its P2P topic and config; there is no
   * per-transaction mempool id. Picking a mempool = picking the node endpoint.
   */
  mempools?: Record<string, AltMempoolClient>;
  /** Default AdmissionChecker run by preflight / submit({ precheck: true }). */
  precheck?: AdmissionChecker;
  /** Explorer base URL for links, e.g. https://explorer.altmempool.wtf */
  explorerUrl?: string;
}

/** "public" = ethrex's own mempool via eth_sendRawTransaction; any other name = a configured sidecar. */
export type MempoolTarget = "public" | string;

export interface Capabilities {
  chainId: { execution: number; sidecar: number; profile?: number; match: boolean };
  sidecar: { version?: string; protocolVersion?: number; commit?: string; bootId?: string; bundlingMode?: string };
  profile: { id: string; status: string; entryPointMatches: boolean; supportedBySdk: boolean };
  explorer: { enabled: boolean; historyCapacity?: number; inMemory: true; faucet: boolean };
  p2p: { enabled?: boolean; peers?: number };
  websocket: boolean;
  staking: { registry?: Address; minStake: bigint; minUnstakeDelaySec: number };
  mempools: { mempoolId: string; entryPoint: Address }[];
  validationGasLimit?: bigint;
  txGasLimit?: bigint;
  warnings: string[];
  config: SidecarConfig;
  info?: ExplorerInfo;
}

/** The estimator's probe is a valid tx with larger body limits: a person must never be asked to sign it. */
function assertNotInteractive(signer?: FrameSigner) {
  if (!isInteractiveSigner(signer)) return;
  throw new InteractiveSignerError("Gas estimation would ask the wallet to sign the estimator's probe (a second popup, over inflated limits).", {
    fix: "For a BridgeAccount use bridge.prepareTx (fills nonce, fees and limits without signing), then sign once with prepare: false.",
  });
}

export function altpoolActions(opts: AltpoolActionsOptions) {
  const { sidecar } = opts;
  const profile = sidecar.profile;
  const mempools: Record<string, AltMempoolClient> = { [sidecar.node.name]: sidecar, alt: sidecar, ...opts.mempools };
  for (const [name, m] of Object.entries(mempools)) {
    if (m.profile.id !== profile.id) throw new ProfileMismatchError(`Mempool "${name}" uses profile "${m.profile.id}" but the default sidecar uses "${profile.id}".`);
  }
  const pick = (name?: string): AltMempoolClient => {
    if (!name) return sidecar;
    const m = mempools[name];
    if (!m) throw new UnsupportedCapabilityError(`mempool:${name}`, `No mempool named "${name}". Configured: public, ${Object.keys(mempools).join(", ")}.`);
    return m;
  };

  return (client: Client) => {
    let params: Promise<StakingParameters> | undefined;
    const staking = () => (params ??= sidecar.getConfig().then((c) => stakingParameters(c, sidecar.node)).catch((e) => { params = undefined; throw e; }));

    const getMempoolInfo = async (name?: string): Promise<Capabilities> => {
      const node = pick(name);
      const [config, info, execChain, peers] = await Promise.all([
        node.getConfig(),
        node.getExplorerInfo().catch((e) => (e instanceof UnsupportedCapabilityError ? undefined : Promise.reject(e))),
        getChainId(client),
        node.getConnectedPeers().catch(() => undefined),
      ]);
      const warnings: string[] = [];
      const profileChain = profile.devnet.chainId;
      const match = config.chainId === execChain && (profileChain === undefined || profileChain === config.chainId);
      if (!match) warnings.push(`chain mismatch: execution ${execChain}, sidecar ${config.chainId}, profile ${profileChain}`);
      const ep = config.canonicalEntryPoint ?? config.entryPoints[0];
      const entryPointMatches = !!ep && ep.toLowerCase() === profile.entryPoint.toLowerCase();
      if (!entryPointMatches) warnings.push(`entry point ${ep} differs from profile ${profile.entryPoint}`);
      if (profile.status !== "current") warnings.push(`profile ${profile.id} is ${profile.status}${profile.supersededBy ? `; superseded by ${profile.supersededBy}` : ""}`);
      let supportedBySdk = true;
      try { profileExtras(profile); } catch { supportedBySdk = false; warnings.push(`the SDK has no verified devnet facts for ${profile.id}`); }
      if (info) warnings.push("explorer history is in memory on this node (lost on restart) and publicly readable");
      if (!info) warnings.push("explorer API disabled: no admission reports or lifecycle events");
      if (config.validationGasLimit && config.validationGasLimit >= 10_000_000n) warnings.push(`validation gas limit is ${config.validationGasLimit} (effectively uncapped on this node; other nodes may cap it)`);
      return {
        chainId: { execution: execChain, sidecar: config.chainId, profile: profileChain, match },
        sidecar: { version: info?.version, protocolVersion: info?.protocolVersion, commit: info?.commit || undefined, bootId: info?.bootId, bundlingMode: info?.bundlingMode },
        profile: { id: profile.id, status: profile.status, entryPointMatches, supportedBySdk },
        explorer: { enabled: !!info, historyCapacity: info?.historyCapacity, inMemory: true, faucet: !!info?.faucetEnabled },
        p2p: { enabled: info?.p2pEnabled, peers: peers?.length },
        websocket: node.hasWebSocket(),
        staking: { registry: config.stakingRegistry, minStake: config.minStake, minUnstakeDelaySec: config.minUnstakeDelaySec },
        mempools: config.supportedMempools,
        validationGasLimit: config.validationGasLimit,
        txGasLimit: config.txGasLimit,
        warnings,
        config,
        info,
      };
    };

    /** Throws ProfileMismatchError when the execution client, sidecar and profile disagree on the chain. */
    const assertCompatible = async (name?: string) => {
      const c = await getMempoolInfo(name);
      if (!c.chainId.match) throw new ProfileMismatchError(c.warnings[0]!);
      if (!c.profile.entryPointMatches) throw new ProfileMismatchError(`Entry point mismatch for profile ${profile.id}.`);
      return c;
    };

    const estimateFrameTransactionGas = async (args: { transaction: FrameTx; signer?: FrameSigner; margin?: GasMargin; mempool?: string }): Promise<FrameGasReport> => {
      assertNotInteractive(args.signer);
      const node = pick(args.mempool);
      const probe = args.signer ? await signFrameTransaction(profile, estimationProbe(profile, args.transaction), args.signer) : args.transaction;
      return gasReport(profile, args.transaction, await node.estimateFrameTransactionGas(probe), args.margin);
    };

    /** Fill fees (node gas price unless given) and body-frame gas (from the estimator). Returns an UNSIGNED tx. */
    const prepareFrameTransaction = async (args: { transaction: FrameTx; signer?: FrameSigner; margin?: GasMargin; fees?: "node" | "keep"; feeMultiplierPercent?: bigint; mempool?: string }) => {
      assertNotInteractive(args.signer);
      let tx = args.transaction;
      if (args.fees !== "keep") {
        const gp = await pick(args.mempool).getGasPrice();
        const mul = args.feeMultiplierPercent ?? 100n;
        tx = { ...tx, fees: { ...tx.fees, maxFeePerGas: gp.maxFeePerGas * mul / 100n, maxPriorityFeePerGas: gp.maxPriorityFeePerGas * mul / 100n } };
      }
      const gas = await estimateFrameTransactionGas({ transaction: tx, signer: args.signer, margin: args.margin, mempool: args.mempool });
      return { transaction: applyGasReport(tx, gas), gas };
    };

    /**
     * Submit a SIGNED tx to one mempool. Never retried. `precheck` runs an AdmissionChecker first and throws if it
     * predicts a rejection on that mempool.
     */
    const submitFrameTransaction = async (args: { transaction: FrameTx; mempool?: MempoolTarget; precheck?: AdmissionChecker | boolean }): Promise<SubmitResult> => {
      const checker = args.precheck === true ? opts.precheck : args.precheck || undefined;
      const target = args.mempool ?? "alt";
      if (checker) {
        const rep = await checker.check(args.transaction);
        const v = rep.verdicts[target === "public" ? "public" : "alt"];
        if (v && v.verdict === "rejected") {
          throw new FrameAdmissionError(`precheck predicts ${target} rejects: ${v.failed?.rule ?? v.error?.message ?? "unknown"}`, {
            detail: { kind: "ruleViolation", mempool: target === "public" ? "public" : "alt", rule: v.failed?.rule ?? "unknown", entity: v.failed?.entity, message: v.error?.message ?? "" },
            fix: v.fix,
          });
        }
      }
      if (target === "public") {
        const localHash = txHash(profile, args.transaction);
        try {
          const hash = (await client.request({ method: "eth_sendRawTransaction", params: [encodeTx(profile, args.transaction)] })) as Hex;
          return { hash, localHash, hashMatches: hash.toLowerCase() === localHash.toLowerCase(), mempool: "public", node: { name: "public", url: "execution" } };
        } catch (e: any) {
          const inner = e?.cause ?? e;
          throw decodeRpcError({ method: "eth_sendRawTransaction", url: "execution", code: inner?.code ?? -32000, message: inner?.details ?? inner?.message ?? String(e), data: inner?.data, raw: e }, "public");
        }
      }
      const r = await pick(target).sendFrameTransaction(args.transaction);
      return { ...r, mempool: target };
    };

    const waitForFrameTransactionReceipt = async (args: { hash: Hex; mempool?: string; timeoutMs?: number; pollingIntervalMs?: number; throwOnRevert?: boolean }): Promise<{ receipt: FrameReceipt; status: FrameTxStatus | null }> => {
      const node = pick(args.mempool);
      const end = Date.now() + (args.timeoutMs ?? 120_000);
      const every = args.pollingIntervalMs ?? 2_000;
      let status: FrameTxStatus | null = null;
      // The sidecar can lag the chain by minutes (its reconciler marks OnChain late), so after a sidecar miss also ask
      // the execution client: ethrex's eth_getTransactionReceipt carries frameReceipts for type-0x06 txs.
      const fromChain = async (): Promise<FrameReceipt | null> => {
        const r = await client.request({ method: "eth_getTransactionReceipt", params: [args.hash] } as never).catch(() => null);
        return r ? parseReceipt(args.hash, r, "execution") : null;
      };
      while (Date.now() < end) {
        const receipt = (await node.getFrameTransactionReceipt(args.hash).catch(() => null)) ?? (await fromChain());
        if (receipt) {
          status = await node.getTransactionStatus(args.hash).catch(() => null);
          if (args.throwOnRevert && receipt.status !== "success") throw new AltpoolSdkError(`Frame tx ${args.hash} was included but failed`, { fix: "Inspect receipt.frames for the failing frame." });
          return { receipt, status };
        }
        status = await node.getTransactionStatus(args.hash).catch(() => null);
        if (status && (status.status === "Cancelled" || (status.status === "Reverted" && !receipt))) {
          throw new AltpoolSdkError(`Frame tx ${args.hash} is ${status.status}${status.reason ? `: ${status.reason}` : ""}`, { fix: "Read getAdmissionReport(hash) for the node's lifecycle events." });
        }
        await new Promise((r) => setTimeout(r, every));
      }
      throw new ReceiptTimeoutError(`No receipt for ${args.hash} after ${args.timeoutMs ?? 120_000} ms (last status: ${status?.status ?? "unknown"}).`);
    };

    const altpool = {
      sidecar,
      profile,
      mempool: pick,
      mempoolNames: () => ["public", ...Object.keys(mempools)],
      explorerLink: (hash: Hex) => (opts.explorerUrl ? `${opts.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : undefined),

      // ---- configuration
      getConfig: (mempool?: string) => pick(mempool).getConfig(),
      getExplorerInfo: (mempool?: string) => pick(mempool).getExplorerInfo(),
      getMempoolInfo,
      assertCompatible,
      getConnectedPeers: (mempool?: string) => pick(mempool).getConnectedPeers(),
      getGasPrice: (mempool?: string) => pick(mempool).getGasPrice(),
      faucet: (address: Address, mempool?: string) => pick(mempool).faucet(address),

      // ---- transactions
      validationPrefixLength: (tx: FrameTx) => validationPrefixLength(profile, tx),
      signFrameTransaction: (args: { transaction: FrameTx; signer: FrameSigner; index?: number }) => signFrameTransaction(profile, args.transaction, args.signer, args.index),
      estimateFrameTransactionGas,
      prepareFrameTransaction,
      submitFrameTransaction,
      /** prepare (optional) -> sign -> submit. Still a single, explicit submission. */
      sendFrameTransaction: async (args: { transaction: FrameTx; signer: FrameSigner; prepare?: boolean; margin?: GasMargin; mempool?: MempoolTarget; precheck?: AdmissionChecker | boolean }) => {
        let tx = args.transaction;
        let gas: FrameGasReport | undefined;
        if (args.prepare) ({ transaction: tx, gas } = await prepareFrameTransaction({ transaction: tx, signer: args.signer, margin: args.margin, mempool: args.mempool === "public" ? undefined : args.mempool }));
        const signed = await signFrameTransaction(profile, tx, args.signer);
        const sent = await submitFrameTransaction({ transaction: signed, mempool: args.mempool, precheck: args.precheck });
        return { ...sent, transaction: signed, gas };
      },
      getFrameTransaction: (args: { hash: Hex; mempool?: string }) => pick(args.mempool).getFrameTransaction(args.hash),
      getFrameTransactionReceipt: (args: { hash: Hex; mempool?: string }) => pick(args.mempool).getFrameTransactionReceipt(args.hash),
      getTransactionStatus: (args: { hash: Hex; mempool?: string }) => pick(args.mempool).getTransactionStatus(args.hash),
      simulateFrameTransaction: (args: { transaction: FrameTx; trace?: boolean }) => simulateFrameTransaction(client, profile, args.transaction, { trace: args.trace }),
      waitForFrameTransactionReceipt,

      // ---- admission
      preflightFrameTransaction: (args: PreflightArgs & { mempool?: string }) => preflightFrameTransaction(client, pick(args.mempool), { precheck: opts.precheck, ...args }),
      getAdmissionReport: (args: { hash: Hex; mempool?: string }) => getAdmissionReport(pick(args.mempool), args.hash, { explorerUrl: opts.explorerUrl }),
      explainAdmissionFailure: (e: AltpoolSdkError | AdmissionRecord) => explainAdmissionFailure(e),
      compareMempoolProfiles: async (a: string, b: string) => {
        const load = async (n: string): Promise<NodeProfile> => ({ name: n, config: await pick(n).getConfig(), info: await pick(n).getExplorerInfo().catch(() => undefined) });
        return compareMempoolProfiles(await load(a), await load(b));
      },

      // ---- staking (registry + minimums from skandha_config)
      getStakingParameters: staking,
      getMinimumStake: async () => { const p = await staking(); return { minStake: p.minStake, minUnstakeDelaySec: p.minUnstakeDelaySec, registry: p.registry, node: p.node }; },
      getEntityStake: async (entity: Address) => getEntityStake(client, await staking(), entity),
      /** The node's verdict when its debug API answers (source "node"), else the registry read (source "contract"). */
      isEntityStaked: async (entity: Address): Promise<{ staked: boolean; source: "node" | "contract"; node: string }> => {
        const p = await staking();
        try {
          return { staked: (await sidecar.getNodeStakeStatus(entity, p.registry)).isStaked, source: "node", node: sidecar.node.name };
        } catch {
          return { staked: (await getEntityStake(client, p, entity)).meetsMinimum, source: "contract", node: sidecar.node.name };
        }
      },
      /** State-changing. `wallet` must be the entity itself (an EOA signing for its own address). */
      stakeEntity: async (args: StakeEntityArgs & { wallet?: Client }) => stakeEntity(client, args.wallet ?? client, await staking(), args),
      unlockEntityStake: async (args: { wallet?: Client; entity?: Address } = {}) => unlockEntityStake(client, args.wallet ?? client, await staking(), args.entity),
      withdrawEntityStake: async (args: { wallet?: Client; to?: Address; entity?: Address } = {}) => withdrawEntityStake(client, args.wallet ?? client, await staking(), args),

      // ---- keyed nonces
      getKeyedNonce: (args: { sender: Address; key: bigint; blockTag?: BlockTag }) => getKeyedNonce(client, profile, args),
      getNonceSequence: (args: { sender: Address; keys: bigint[]; blockTag?: BlockTag }) => getNonceSequence(client, profile, args),
      validateNonceKeys: (keys: bigint[]) => validateNonceKeys(profile, keys),
      prepareNonceKeys: (args: { sender: Address; keys?: bigint[]; mempool?: string; checkPending?: boolean }) =>
        prepareNonceKeys(client, profile, { sender: args.sender, keys: args.keys, pending: args.checkPending === false ? undefined : pick(args.mempool) }),

      // ---- recent roots
      getCurrentSlot: () => getCurrentSlot(client),
      recentRootSourceId,
      encodeRecentRootWrite,
      verifyRecentRootPredeploy: () => verifyRecentRootPredeploy(client, profile),
      getRecentRoot: (ref: RecentRootReference) => getRecentRoot(client, profile, ref),
      validateRecentRootReferences: (refs: RecentRootReference[]) => validateRecentRootReferences(client, profile, refs),
      prepareRecentRootReferences: (args: { transaction: FrameTx; references: RecentRootReference[] }) => prepareRecentRootReferences(client, profile, args.transaction, args.references),

      // ---- monitoring
      watchExplorerEvents: (args: ExplorerWatchArgs & { mempool?: string }) => watchExplorerEvents(pick(args.mempool), args),
      watchPendingTransactions: (onEvent: (e: MempoolEvent) => void, onError?: (e: AltpoolSdkError) => void, mempool?: string) => watchPendingTransactions(pick(mempool), onEvent, onError),
      watchSubmittedTransactions: (onEvent: (e: MempoolEvent) => void, onError?: (e: AltpoolSdkError) => void, mempool?: string) => watchSubmittedTransactions(pick(mempool), onEvent, onError),
      watchOnChainTransactions: (onEvent: (e: MempoolEvent) => void, onError?: (e: AltpoolSdkError) => void, mempool?: string) => watchOnChainTransactions(pick(mempool), onEvent, onError),
      watchTransaction: (args: WatchTransactionArgs & { hash: Hex; mempool?: string }) => watchTransaction(pick(args.mempool), args.hash, args),
      watchEntityReputation: (args: { address: Address; mempool?: string; onChange: Parameters<typeof watchEntityReputation>[2]["onChange"]; onError?: (e: AltpoolSdkError) => void; intervalMs?: number }) =>
        watchEntityReputation(pick(args.mempool), args.address, args),
      getEntityReputation: (args: { address: Address; mempool?: string; maxPages?: number }) => findReputation(pick(args.mempool), args.address, args.maxPages),
      watchEntityStake: async (args: { entity: Address; onChange: (s: Awaited<ReturnType<typeof getEntityStake>>) => void; onError?: (e: AltpoolSdkError) => void; intervalMs?: number }) =>
        watchEntityStake(client, await staking(), args.entity, args),
    };
    return { altpool };
  };
}

export type AltpoolActions = ReturnType<ReturnType<typeof altpoolActions>>["altpool"];
export { FINAL_STATUSES };
