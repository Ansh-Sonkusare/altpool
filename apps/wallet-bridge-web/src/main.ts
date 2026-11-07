// Wallet Bridge demo: MetaMask/Rabby approves EIP-8141 frame txs through EIP-712, admitted by the ERC-8421 alt mempool.
//   ?account=0x…  use this BridgeAccount (else the one deployed for the connected owner, else deploy one)
// Talks to ethrex (reads, deploy receipt) and the miner's sidecar (submit, status) directly; both allow any origin.
import "./style.css";
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

const profile = getProfile(DEVNET.profile);
const SIDECAR = DEVNET.minerSidecarUrl;
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000 }) });
const sidecar = createAltMempoolClient({ httpUrl: SIDECAR, profile, name: "miner", timeoutMs: 60_000 });
const sdk = pub.extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));
const explorer = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(SIDECAR)}`;
const store = {
  get: (k: string) => { try { return localStorage.getItem(`wallet-bridge.${k}`) ?? ""; } catch { return ""; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`wallet-bridge.${k}`, v); } catch { /* private mode */ } },
};

const state = {
  wallet: undefined as WalletClient | undefined,
  owner: undefined as Address | undefined,
  bridge: undefined as BridgeAccount | undefined,
  session: undefined as { pk: Hex; session: BridgeSession; ownerSignature: Hex } | undefined,
  busy: false,
};

// ---------------------------------------------------------------------------------------------------- view ------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

$("app").innerHTML = `
  <header>
    <h1>Wallet Bridge</h1>
    <p class="lede">Your browser wallet controls an EIP-8141 account. The wallet signs EIP-712 typed data; the account's own
    VERIFY code checks it with <code>ecrecover</code>. No wallet support for type-0x06 transactions needed.</p>
  </header>

  <section>
    <h2><span class="n">1</span> Wallet</h2>
    <div class="row"><button id="connect">Connect wallet</button><button id="chain" disabled>Add / switch to chain 1337</button></div>
    <p class="warn">MetaMask's built-in "Localhost 8545" network also uses chain id 1337. If it is selected, MetaMask talks to
    your local node instead of the devnet. Remove it or make sure the devnet network (${esc(DEVNET.ethrexUrl)}) is active.
    MetaMask also requires the typed data's chainId to equal the active chain.</p>
    <div id="wallet-out" class="out"></div>
  </section>

  <section>
    <h2><span class="n">2</span> Account</h2>
    <div class="row"><input id="account" placeholder="BridgeAccount address (0x…)" spellcheck="false" /><button id="use" disabled>Use</button><button id="deploy" disabled>Deploy one for me</button></div>
    <div id="account-out" class="out"></div>
  </section>

  <section>
    <h2><span class="n">3</span> Mode A: approve each transaction in the wallet</h2>
    <p>Builds a frame tx sending 1 wei to you, shows the typed data, asks the wallet to sign it, runs the admission
    check, submits it to the alt mempool and follows it on-chain.</p>
    <div class="row"><button id="send" disabled>Send 1 wei</button></div>
    <div id="send-out" class="out"></div>
  </section>

  <section>
    <h2><span class="n">4</span> Mode B: approve a session once, then no popups</h2>
    <p>The wallet signs one <code>Session</code> (a key generated in this tab, a 1-hour limit, at most 1000 wei per tx,
    only to you). That key then signs each frame tx natively. The account checks the session on every tx.</p>
    <div class="row"><button id="authorize" disabled>Authorise session</button><button id="burst" disabled>Send 3 txs</button></div>
    <div id="session-out" class="out"></div>
  </section>

  <footer>Chain ${DEVNET.chainId} · ethrex ${esc(DEVNET.ethrexUrl)} · sidecar ${esc(SIDECAR)} · <a href="${DEVNET.explorerUrl}" target="_blank" rel="noreferrer">explorer</a></footer>
`;

function log(out: string, html: string) {
  const el = document.createElement("div");
  el.className = "line";
  el.innerHTML = html;
  $(out).append(el);
  return el;
}
const clear = (out: string) => { $(out).innerHTML = ""; };
const pre = (s: string, cls = "") => `<pre class="${cls}">${esc(s)}</pre>`;
const link = (hash: Hex) => `<a href="${explorer(hash)}" target="_blank" rel="noreferrer">${hash.slice(0, 18)}…</a>`;

function refresh() {
  const connected = !!state.owner;
  $<HTMLButtonElement>("chain").disabled = !connected;
  $<HTMLButtonElement>("use").disabled = !connected;
  $<HTMLButtonElement>("deploy").disabled = !connected || state.busy;
  $<HTMLButtonElement>("send").disabled = !state.bridge || state.busy;
  $<HTMLButtonElement>("authorize").disabled = !state.bridge || state.busy;
  $<HTMLButtonElement>("burst").disabled = !state.session || state.busy;
}

async function guarded(out: string, fn: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  refresh();
  try { await fn(); } catch (e) {
    const err = e as { shortMessage?: string; message?: string };
    log(out, `<span class="bad">${esc(err.shortMessage ?? err.message ?? String(e))}</span>`);
  } finally { state.busy = false; refresh(); }
}

// ------------------------------------------------------------------------------------------------ actions ------

async function connect() {
  if (!window.ethereum) throw new Error("No injected wallet (window.ethereum). Install MetaMask or Rabby.");
  const wallet = createWalletClient({ chain: altDevnet, transport: custom(window.ethereum) });
  const [owner] = await wallet.requestAddresses();
  state.wallet = wallet;
  state.owner = getAddress(owner!);
  clear("wallet-out");
  log("wallet-out", `Connected <code>${state.owner}</code>`);
  await checkChain();
  const known = bridgeDeployments.accounts[state.owner] ?? (store.get(`account.${state.owner}`) ? { address: store.get(`account.${state.owner}`) as Address } : undefined);
  const fromUrl = new URLSearchParams(location.search).get("account");
  const addr = fromUrl ?? known?.address;
  if (addr) { $<HTMLInputElement>("account").value = addr; await useAccount(); }
}

/** SDK checkWalletNetwork: same chain id AND same head (MetaMask's Localhost 8545 is also 1337). */
async function checkChain(connectFirst = false) {
  const wallet = state.wallet!;
  try {
    const net = connectFirst ? await connectAltDevnet(wallet, { client: pub }) : await checkWalletNetwork(wallet, { client: pub });
    log("wallet-out", `<span class="ok">Wallet is on the devnet</span> (block ${net.devnetBlock})`);
  } catch (e) {
    if (!(e instanceof WrongNetworkError)) throw e;
    log("wallet-out", `<span class="bad">${esc(e.message)}</span>${e.fix ? `<br>${esc(e.fix)}` : ""}${connectFirst ? "" : ' Press "Add / switch to chain 1337".'}`);
  }
}

const addChain = () => checkChain(true);

async function useAccount() {
  const v = $<HTMLInputElement>("account").value.trim();
  if (!isAddress(v)) throw new Error(`Not an address: ${v}`);
  const address = getAddress(v);
  const [code, owner, balance, nonce] = await Promise.all([
    pub.getCode({ address }),
    pub.readContract({ address, abi: bridgeAccountAbi, functionName: "OWNER" }).catch(() => undefined),
    pub.getBalance({ address }),
    pub.getTransactionCount({ address }),
  ]);
  clear("account-out");
  if (!code || !owner) throw new Error(`${address} is not a BridgeAccount on chain ${DEVNET.chainId}`);
  if (getAddress(owner) !== state.owner) throw new Error(`${address} belongs to ${owner}, not to the connected wallet`);
  state.bridge = bridgeAccount({ address, owner: state.owner!, profile });
  state.session = undefined;
  store.set(`account.${state.owner}`, address);
  log("account-out", `BridgeAccount <code>${address}</code><br>owner <code>${owner}</code> · balance <b>${formatEther(balance)} ETH</b> · nonce ${nonce}`);
}

async function deployAccount() {
  const wallet = state.wallet!;
  const owner = state.owner!;
  clear("account-out");
  const need = parseEther("0.1");
  if ((await pub.getBalance({ address: owner })) < need) {
    log("account-out", `Funding ${owner} from the devnet faucet…`);
    await gateway().faucet(owner);
    for (let i = 0; i < 60 && (await pub.getBalance({ address: owner })) < need; i++) await new Promise((r) => setTimeout(r, 2000));
  }
  log("account-out", "Confirm the deploy in your wallet (12M gas: the account creates 7 opcode helpers; 0.05 ETH funds it).");
  const hash = await wallet.deployContract({
    account: owner, chain: altDevnet, abi: bridgeAccountAbi, bytecode: bridgeAccountBytecode, args: [owner],
    value: parseEther("0.05"), gas: BRIDGE_DEPLOY_GAS, gasPrice: await pub.getGasPrice(),
  });
  log("account-out", `Deploy sent <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer">${hash.slice(0, 18)}…</a>, waiting…`);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`Deploy ${hash} reverted`);
  $<HTMLInputElement>("account").value = r.contractAddress;
  await useAccount();
}


/** Admission check (frame-doctor), submit to the alt mempool, follow until included. */
async function admitAndWatch(out: string, tx: FrameTx, label: string) {
  const report = await checkAdmission(tx);
  const rejected = report.verdicts.alt?.verdict === "rejected" || report.verdicts.public?.verdict === "rejected";
  log(out, `<details${rejected ? " open" : ""}><summary>${label}: admission check ${rejected ? '<span class="bad">predicts a rejection</span>' : '<span class="ok">ok</span>'}</summary>${pre(stripAnsi(renderReport(report, { title: "frame-doctor" })))}</details>`);
  if (report.verdicts.alt?.verdict === "rejected") throw new Error("Not submitting: the alt-mempool check predicts a rejection (see frame-doctor above).");
  const sent = await sdk.altpool.submitFrameTransaction({ transaction: tx });
  const line = log(out, `${label}: <span class="ok">admitted</span> ${link(sent.hash)} · <span class="status">pending</span>`);
  const status = line.querySelector(".status")!;
  const timer = setInterval(async () => {
    const s = await sidecar.getTransactionStatus(sent.hash).catch(() => null);
    if (s?.status) status.textContent = s.status;
  }, 2000);
  try {
    const { receipt } = await sdk.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 240_000 });
    status.innerHTML = `<span class="${receipt.status === "success" ? "ok" : "bad"}">${receipt.status}</span> in block ${receipt.blockNumber} · frames ${receipt.frames.map((f) => `${f.index}:${f.status}`).join(" ")} · <a href="${explorer(sent.hash)}" target="_blank" rel="noreferrer">explorer</a>`;
  } finally { clearInterval(timer); }
  return sent.hash;
}

async function sendModeA() {
  const b = state.bridge!;
  clear("send-out");
  // SDK prepareTx: nonce, sidecar fees, call limits (state gas if the owner address is fresh). No signing.
  const { tx, typedData } = await b.prepareTx({ client: pub, sidecar, calls: [{ to: state.owner!, value: 1n }] });
  log("send-out", `<details open><summary>Typed data the wallet signs (every field is re-checked by the account on-chain)</summary>${pre(json(typedData.message))}</details>`);
  log("send-out", "Sign in your wallet…");
  const signed = await signFrameTransaction(profile, tx, typedDataSigner(state.wallet as never, b, state.owner));
  if (!(await b.isOwnerSignature(signed, signed.signatures[0]!.signature))) throw new Error("The wallet's signature does not recover the owner (wrong account or chain in the wallet?)");
  await admitAndWatch("send-out", signed, "Mode A");
}

async function authorizeSession() {
  const b = state.bridge!;
  clear("session-out");
  const pk = generatePrivateKey();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const session: BridgeSession = { key: privateKeyToAccount(pk).address, validUntil: now + 3600n, maxValuePerTx: 1000n, maxCostPerTx: parseEther("0.01"), target: state.owner! };
  const typed = b.authorizeSession(session);
  log("session-out", `<details open><summary>Session the wallet authorises</summary>${pre(json(typed.message))}</details>`);
  const ownerSignature = await state.wallet!.signTypedData({ account: state.owner!, ...typed });
  state.session = { pk, session, ownerSignature };
  log("session-out", `<span class="ok">Session authorised.</span> Key <code>${session.key}</code> lives only in this tab.`);
}

async function burst() {
  const b = state.bridge!;
  const { pk, session, ownerSignature } = state.session!;
  const txs = [];
  for (let i = 0; i < 3; i++) {
    // prepareSessionTx puts each tx on a fresh EIP-8250 nonce key: the sidecar holds one pending tx per
    // (sender, key), so all three fly at once. Deadline: 10 min, capped at the session's validUntil.
    const tx = await b.prepareSessionTx({ client: pub, sidecar, session, ownerSignature, calls: [{ to: state.owner!, value: BigInt(i + 1) }] });
    txs.push(await signFrameTransaction(profile, tx, { privateKey: pk }));
  }
  log("session-out", "Signed 3 txs with the session key (no wallet popups).");
  await Promise.all(txs.map((tx, i) => admitAndWatch("session-out", tx, `Session tx #${i + 1}`)));
}

$("connect").onclick = () => guarded("wallet-out", connect);
$("chain").onclick = () => guarded("wallet-out", addChain);
$("use").onclick = () => guarded("account-out", useAccount);
$("deploy").onclick = () => guarded("account-out", deployAccount);
$("send").onclick = () => guarded("send-out", sendModeA);
$("authorize").onclick = () => guarded("session-out", authorizeSession);
$("burst").onclick = () => guarded("session-out", burst);
window.ethereum?.on?.("chainChanged", () => { if (state.wallet) void guarded("wallet-out", checkChain); });
window.ethereum?.on?.("accountsChanged", () => location.reload());
refresh();
