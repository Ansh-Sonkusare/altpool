// Wallet Bridge, ported from apps/wallet-bridge-web: MetaMask/Rabby approves EIP-8141 frame txs through EIP-712, and the
// ERC-8421 alt mempool admits them. Talks to ethrex (reads, deploy receipt) and the miner's sidecar (submit, status)
// directly; both allow any origin. No DOM here: Wallet.tsx decides how to show each step.
import {
  createPublicClient, createWalletClient, custom, formatEther, getAddress, http, isAddress, parseEther,
  type Address, type EIP1193Provider, type Hex, type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, explorerTx, gateway } from "@altpool/core";
import { checkAdmission, renderReport } from "@altpool/simulator";
import { BRIDGE_DEPLOY_GAS, bridgeAccountAbi, bridgeAccountBytecode, bridgeDeployments } from "@altpool/wallet-bridge";
import {
  WrongNetworkError, altpoolActions, bridgeAccount, checkWalletNetwork, connectAltDevnet, createAltMempoolClient,
  signFrameTransaction, typedDataSigner, type BridgeAccount, type BridgeSession, type FrameTx,
} from "altpool";

declare global { interface Window { ethereum?: EIP1193Provider } }

export type { BridgeAccount, BridgeSession, FrameTx };
export const profile = getProfile(DEVNET.profile);
export const SIDECAR = DEVNET.minerSidecarUrl;
// 60 s timeouts: a slow devnet is common, and a wallet flow is cheap to wait for.
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000 }) });
const sidecar = createAltMempoolClient({ httpUrl: SIDECAR, profile, name: "miner", timeoutMs: 60_000 });
const sdk = pub.extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));

/** The explorer defaults to the gateway, which does not see txs sent to the miner's sidecar. */
export const explorer = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(SIDECAR)}`;
export { explorerTx };

const store = {
  get: (k: string) => { try { return localStorage.getItem(`wallet-bridge.${k}`) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`wallet-bridge.${k}`, v); } catch { /* private mode */ } },
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex
export const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
export const errorText = (e: unknown) => {
  const err = e as { shortMessage?: string; message?: string };
  return err.shortMessage ?? err.message ?? String(e);
};

// ------------------------------------------------------------------------------------------------- wallet ------

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet (window.ethereum). Install MetaMask or Rabby.");
  const wallet = createWalletClient({ chain: altDevnet, transport: custom(window.ethereum) });
  const [owner] = await wallet.requestAddresses();
  return { wallet, owner: getAddress(owner!) };
}

export type NetworkCheck = { ok: true; block: bigint } | { ok: false; message: string; fix?: string };

/** SDK checkWalletNetwork: same chain id AND same head (MetaMask's Localhost 8545 is also 1337). add = switch first. */
export async function checkNetwork(wallet: WalletClient, add = false): Promise<NetworkCheck> {
  try {
    const net = add ? await connectAltDevnet(wallet, { client: pub }) : await checkWalletNetwork(wallet, { client: pub });
    return { ok: true, block: net.devnetBlock };
  } catch (e) {
    if (!(e instanceof WrongNetworkError)) throw e;
    return { ok: false, message: e.message, fix: e.fix };
  }
}

/** ?account= first, then the account deployed for this owner (committed or remembered in this browser). */
export const knownAccount = (owner: Address): string | undefined =>
  new URLSearchParams(location.search).get("account")
  ?? bridgeDeployments.accounts[owner]?.address
  ?? (store.get(`account.${owner}`) || undefined);

// ------------------------------------------------------------------------------------------------ account ------

export async function loadAccount(input: string, owner: Address) {
  const v = input.trim();
  if (!isAddress(v)) throw new Error(`Not an address: ${v}`);
  const address = getAddress(v);
  const [code, onChainOwner, balance, nonce] = await Promise.all([
    pub.getCode({ address }),
    pub.readContract({ address, abi: bridgeAccountAbi, functionName: "OWNER" }).catch(() => undefined),
    pub.getBalance({ address }),
    pub.getTransactionCount({ address }),
  ]);
  if (!code || !onChainOwner) throw new Error(`${address} is not a BridgeAccount on chain ${DEVNET.chainId}`);
  if (getAddress(onChainOwner) !== owner) throw new Error(`${address} belongs to ${onChainOwner}, not to the connected wallet`);
  store.set(`account.${owner}`, address);
  return { bridge: bridgeAccount({ address, owner, profile }), address, balance: formatEther(balance), nonce };
}

/** Faucet the owner if needed, then the owner deploys a BridgeAccount from the wallet. */
export async function deployAccount(wallet: WalletClient, owner: Address, step: (s: { text: string; hash?: Hex }) => void) {
  const need = parseEther("0.1");
  if ((await pub.getBalance({ address: owner })) < need) {
    step({ text: `Funding ${owner} from the devnet faucet…` });
    await gateway().faucet(owner);
    for (let i = 0; i < 60 && (await pub.getBalance({ address: owner })) < need; i++) await new Promise((r) => setTimeout(r, 2000));
  }
  step({ text: "Confirm the deploy in your wallet (12M gas: the account creates 7 opcode helpers; 0.05 ETH funds it)." });
  const hash = await wallet.deployContract({
    account: owner, chain: altDevnet, abi: bridgeAccountAbi, bytecode: bridgeAccountBytecode, args: [owner],
    value: parseEther("0.05"), gas: BRIDGE_DEPLOY_GAS, gasPrice: await pub.getGasPrice(),
  });
  step({ text: "Deploy sent, waiting…", hash });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`Deploy ${hash} reverted`);
  return r.contractAddress;
}

// ------------------------------------------------------------------------------------------- admit + send ------

/** frame-doctor before the send. Both verdicts, and the report as plain text. */
export async function admissionCheck(tx: FrameTx) {
  const report = await checkAdmission(tx);
  return {
    altRejected: report.verdicts.alt?.verdict === "rejected",
    rejected: report.verdicts.alt?.verdict === "rejected" || report.verdicts.public?.verdict === "rejected",
    text: stripAnsi(renderReport(report, { title: "frame-doctor" })),
  };
}

export const submit = async (tx: FrameTx) => (await sdk.altpool.submitFrameTransaction({ transaction: tx })).hash;

/** Polls the sidecar's status until the receipt lands. */
export async function follow(hash: Hex, onStatus: (s: string) => void) {
  const timer = setInterval(async () => {
    const s = await sidecar.getTransactionStatus(hash).catch(() => null);
    if (s?.status) onStatus(s.status);
  }, 2000);
  try {
    const { receipt } = await sdk.altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 240_000 });
    return { status: receipt.status, block: receipt.blockNumber, frames: receipt.frames.map((f) => `${f.index}:${f.status}`).join(" ") };
  } finally { clearInterval(timer); }
}

// ------------------------------------------------------------------------------------------------- Mode A ------

/** SDK prepareTx: nonce, sidecar fees, call limits (state gas if the owner address is fresh). No signing. */
export const prepareModeA = (b: BridgeAccount, owner: Address) => b.prepareTx({ client: pub, sidecar, calls: [{ to: owner, value: 1n }] });

export async function signModeA(wallet: WalletClient, b: BridgeAccount, owner: Address, tx: FrameTx) {
  const signed = await signFrameTransaction(profile, tx, typedDataSigner(wallet as never, b, owner));
  if (!(await b.isOwnerSignature(signed, signed.signatures[0]!.signature))) throw new Error("The wallet's signature does not recover the owner (wrong account or chain in the wallet?)");
  return signed;
}

// ------------------------------------------------------------------------------------------------- Mode B ------

export interface Session { pk: Hex; session: BridgeSession; ownerSignature: Hex }

/** A key generated in this tab, 1 hour, at most 1000 wei per tx, only to the owner. The wallet signs it once. */
export function newSession(b: BridgeAccount, owner: Address) {
  const pk = generatePrivateKey();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const session: BridgeSession = { key: privateKeyToAccount(pk).address, validUntil: now + 3600n, maxValuePerTx: 1000n, maxCostPerTx: parseEther("0.01"), target: owner };
  return { pk, session, typed: b.authorizeSession(session) };
}

export const signSession = (wallet: WalletClient, owner: Address, typed: ReturnType<BridgeAccount["authorizeSession"]>) =>
  wallet.signTypedData({ account: owner, ...typed });

/** Three txs, each on a fresh EIP-8250 nonce key: the sidecar holds one pending tx per (sender, key), so all three
 * fly at once. Deadline: 10 min, capped at the session's validUntil. No wallet popups. */
export async function sessionBurst(b: BridgeAccount, owner: Address, s: Session) {
  const txs: FrameTx[] = [];
  for (let i = 0; i < 3; i++) {
    const tx = await b.prepareSessionTx({ client: pub, sidecar, session: s.session, ownerSignature: s.ownerSignature, calls: [{ to: owner, value: BigInt(i + 1) }] });
    txs.push(await signFrameTransaction(profile, tx, { privateKey: s.pk }));
  }
  return txs;
}

/** Download the session for packages/mcp (ALTPOOL_SESSION=<file>). It holds the session's private key: anyone with
 * the file can spend within the session's on-chain limits (target, value and fee per tx) until validUntil. */
export function exportSession(b: BridgeAccount, s: Session) {
  const { pk, session, ownerSignature } = s;
  const file = {
    kind: "altpool-bridge-session", chainId: DEVNET.chainId, account: b.address, owner: b.owner,
    session: { key: session.key, validUntil: String(session.validUntil), maxValuePerTx: String(session.maxValuePerTx), maxCostPerTx: String(session.maxCostPerTx), target: session.target },
    ownerSignature, sessionPrivateKey: pk,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const name = `altpool-session-${b.address.slice(2, 8)}.json`;
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
  return name;
}
