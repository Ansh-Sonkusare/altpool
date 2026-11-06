// Owner: Dev C. One entity, live: stake, reputation + headroom, pending, inclusions with VERIFY gas, evictions.
// Open with ?entity=0x… (or type it in). Talks to the gateway directly (it allows any origin).
import { DEVNET, explorerTx, type Address, type EntityStatus } from "@altpool/core";
import { watchEntity } from "@altpool/monitor";

const app = document.querySelector<HTMLElement>("#app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4)} ETH`;
const n = (x: number | bigint) => x.toLocaleString("en-US");
const link = (h: string) => `<a class="mono" href="${esc(explorerTx(h))}" target="_blank" rel="noreferrer">${esc(short(h))}</a>`;
const isAddress = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);

const store = {
  get: () => { try { return localStorage.getItem("altpool.entity") ?? ""; } catch { return ""; } },
  set: (v: string) => { try { localStorage.setItem("altpool.entity", v); } catch { /* private mode */ } },
};

const initial = new URLSearchParams(location.search).get("entity") ?? store.get();

app.innerHTML = `
  <header>
    <h1>Altpool monitor<small>chain ${DEVNET.chainId}</small></h1>
    <form id="f"><input id="addr" placeholder="entity address 0x…" spellcheck="false" autocomplete="off" value="${esc(initial)}" /><button>Watch</button></form>
  </header>
  <div class="status-line"><span class="dot" id="dot"></span><span id="line">Enter a sender or paymaster address.</span></div>
  <section id="view"></section>`;

const dot = document.querySelector<HTMLElement>("#dot")!;
const line = document.querySelector<HTMLElement>("#line")!;
const view = document.querySelector<HTMLElement>("#view")!;

const render = (s: EntityStatus) => {
  const r = s.reputation;
  const h = s.headroom;
  const throttleAt = (r.opsIncluded + DEVNET.reputation.throttlingSlack + 1) * DEVNET.reputation.minInclusionDenominator;
  const used = Math.min(100, Math.round((r.opsSeen / throttleAt) * 100));
  const level = r.status !== "ok" ? "bad" : h.untilThrottled <= 20 ? "warn" : "ok";
  const repClass = r.status === "ok" ? "ok" : r.status === "throttled" ? "warn" : "bad";

  view.innerHTML = `
    <div class="grid">
      <div class="card">
        <h2>Stake</h2>
        <div class="big ${s.stake.isStaked ? "ok" : "bad"}">${s.stake.isStaked ? "Staked" : "Unstaked"}</div>
        <div>${eth(s.stake.amount)} · delay ${n(s.stake.unstakeDelaySec)} s</div>
        ${s.stake.withdrawTime ? `<div class="note warn">Unlocking: not staked for the alt mempool any more.</div>` : ""}
        ${!s.stake.isStaked ? `<div class="note">Needs &gt; ${eth(DEVNET.minStakeWei)} and a ${n(DEVNET.unstakeDelaySec)} s delay to read foreign storage on the alt mempool.</div>` : ""}
      </div>
      <div class="card">
        <h2>Reputation</h2>
        <div class="big"><span class="pill ${repClass}">${esc(r.status)}</span></div>
        <div>seen ${n(r.opsSeen)} · included ${n(r.opsIncluded)}</div>
        ${r.isWhitelisted ? `<div class="note">Whitelisted by the node.</div>` : ""}
        ${r.isBlacklisted ? `<div class="note bad">Blacklisted by the node.</div>` : ""}
      </div>
      <div class="card">
        <h2>Headroom</h2>
        <div class="big ${level}">${n(h.untilThrottled)} <span class="muted" style="font-size:13px;font-weight:400">sends until throttled</span></div>
        <div class="bar"><span class="${level === "ok" ? "" : level}" style="width:${used}%"></span></div>
        <div class="muted">${n(h.untilBanned)} until banned · throttles at ${n(throttleAt)} seen</div>
        ${level === "warn" ? `<div class="note warn">Close to throttling: spread sends across accounts or wait for inclusions.</div>` : ""}
      </div>
    </div>
    <div class="grid" style="grid-template-columns: 1fr">
      <div class="card">
        <h2>Pending (${s.pending.length})</h2>
        ${s.pending.length ? `<div class="scroll"><table><tr><th>tx</th><th>status</th><th>as</th></tr>${s.pending.map((p) => `<tr><td>${link(p.hash)}</td><td>${esc(p.status)}</td><td>${esc(p.role)}</td></tr>`).join("")}</table></div>` : `<div class="empty">Nothing pending.</div>`}
      </div>
      <div class="card">
        <h2>Inclusions (latest ${s.inclusions.length})</h2>
        ${s.inclusions.length ? `<div class="scroll"><table><tr><th>tx</th><th class="num">block</th><th class="num">VERIFY gas</th></tr>${s.inclusions.map((i) => `<tr><td>${link(i.hash)}</td><td class="num">${n(i.block)}</td><td class="num">${i.verifyGas === undefined ? `<span class="muted">n/a</span>` : `${n(i.verifyGas)}${i.verifyGas > DEVNET.publicVerifyGasCap ? ` <span class="pill warn">over public cap</span>` : ""}`}</td></tr>`).join("")}</table></div>` : `<div class="empty">No inclusions in the explorer's recent history.</div>`}
      </div>
      <div class="card">
        <h2>Evictions (${s.evictions.length})</h2>
        ${s.evictions.length ? `<div class="scroll"><table><tr><th>tx</th><th>kind</th><th>reason</th></tr>${s.evictions.map((e) => `<tr><td>${link(e.hash)}</td><td class="bad">${esc(e.kind)}</td><td>${esc(e.reason ?? "")}</td></tr>`).join("")}</table></div>` : `<div class="empty">None.</div>`}
      </div>
    </div>`;
};

let stop: (() => void) | undefined;

const watch = (addr: Address) => {
  stop?.();
  store.set(addr);
  history.replaceState(null, "", `?entity=${addr}`);
  dot.className = "dot";
  line.textContent = `Loading ${addr}…`;
  view.innerHTML = "";
  stop = watchEntity(addr, {
    onStatus: (s) => {
      dot.className = "dot live";
      line.textContent = `${addr} · updated ${new Date().toLocaleTimeString()} · polling every 3 s`;
      render(s);
    },
    onError: (e) => {
      dot.className = "dot err";
      line.textContent = `Poll failed: ${(e as Error)?.message ?? String(e)}. Retrying.`;
    },
  });
};

document.querySelector<HTMLFormElement>("#f")!.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const v = document.querySelector<HTMLInputElement>("#addr")!.value.trim();
  if (isAddress(v)) watch(v);
  else { dot.className = "dot err"; line.textContent = "That is not a 20-byte 0x address."; }
});

if (isAddress(initial)) watch(initial);
