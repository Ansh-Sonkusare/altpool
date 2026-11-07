// The wallet page (/wallet): a browser wallet controls an EIP-8141 account through EIP-712 (packages/wallet-bridge).
// Same flow as apps/wallet-bridge-web, in the site's shell. The SDK work lives in ./bridge.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, Hex, WalletClient } from "viem";
import { DEVNET } from "@altpool/core";
import { Nav } from "../components/Nav";
import { Card, CardBar, cx, Eyebrow, ExtLink, Pill, short } from "../components/ui";
import { useHeadBlock } from "../hooks";
import * as wb from "./bridge";

// ---------------------------------------------------------------------------------------------- log lines ------

type Line = { id: number; node: ReactNode };
interface Log { lines: Line[]; add: (n: ReactNode) => number; set: (id: number, n: ReactNode) => void; clear: () => void }

let nextId = 0;
const useLog = (): Log => {
  const [lines, setLines] = useState<Line[]>([]);
  const add = useCallback((node: ReactNode) => { const id = ++nextId; setLines((l) => [...l, { id, node }]); return id; }, []);
  const set = useCallback((id: number, node: ReactNode) => setLines((l) => l.map((x) => (x.id === id ? { id, node } : x))), []);
  const clear = useCallback(() => setLines([]), []);
  return { lines, add, set, clear };
};

const Ok = ({ children }: { children: ReactNode }) => <span className="text-ok">{children}</span>;
const Bad = ({ children }: { children: ReactNode }) => <span className="text-bad">{children}</span>;
const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-[12.5px] text-fg [overflow-wrap:anywhere]">{children}</code>;
const Pre = ({ children }: { children: string }) => (
  <pre className="ink m-0 mt-2 max-h-[420px] overflow-auto rounded-md bg-ink p-3 font-mono text-[12px]/[18px] text-inkfg">{children}</pre>
);
const Details = ({ open, summary, text }: { open?: boolean; summary: ReactNode; text: string }) => (
  <details open={open} className="[&>summary]:cursor-pointer">
    <summary className="text-fg1">{summary}</summary>
    <Pre>{text}</Pre>
  </details>
);
const TxLink = ({ hash, sidecar = true }: { hash: Hex; sidecar?: boolean }) => (
  <ExtLink href={sidecar ? wb.explorer(hash) : wb.explorerTx(hash)} className="font-mono text-acc underline underline-offset-2 hover:text-fg">{short(hash)}</ExtLink>
);

const Out = ({ log }: { log: Log }) =>
  log.lines.length === 0 ? null : (
    <div className="flex flex-col gap-2 border-t border-ln p-4 text-[14px]/[22px]">
      {log.lines.map((l) => <div key={l.id} className="animate-pop">{l.node}</div>)}
    </div>
  );

// ---------------------------------------------------------------------------------------------- the steps ------

const btn = "min-h-11 rounded-md border px-4 py-2 text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-40";
const Btn = ({ primary, ...p }: { primary?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) => (
  <button type="button" {...p} className={cx(btn, primary ? "border-fg bg-fg text-bg enabled:hover:border-acc enabled:hover:bg-acc" : "border-ln2 text-fg enabled:hover:border-fg")} />
);

const Step = ({ n, title, lead, children, log }: { n: number; title: string; lead?: ReactNode; children: ReactNode; log: Log }) => (
  <Card className="overflow-hidden">
    <CardBar><span><span className="num mr-2 text-acc">{String(n).padStart(2, "0")}</span>{title}</span></CardBar>
    <div className="flex flex-col gap-3 p-4">
      {lead && <p className="m-0 max-w-[68ch] text-[14px]/[22px] text-fg1">{lead}</p>}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
    <Out log={log} />
  </Card>
);

export const Wallet = () => {
  const head = useHeadBlock();
  const [wallet, setWallet] = useState<WalletClient>();
  const [owner, setOwner] = useState<Address>();
  const [bridge, setBridge] = useState<wb.BridgeAccount>();
  const [session, setSession] = useState<wb.Session>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const logs = { wallet: useLog(), account: useLog(), send: useLog(), session: useLog() };

  useEffect(() => { document.title = "Wallet Bridge · Altpool"; }, []);

  /** One action at a time; any error lands in that step's log. */
  const guarded = (log: Log, fn: () => Promise<void>) => async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await fn(); } catch (e) { log.add(<Bad>{wb.errorText(e)}</Bad>); } finally { busyRef.current = false; setBusy(false); }
  };

  const showNetwork = async (w: WalletClient, add = false) => {
    const net = await wb.checkNetwork(w, add);
    logs.wallet.add(net.ok
      ? <><Ok>Wallet is on the devnet</Ok> (block {net.block.toString()})</>
      : <><Bad>{net.message}</Bad>{net.fix && <><br />{net.fix}</>}{!add && " Press “Add / switch to chain 1337”."}</>);
  };

  const openAccount = async (addr: string, o: Address) => {
    logs.account.clear();
    const a = await wb.loadAccount(addr, o);
    setBridge(a.bridge); setSession(undefined); setInput(a.address);
    logs.account.add(<>BridgeAccount <Code>{a.address}</Code><br />owner <Code>{o}</Code> · balance <b>{a.balance} ETH</b> · nonce {a.nonce}</>);
  };

  const connect = async () => {
    const { wallet: w, owner: o } = await wb.connectWallet();
    setWallet(w); setOwner(o);
    logs.wallet.clear();
    logs.wallet.add(<>Connected <Code>{o}</Code></>);
    await showNetwork(w);
    const known = wb.knownAccount(o);
    if (known) await openAccount(known, o);
  };

  const deploy = async () => {
    logs.account.clear();
    const addr = await wb.deployAccount(wallet!, owner!, (s) => logs.account.add(<>{s.text}{s.hash && <> <TxLink hash={s.hash} sidecar={false} /></>}</>));
    await openAccount(addr, owner!);
  };

  /** frame-doctor, then submit to the alt mempool, then follow the tx until it is included. */
  const admitAndWatch = async (log: Log, tx: wb.FrameTx, label: string) => {
    const check = await wb.admissionCheck(tx);
    log.add(<Details open={check.rejected} text={check.text}
      summary={<>{label}: admission check {check.rejected ? <Bad>predicts a rejection</Bad> : <Ok>ok</Ok>}</>} />);
    if (check.altRejected) throw new Error("Not submitting: the alt-mempool check predicts a rejection (see frame-doctor above).");
    const hash = await wb.submit(tx);
    const line = (status: ReactNode) => <>{label}: <Ok>admitted</Ok> <TxLink hash={hash} /> · {status}</>;
    const id = log.add(line(<span className="text-fg2">pending</span>));
    const r = await wb.follow(hash, (s) => log.set(id, line(<span className="text-fg2">{s}</span>)));
    log.set(id, line(<>{r.status === "success" ? <Ok>{r.status}</Ok> : <Bad>{r.status}</Bad>}{r.block !== undefined && <> in block {r.block.toString()}</>} ·frames {r.frames}</>));
  };

  const sendModeA = async () => {
    logs.send.clear();
    const { tx, typedData } = await wb.prepareModeA(bridge!, owner!);
    logs.send.add(<Details open summary="Typed data the wallet signs (every field is re-checked by the account on-chain)" text={wb.json(typedData.message)} />);
    logs.send.add("Sign in your wallet…");
    const signed = await wb.signModeA(wallet!, bridge!, owner!, tx);
    await admitAndWatch(logs.send, signed, "Mode A");
  };

  const authorize = async () => {
    logs.session.clear();
    const { pk, session: s, typed } = wb.newSession(bridge!, owner!);
    logs.session.add(<Details open summary="Session the wallet authorises" text={wb.json(typed.message)} />);
    const ownerSignature = await wb.signSession(wallet!, owner!, typed);
    setSession({ pk, session: s, ownerSignature });
    logs.session.add(<><Ok>Session authorised.</Ok> Key <Code>{s.key}</Code> lives only in this tab.</>);
  };

  const burst = async () => {
    const txs = await wb.sessionBurst(bridge!, owner!, session!);
    logs.session.add("Signed 3 txs with the session key (no wallet popups).");
    await Promise.all(txs.map((tx, i) => admitAndWatch(logs.session, tx, `Session tx #${i + 1}`)));
  };

  const exportIt = async () => {
    const name = wb.exportSession(bridge!, session!);
    const s = session!.session;
    logs.session.add(<>Exported. Give it to the MCP server: <Code>ALTPOOL_SESSION=/path/to/{name}</Code>. The file holds the session key: it can spend at most {s.maxValuePerTx.toString()} wei per tx, only to <Code>{s.target}</Code>, until {new Date(Number(s.validUntil) * 1000).toLocaleTimeString()}.</>);
  };

  // The wallet's own events: re-check the network on a chain switch, start over on an account switch.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onChain = () => { if (wallet) void guarded(logs.wallet, () => showNetwork(wallet))(); };
    const onAccounts = () => location.reload();
    eth.on("chainChanged", onChain);
    eth.on("accountsChanged", onAccounts);
    return () => { eth.removeListener?.("chainChanged", onChain); eth.removeListener?.("accountsChanged", onAccounts); };
  }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  const pad = "px-[clamp(20px,5vw,72px)]";
  return (
    <div className="min-h-screen">
      <Nav head={head} />
      <header className={cx("mx-auto flex max-w-[1200px] flex-col gap-3 pt-12 pb-6", pad)}>
        <Eyebrow tone="acc">packages/wallet-bridge</Eyebrow>
        <h1 className="m-0 max-w-[24ch] text-balance text-[clamp(32px,4.5vw,48px)]/[1.08] font-medium tracking-[-.03em]">
          Your browser wallet, sending frame transactions.
        </h1>
        <p className="m-0 max-w-[68ch] text-[16px]/[26px] text-fg1">
          No wallet can sign a type-0x06 frame transaction, but every wallet signs EIP-712 typed data. A BridgeAccount's VERIFY frame
          recovers that signature with <Code>ecrecover</Code> and approves: the account's own code decides what is valid. The SDK runs in
          this tab, checks each transaction with frame-doctor, and sends it to the alt mempool.
        </p>
        <div className="flex flex-wrap gap-2" role="status" aria-live="polite">
          <Pill kind={owner ? "v" : "u"}>{owner ? "Wallet connected" : "Wallet not connected"}</Pill>
          <Pill kind={bridge ? "v" : "u"}>{bridge ? "Account chosen" : "No account chosen"}</Pill>
          <Pill kind={session ? "v" : "u"}>{session ? "Session active" : "No session"}</Pill>
        </div>
      </header>
      <main className={cx("mx-auto flex max-w-[1200px] flex-col gap-3 pb-[72px]", pad)}>
        <Step n={1} title="Wallet" log={logs.wallet}>
          <details className="basis-full text-[14px]/[22px] text-fg2 [&>summary]:min-h-11 [&>summary]:cursor-pointer [&>summary]:py-2.5">
            <summary>Using MetaMask? Check for the “Localhost 8545” network.</summary>
            <p className="m-0 max-w-[68ch] pb-2">
              MetaMask's built-in “Localhost 8545” network also uses chain id 1337. If it is selected, MetaMask talks to your local node
              instead of the devnet. Remove it, or make sure the devnet network (<Code>{DEVNET.ethrexUrl}</Code>) is active.
            </p>
          </details>
          <Btn primary onClick={guarded(logs.wallet, connect)} disabled={busy}>{owner ? "Reconnect" : "Connect wallet"}</Btn>
          <Btn onClick={guarded(logs.wallet, () => showNetwork(wallet!, true))} disabled={!wallet || busy}>Add / switch to chain 1337</Btn>
        </Step>

        <Step n={2} title="Account" log={logs.account} lead="Use a BridgeAccount you own, or deploy one. The page funds your wallet from the devnet faucet first if it needs gas.">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="BridgeAccount address (0x…)" spellCheck={false} aria-label="BridgeAccount address"
            className="min-h-11 min-w-0 flex-[1_1_320px] rounded-md border border-ln2 bg-s1 px-3 font-mono text-[13px] text-fg placeholder:text-fg2" />
          <Btn onClick={guarded(logs.account, () => openAccount(input, owner!))} disabled={!owner || busy}>Use</Btn>
          <Btn onClick={guarded(logs.account, deploy)} disabled={!owner || busy}>Deploy one for me</Btn>
        </Step>

        <Step n={3} title="Mode A · approve each transaction in the wallet" log={logs.send}
          lead="Builds a frame tx sending 1 wei to you, shows the typed data, asks the wallet to sign it, runs the admission check, submits it to the alt mempool and follows it on chain.">
          <Btn primary onClick={guarded(logs.send, sendModeA)} disabled={!bridge || busy}>Send 1 wei</Btn>
        </Step>

        <Step n={4} title="Mode B · approve a session once, then no popups" log={logs.session} lead={<>
          The wallet signs one <Code>Session</Code>: a key generated in this tab, a 1-hour limit, at most 1000 wei per tx, only to you.
          That key then signs each frame tx natively, and the account checks the session on every tx. Export hands the session to an AI
          agent through the MCP server.
        </>}>
          <Btn primary onClick={guarded(logs.session, authorize)} disabled={!bridge || busy}>Authorise session</Btn>
          <Btn onClick={guarded(logs.session, burst)} disabled={!session || busy}>Send 3 txs</Btn>
          <Btn onClick={guarded(logs.session, exportIt)} disabled={!session || busy}>Export for an agent</Btn>
        </Step>
      </main>
      <footer className={cx("mx-auto flex max-w-[1200px] flex-wrap justify-between gap-3 border-t border-ln2 py-8 font-mono text-[12px] text-fg2", pad)}>
        <span>Chain {DEVNET.chainId} · ethrex {DEVNET.ethrexUrl.replace(/^https?:\/\//, "")} · sidecar {wb.SIDECAR.replace(/^https?:\/\//, "")}</span>
        <a href="/#install" className="text-acc">Use the SDK yourself</a>
      </footer>
    </div>
  );
};
