// Alerts and CI conditions. The conditions run here exactly as `watch-entity --once --fail-if` does (failing() from
// @altpool/monitor). Webhooks are POSTed from this view by webhookAlerts(), only while the page is open, and only to
// endpoints that allow cross-origin requests (Discord does, Slack incoming webhooks do not). A server-side watcher is the CLI.
import { useMemo, useState } from "react";
import { CONDITIONS, failing, postAlert, type AlertKind, type Condition, type EntityReport } from "@altpool/monitor";
import type { Address } from "@altpool/core";
import { Card, CardBar, cx } from "../components/ui";
import { ago, clockAt, KNOWN, lc, nodesFor, type NodeChoice } from "./fmt";
import { useEntityLive, useNow, type AlertCfg, type AlertSent } from "./hooks";
import { CopyButton, Heading, Pulse, Tag, TEXT } from "./parts";

const WHAT: Record<Condition, string> = {
  throttled: "Reputation is not ok, or sends left fell to the warn level.",
  banned: "Reputation is banned: the nodes refuse this entity.",
  unstaked: "The entity has no stake, so the nodes do not trust it.",
  unlocking: "A stake withdrawal has started, so the entity is leaving the trusted set.",
  "low-balance": "The balance pays for few txs at the average cost.",
  stuck: "A pending tx is older than the stuck limit.",
  "node-down": "A watched sidecar does not answer.",
  rejections: "A recent admission was rejected.",
};
const KINDS: AlertKind[] = ["throttle", "unlocking", "unstaked", "low-balance", "stuck", "evicted", "rejected"];
const field = "min-h-11 min-w-0 rounded-lg border border-ln2 bg-bg px-3 font-mono text-[12.5px] text-fg placeholder:text-dim";
const btn = "min-h-11 rounded-lg border border-amberln px-4 font-mono text-[12.5px] text-amber disabled:opacity-40";

const Check = ({ checked, onChange, children }: { checked: boolean; onChange: (c: boolean) => void; children: string }) => (
  <label className="flex min-h-9 cursor-pointer items-center gap-2 font-mono text-[12.5px] text-fg1">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[#f1c98c]" />{children}
  </label>
);

export const Alerts = ({ r, cfg, setCfg, sent }: { r: EntityReport; cfg: AlertCfg; setCfg: (c: AlertCfg) => void; sent: AlertSent[] }) => {
  const [conds, setConds] = useState<Condition[]>(CONDITIONS.filter((c) => c !== "rejections"));
  const [warnAt, setWarnAt] = useState(20);
  const [lowAt, setLowAt] = useState(5);
  const [url, setUrl] = useState("");
  const [test, setTest] = useState<string>();
  const opts = { throttleWarnAt: warnAt, lowBalanceAt: lowAt };
  const rows = useMemo(() => CONDITIONS.map((c) => ({ c, hit: failing(r, [c], opts)[0] })), [r, warnAt, lowAt]);
  const bad = rows.filter((x) => x.hit && conds.includes(x.c));
  const urlOk = (() => { try { return /^https?:$/.test(new URL(url.trim()).protocol); } catch { return false; } })();
  const cli = `bunx watch-entity ${lc(r.address)} --once --fail-if ${conds.join(",") || "throttled"} --throttle-warn-at ${warnAt} --low-balance-at ${lowAt}`;
  const cliHook = cfg.urls.length ? ` ${cfg.urls.map((u) => `--alert-webhook ${new URL(u).origin}/…`).join(" ")}${cfg.mute.length ? ` --mute ${cfg.mute.join(",")}` : ""}` : "";

  return (
    <div className="flex flex-col gap-6">
      <Card className={cx("overflow-hidden", bad.length ? "border-bad/40" : "border-okln")}>
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-5">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[12px] text-fg2">Condition result now</span>
            <span className={cx("text-[34px]/[1.1] font-light tracking-[-.02em]", bad.length ? "text-bad" : "text-ok")}>{bad.length ? "FAIL" : "PASS"} <span className="font-mono text-[14px] text-fg2">exit code {bad.length ? 1 : 0}</span></span>
          </div>
          <p className="m-0 max-w-[46ch] text-[14px]/[22px] text-fg1">
            {conds.length === 0 ? "No condition is selected, so the command checks only throttled." : bad.length
              ? `${bad.length} of ${conds.length} selected conditions fail right now: ${bad.map((b) => b.c).join(", ")}. The command in CI would exit 1.`
              : `All ${conds.length} selected conditions pass right now. The command in CI would exit 0.`}
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-6 max-[860px]:grid-cols-1">
        <Card className="overflow-hidden">
          <CardBar><span className="text-fg">Conditions</span><span>tick the ones the CI command checks</span></CardBar>
          <ul className="m-0 list-none p-0">
            {rows.map(({ c, hit }) => {
              const on = conds.includes(c);
              return (
                <li key={c} className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-ln px-4 py-3 last:border-b-0", !on && "opacity-60")}>
                  <input id={`c-${c}`} type="checkbox" checked={on} onChange={(e) => setConds(e.target.checked ? [...conds, c] : conds.filter((x) => x !== c))} className="mt-1 size-4 accent-[#f1c98c]" />
                  <label htmlFor={`c-${c}`} className="min-w-0 cursor-pointer">
                    <span className="block font-mono text-[13px] text-fg">{c}</span>
                    <span className="block text-[13px]/[20px] text-fg2">{hit ? <span className="text-bad">{hit.reason}</span> : WHAT[c]}</span>
                  </label>
                  <Tag tone={hit ? "bad" : "ok"}>{hit ? "fail" : "pass"}</Tag>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-x-6 gap-y-3 border-t border-ln px-4 py-3 font-mono text-[12px] text-fg2">
            <label className="flex items-center gap-2">warn at<input type="number" min={0} value={warnAt} onChange={(e) => setWarnAt(Number(e.target.value))} className={cx(field, "w-20")} />sends left</label>
            <label className="flex items-center gap-2">low at<input type="number" min={0} value={lowAt} onChange={(e) => setLowAt(Number(e.target.value))} className={cx(field, "w-20")} />txs left</label>
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          <Card className="overflow-hidden">
            <CardBar><span className="text-fg">The same check in CI</span><CopyButton text={cli + cliHook} label="Copy command" /></CardBar>
            <div className="p-4">
              <code className="block whitespace-pre-wrap break-all rounded-lg border border-ln bg-bg p-3 font-mono text-[12px] text-fg1">{cli}{cliHook}</code>
              <p className="mb-0 mt-3 text-[12.5px]/[19px] text-fg2">Run it from a checkout of the repo. It exits 1 when a selected condition fails, which fails the CI job.</p>
            </div>
          </Card>

      <Card className="flex flex-col gap-4 p-4"><span className="font-mono text-[12px] text-fg2">Webhook alerts, sent from this view</span>
        <form className="flex gap-2 max-[560px]:flex-col" onSubmit={(e) => { e.preventDefault(); if (urlOk && !cfg.urls.includes(url.trim())) { setCfg({ ...cfg, urls: [...cfg.urls, url.trim()] }); setUrl(""); } }}>
          <label htmlFor="hook" className="sr-only">Webhook URL</label>
          <input id="hook" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" spellCheck={false} className={cx(field, "flex-1")} />
          <button type="submit" disabled={!urlOk} className={btn}>Add webhook</button>
        </form>
        {cfg.urls.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {cfg.urls.map((u) => (
              <li key={u} className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-fg1">
                <span className="min-w-0 flex-1 break-all">{new URL(u).origin}/…</span>
                <button className="min-h-9 rounded-lg border border-ln2 px-3 text-fg1" onClick={async () => {
                  setTest("sending…");
                  await postAlert([u], { kind: "throttle", entity: r.address, label: "test", message: "test alert from the Altpool monitor", at: Date.now() },
                    { onSent: (_a, ok, err) => setTest(ok ? `test sent to ${new URL(u).host}` : `test failed: ${err}. The endpoint may block cross-origin POSTs; the CLI sends from a server.`) });
                }}>Send test</button>
                <button className="min-h-9 rounded-lg border border-ln2 px-3 text-fg1" onClick={() => setCfg({ ...cfg, urls: cfg.urls.filter((x) => x !== u) })}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {test && <p role="status" className="m-0 font-mono text-[12px]/[19px] text-fg2">{test}</p>}
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 p-0 font-mono text-[11.5px] text-fg2">Mute these kinds</legend>
          <div className="grid grid-cols-2 max-[420px]:grid-cols-1">
            {KINDS.map((k) => <Check key={k} checked={cfg.mute.includes(k)} onChange={(on) => setCfg({ ...cfg, mute: on ? [...cfg.mute, k] : cfg.mute.filter((x) => x !== k) })}>{k}</Check>)}
          </div>
        </fieldset>
        <p className="m-0 text-[12.5px]/[19px] text-fg2">
          An alert fires on the same events as the activity signals, one JSON message per event (Discord reads <span className="font-mono">content</span>, Slack and Telegram read <span className="font-mono">text</span>). It only fires while this page is open. Thresholds follow the library defaults: 20 sends left, 5 txs left. URLs stay in memory and are gone on reload. For an always-on watcher, run the CLI with <span className="font-mono">--alert-webhook</span> on a server.
        </p>
        {sent.length > 0 && (
          <ul aria-live="polite" className="m-0 max-h-32 list-none overflow-auto p-0 font-mono text-[12px]/[19px]">
            {sent.map((s) => <li key={s.id}>{clockAt(s.at)} <span className={s.ok ? "text-ok" : "text-bad"}>{s.ok ? "sent" : "failed"}</span> <span className="text-fg2">{s.kind}{s.error ? `: ${s.error}` : ""}</span></li>)}
          </ul>
        )}
      </Card>
        </div>
      </div>
    </div>
  );
};

export const AlertsView = ({ addr, choice, fee, cfg, setCfg }: { addr: Address; choice: NodeChoice; fee?: bigint; cfg: AlertCfg; setCfg: (c: AlertCfg) => void }) => {
  const known = KNOWN[lc(addr)];
  const live = useEntityLive(addr, choice, fee ?? known?.fee, cfg);
  const now = useNow(1000);
  const r = live.report;
  return (
    <div className="flex flex-col gap-6">
      <Heading title={<>Alerts for {known?.label ?? "this entity"}</>} sub={addr}
        aside={<Pulse state={live.error ? "err" : r ? "live" : undefined} word={live.error ? "Poll failed, retrying." : r ? "Live." : "Connecting."}>
          {live.error ?? (r ? `Last change ${ago(now - r.updatedAt)} ago (${clockAt(r.updatedAt)}). Conditions re-run on every update.` : `Reading ${nodesFor(choice).map((n) => n.name).join(" and ")}…`)}
        </Pulse>} />
      {r ? <Alerts r={r} cfg={cfg} setCfg={setCfg} sent={live.sent} />
        : <Card><p className="m-0 p-5 text-[14px]/[22px] text-fg2">{live.error ? <span className="text-bad">{live.error}</span> : "Reading the entity so the conditions have something to check. This takes a few seconds."}</p></Card>}
    </div>
  );
};
