// Wallet Bridge: drive an EIP-8141 BridgeAccount (packages/wallet-bridge) from any browser wallet. No wallet signs a
// type-0x06 tx, but every wallet signs EIP-712; the account's VERIFY frame recovers that signature with ecrecover.
//
//   const bridge = bridgeAccount({ address, owner, profile });
//   // Mode A: one wallet popup per tx
//   const { tx, typedData } = bridge.buildTx({ calls: [{ to, value: 1n }], nonce, fees });
//   const signed = bridge.attachSignature(tx, await wallet.signTypedData({ account: owner, ...typedData }));
//   // or: signFrameTransaction(profile, tx, typedDataSigner(wallet, bridge))
//   // Mode B: one popup per session, then a local key signs natively
//   const auth = bridge.authorizeSession(session);  // wallet.signTypedData(auth) -> ownerSignature
//   const tx = bridge.buildSessionTx({ session, ownerSignature, calls, nonce, fees, deadline });
//   const signed = await signFrameTransaction(profile, tx, { privateKey: sessionKey });
import {
  concat, encodeAbiParameters, getAddress, isAddressEqual, recoverTypedDataAddress, toHex,
  type Address, type Client, type Hex, type TypedDataDomain,
} from "viem";
import { getBalance, getCode, getGasPrice, getTransactionCount } from "viem/actions";
import { getKeyedNonce } from "./nonces";
import { frame, newTx, sigHash, sigScheme, type FrameTx } from "@forshtat/hegota-support/tx";
import type { Profile } from "./profiles";
import type { FrameSigner } from "./transaction";

export const BRIDGE_DOMAIN_NAME = "AltpoolBridge";
export const BRIDGE_DOMAIN_VERSION = "1";
/** VERIFY frame data tags (BridgeAccount.sol). */
export const BRIDGE_TAG = { owner: "0x01", session: "0x02" } as const;
export const EXPIRY_VERIFIER: Address = "0x0000000000000000000000000000000000008141";

/** Field names and order match BridgeLib.FRAME_TX_TYPEHASH. Every field is re-derived on-chain from the tx. */
export const frameTxTypes = {
  FrameTx: [
    { name: "sigHash", type: "bytes32" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "frameCount", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
  ],
} as const;

/** Matches BridgeLib.SESSION_TYPEHASH. */
export const sessionTypes = {
  Session: [
    { name: "key", type: "address" },
    { name: "validUntil", type: "uint64" },
    { name: "maxValuePerTx", type: "uint256" },
    { name: "maxCostPerTx", type: "uint256" },
    { name: "target", type: "address" },
  ],
} as const;

/** Matches BridgeLib.MESSAGE_TYPEHASH (EIP-1271 isValidSignature). */
export const messageTypes = { Message: [{ name: "hash", type: "bytes32" }] } as const;

export interface BridgeFrameTxMessage {
  sigHash: Hex; to: Address; value: bigint; nonce: bigint; frameCount: bigint; maxFeePerGas: bigint;
}

export interface BridgeSession {
  /** The local key that signs each tx (SECP256K1, protocol-verified). */
  key: Address;
  /** Unix seconds. Each tx's expiry-frame deadline must be <= this. */
  validUntil: bigint;
  maxValuePerTx: bigint;
  /** Bound on TXPARAM(MAX_COST) (gas limits x maxFeePerGas, plus intrinsic), so a leaked key cannot burn the balance on fees. */
  maxCostPerTx: bigint;
  /** The only allowed call target; the zero address allows any. */
  target: Address;
}

export interface BridgeCall {
  to: Address;
  value?: bigint;
  data?: Hex;
  /** Execution gas limit (default 50k). */
  gas?: bigint;
  /** State gas limit. A transfer that creates an account needs > 0 (default 0; a fresh account needs ~200k). */
  state?: bigint;
}

export interface BridgeTxArgs {
  calls: BridgeCall[];
  nonce: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint };
  /** EIP-8250 nonce key (default 0, the account nonce). */
  nonceKey?: bigint;
  /** VERIFY execution limit. The 100k unstaked cap counts DECLARED limits, so keep it tight.
   * Defaults: Mode A 40k (measured 30,020); Mode B 60k + 4k per extra call (measured 53,818 with one call). */
  verifyGas?: bigint;
}

type TypedDataOf<T, P extends string, M> = { domain: TypedDataDomain; types: T; primaryType: P; message: M };
export type FrameTxTypedData = TypedDataOf<typeof frameTxTypes, "FrameTx", BridgeFrameTxMessage>;
export type SessionTypedData = TypedDataOf<typeof sessionTypes, "Session", BridgeSession>;

export const DEFAULT_VERIFY_GAS = 40_000n;
/** Mode B checks every call frame, so its VERIFY limit grows with the call count. */
export const sessionVerifyGas = (calls: number): bigint => 60_000n + 4_000n * BigInt(Math.max(0, calls - 1));
export const EXPIRY_GAS = 10_000n;
const DEFAULT_CALL_GAS = 50_000n;
/** prepareTx limits. Unused SENDER-frame gas is refunded and only prefix (VERIFY) limits count toward the 100k cap,
 * so body frames are declared generously: the cost is a larger balance reservation, not a larger bill. */
export const PREPARED_CALL_GAS = 100_000n;
/** A value transfer that creates the recipient: 183,600 state gas on this devnet, plus slack. */
export const NEW_ACCOUNT_STATE_GAS = 200_000n;
/** A call with data may write fresh storage (97,920 state gas per new slot); a state limit of 0 halts it silently. */
export const PREPARED_CALL_STATE_GAS = 300_000n;

/** Where prepareTx takes fees from: the sidecar (preferred, what the alt mempool enforces) or explicit values. */
export interface FeeSource { getGasPrice: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> }

export interface PrepareArgs {
  /** A viem client on the execution RPC (ethrex): nonce, recipient state, and the fallback gas price. */
  client: Client;
  calls: BridgeCall[];
  /** Explicit fees win; else `sidecar.getGasPrice()` x feeMultiplierPercent; else eth_gasPrice. */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint };
  sidecar?: FeeSource;
  /** Applied to maxFeePerGas from the node (default 200: room for one base-fee rise). */
  feeMultiplierPercent?: bigint;
  /** Explicit nonce sequence; else read for `nonceKey`. */
  nonce?: bigint;
  nonceKey?: bigint;
  verifyGas?: bigint;
}

/**
 * Fill each call's limits without a signature. ethrex refuses eth_estimateGas from a contract sender (EIP-3607:
 * "Sender account ... shouldn't be a contract") and has no state override, and the sidecar estimator needs a
 * signature over its own probe, so a wallet-controlled account cannot be estimated before signing. Instead:
 * declare generous body limits (refunded), state gas only where a call can create state, and let the caller check
 * the SIGNED tx with preflight/checkAdmission before submitting. Explicit `gas`/`state` on a call always win.
 */
export async function prepareCalls(client: Client, calls: BridgeCall[]): Promise<BridgeCall[]> {
  return Promise.all(calls.map(async (c) => {
    if (c.state !== undefined) return { ...c, gas: c.gas ?? PREPARED_CALL_GAS };
    const hasData = !!c.data && c.data !== "0x";
    let state = 0n;
    if (hasData) state = PREPARED_CALL_STATE_GAS;
    else if ((c.value ?? 0n) > 0n) {
      const [balance, nonce, code] = await Promise.all([getBalance(client, { address: c.to }), getTransactionCount(client, { address: c.to }), getCode(client, { address: c.to })]);
      if (balance === 0n && nonce === 0 && (!code || code === "0x")) state = NEW_ACCOUNT_STATE_GAS;
    }
    return { ...c, gas: c.gas ?? PREPARED_CALL_GAS, state };
  }));
}

async function prepareFees(a: Pick<PrepareArgs, "client" | "fees" | "sidecar" | "feeMultiplierPercent">) {
  if (a.fees) return a.fees;
  const mul = a.feeMultiplierPercent ?? 200n;
  if (a.sidecar) {
    const gp = await a.sidecar.getGasPrice();
    return { maxFeePerGas: (gp.maxFeePerGas * mul) / 100n, maxPriorityFeePerGas: gp.maxPriorityFeePerGas };
  }
  const gp = await getGasPrice(a.client);
  return { maxFeePerGas: (gp * mul) / 100n, maxPriorityFeePerGas: gp };
}

export const bridgeDomain = (account: Address, chainId: bigint | number): TypedDataDomain => ({
  name: BRIDGE_DOMAIN_NAME, version: BRIDGE_DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: getAddress(account),
});

const sessionAbi = [
  { type: "tuple", components: sessionTypes.Session.map((f) => ({ name: f.name, type: f.type })) },
  { type: "bytes" },
] as const;

/** VERIFY data for Mode B: 0x02 || abi.encode(Session, ownerSignature). */
export const encodeSessionVerifyData = (s: BridgeSession, ownerSignature: Hex): Hex =>
  concat([BRIDGE_TAG.session, encodeAbiParameters(sessionAbi, [s, ownerSignature])]);

function assertSig65(sig: Hex) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error(`Expected a 65-byte r||s||v signature, got ${(sig.length - 2) / 2} bytes`);
}

export interface BridgeAccountConfig {
  address: Address;
  /** The wallet address that controls the account (BridgeAccount.OWNER). */
  owner: Address;
  profile: Profile;
}

export function bridgeAccount(cfg: BridgeAccountConfig) {
  const { profile } = cfg;
  const address = getAddress(cfg.address);
  const ARBITRARY = sigScheme(profile, "ARBITRARY");
  const SECP256K1 = sigScheme(profile, "SECP256K1");
  const VERIFY = profile.frameModes.VERIFY;
  const SENDER = profile.frameModes.SENDER;

  const callFrames = (calls: BridgeCall[]) => {
    if (!calls.length) throw new Error("At least one call");
    return calls.map((c) => frame(profile, "SENDER", { target: c.to, execution: c.gas ?? DEFAULT_CALL_GAS, state: c.state ?? 0n, value: c.value ?? 0n, data: c.data ?? "0x" }));
  };
  const base = (a: BridgeTxArgs) => ({
    chainId: profile.devnet.chainId ?? 1337,
    sender: address,
    nonceKeys: [a.nonceKey ?? 0n],
    nonceSeq: a.nonce,
    fees: { maxFeePerGas: a.fees.maxFeePerGas, maxPriorityFeePerGas: a.fees.maxPriorityFeePerGas ?? a.fees.maxFeePerGas },
  });

  /** The Mode A typed data for `tx`, derived exactly as BridgeAccount._verifyOwner derives it on-chain. */
  const typedDataFor = (tx: FrameTx): FrameTxTypedData => {
    const verify = tx.frames.findIndex((f) => f.mode === VERIFY && (f.target === null || isAddressEqual(f.target, address)));
    const call = tx.frames[verify + 1];
    if (verify < 0 || !call || call.mode !== SENDER) throw new Error("Mode A needs a self VERIFY frame followed by a SENDER frame");
    return {
      domain: bridgeDomain(address, tx.chainId),
      types: frameTxTypes,
      primaryType: "FrameTx",
      message: {
        sigHash: sigHash(profile, tx),
        to: getAddress(call.target ?? address),
        value: call.value,
        nonce: tx.nonceSeq,
        frameCount: BigInt(tx.frames.length),
        maxFeePerGas: tx.fees.maxFeePerGas,
      },
    };
  };

  /** Mode A: frames [VERIFY self (0x01), SENDER calls...], signature entry 0 ARBITRARY with signer "0x" (the node
   * rejects an ARBITRARY entry that names a signer) and msg "0x", so its bytes are elided from SIG_HASH. */
  const buildTx = (a: BridgeTxArgs): { tx: FrameTx; typedData: FrameTxTypedData } => {
    const tx = newTx({
      ...base(a),
      signatures: [{ scheme: ARBITRARY, signer: "0x", msg: "0x", signature: `0x${"00".repeat(65)}` }],
      frames: [
        frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: a.verifyGas ?? DEFAULT_VERIFY_GAS, data: BRIDGE_TAG.owner }),
        ...callFrames(a.calls),
      ],
    });
    return { tx, typedData: typedDataFor(tx) };
  };

  /** Put the wallet's eth_signTypedData_v4 result (r||s||v, as returned) into entry 0. Not repacked: the contract parses r||s||v. */
  const attachSignature = (tx: FrameTx, signature: Hex): FrameTx => {
    assertSig65(signature);
    if (tx.signatures[0]?.scheme !== ARBITRARY) throw new Error("Entry 0 is not an ARBITRARY entry: build the tx with buildTx");
    return { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature } : s)) };
  };

  /** Mode B: the typed data the owner signs once. */
  const authorizeSession = (session: BridgeSession): SessionTypedData => ({
    domain: bridgeDomain(address, profile.devnet.chainId ?? 1337),
    types: sessionTypes,
    primaryType: "Session",
    message: { ...session, key: getAddress(session.key), target: getAddress(session.target) },
  });

  /** Mode B: frames [VERIFY 0x8141 deadline, VERIFY self (0x02 || session), SENDER calls...], entry 0 SECP256K1 by
   * the session key. UNSIGNED: sign entry 0 with the session key, e.g. signFrameTransaction(profile, tx, { privateKey }). */
  const buildSessionTx = (a: BridgeTxArgs & { session: BridgeSession; ownerSignature: Hex; deadline: bigint }): FrameTx => {
    assertSig65(a.ownerSignature);
    if (a.deadline > a.session.validUntil) throw new Error(`deadline ${a.deadline} is after the session's validUntil ${a.session.validUntil}`);
    for (const c of a.calls) {
      if (!isAddressEqual(a.session.target, "0x0000000000000000000000000000000000000000") && !isAddressEqual(c.to, a.session.target)) throw new Error(`call target ${c.to} is not the session target`);
      if ((c.value ?? 0n) > a.session.maxValuePerTx) throw new Error(`call value ${c.value} exceeds maxValuePerTx`);
    }
    return newTx({
      ...base(a),
      signatures: [{ scheme: SECP256K1, signer: getAddress(a.session.key), msg: "0x", signature: "0x" }],
      frames: [
        frame(profile, "VERIFY", { target: EXPIRY_VERIFIER, execution: EXPIRY_GAS, data: toHex(a.deadline, { size: 8 }) }),
        frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: a.verifyGas ?? sessionVerifyGas(a.calls.length), data: encodeSessionVerifyData(a.session, a.ownerSignature) }),
        ...callFrames(a.calls),
      ],
    });
  };

  const nonceFor = async (client: Client, nonce: bigint | undefined, key: bigint | undefined) =>
    nonce ?? (await getKeyedNonce(client, profile, { sender: address, key: key ?? 0n })).seq;

  /** Mode A, ready to sign: nonce, fees and call limits filled from the chain. No wallet interaction. */
  const prepareTx = async (a: PrepareArgs) => buildTx({
    calls: await prepareCalls(a.client, a.calls),
    nonce: await nonceFor(a.client, a.nonce, a.nonceKey),
    nonceKey: a.nonceKey,
    fees: await prepareFees(a),
    verifyGas: a.verifyGas,
  });

  /** Mode B, ready for the session key to sign. A fresh random nonce key per tx (default) lets txs fly in parallel. */
  const prepareSessionTx = async (a: PrepareArgs & { session: BridgeSession; ownerSignature: Hex; deadline?: bigint }) => {
    const nonceKey = a.nonceKey ?? BigInt(toHex(crypto.getRandomValues(new Uint8Array(24))));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = a.deadline ?? (now + 600n < a.session.validUntil ? now + 600n : a.session.validUntil);
    return buildSessionTx({
      session: a.session, ownerSignature: a.ownerSignature, deadline,
      calls: await prepareCalls(a.client, a.calls),
      nonce: await nonceFor(a.client, a.nonce, nonceKey),
      nonceKey,
      fees: await prepareFees(a),
      verifyGas: a.verifyGas,
    });
  };

  /** Off-chain check that `signature` over `tx`'s typed data recovers the owner (what VERIFY will do). */
  const recoverOwner = (tx: FrameTx, signature: Hex) => recoverTypedDataAddress({ ...typedDataFor(tx), signature });
  const isOwnerSignature = async (tx: FrameTx, signature: Hex) => isAddressEqual(await recoverOwner(tx, signature), cfg.owner);

  return { address, owner: getAddress(cfg.owner), profile, buildTx, prepareTx, typedDataFor, attachSignature, authorizeSession, buildSessionTx, prepareSessionTx, recoverOwner, isOwnerSignature };
}

export type BridgeAccount = ReturnType<typeof bridgeAccount>;

/** Anything with viem's signTypedData: a WalletClient (MetaMask via custom(window.ethereum)) or a LocalAccount. */
export interface TypedDataWallet {
  signTypedData: (args: any) => Promise<Hex>;
}

/**
 * A FrameSigner for a Mode A BridgeAccount tx: asks the wallet for eth_signTypedData_v4 over the FrameTx typed data
 * and stores the r||s||v bytes in the ARBITRARY entry as-is (no v||r||s repack). Marked interactive: the SDK will
 * not ask it to sign estimation probes or simulation copies (one popup per tx).
 * `account` is passed for WalletClients without a hoisted account (e.g. the MetaMask address).
 */
export function typedDataSigner(wallet: TypedDataWallet, bridge: BridgeAccount, account?: Address): Extract<FrameSigner, { signFrame: unknown }> {
  return {
    interactive: true,
    signFrame: async ({ tx, index }) => {
      if ((index ?? 0) !== 0) throw new Error("BridgeAccount Mode A signs entry 0 only");
      const signature = await wallet.signTypedData({ ...(account ? { account } : {}), ...bridge.typedDataFor(tx) });
      return bridge.attachSignature(tx, signature);
    },
  };
}
