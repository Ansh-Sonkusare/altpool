// The monitor page (/monitor): an operator console over @altpool/monitor. The URL holds the view, so back and forward move between views.
import { useEffect, useRef, useState } from "react";
import { PAY_RELAY } from "../live";
import { Nav } from "../components/Nav";
import { cx } from "../components/ui";
import { useHeadBlock } from "../hooks";
import { AlertsView } from "./Alerts";
import { Compare } from "./Compare";
import { Entity } from "./Entity";
import { KNOWN, type NodeChoice } from "./fmt";
import type { AlertCfg } from "./hooks";
import { Network } from "./Network";
import { A } from "./parts";
import { navigate, queryFor, useRoute, type Target } from "./route";
import { QuickSwitch } from "./Switcher";
import { Tx } from "./Tx";
import type { Address } from "@altpool/core";

const NODES: NodeChoice[] = ["both", "gateway", "miner"];
const ALL = Object.keys(KNOWN) as Address[];

export const Monitor = () => {
  const head = useHeadBlock();
  const { target, node, fee, feeParam } = useRoute();
  const [alerts, setAlerts] = useState<AlertCfg>({ urls: [], mute: [] });
  // The entity the Entity and Alerts tabs point at: the last one you looked at.
  const lastAddr = useRef<Address>(PAY_RELAY);
  if (target.kind === "entity" || target.kind === "alerts") lastAddr.current = target.addr;
  const addr = lastAddr.current;

  useEffect(() => {
    const names = { entity: KNOWN[addr.toLowerCase()]?.label ?? "Entity", alerts: "Alerts", compare: "Compare", tx: "Transaction", network: "Network" };
    document.title = `${names[target.kind]} · Altpool monitor`;
  }, [target.kind, addr]);

  const views: { id: Target["kind"]; label: string; to: Target }[] = [
    { id: "entity", label: "Entity", to: { kind: "entity", addr } },
    { id: "compare", label: "Compare", to: { kind: "compare", addrs: target.kind === "compare" ? target.addrs : ALL } },
    { id: "tx", label: "Tx", to: target.kind === "tx" ? target : { kind: "tx" } },
    { id: "network", label: "Network", to: { kind: "network" } },
    { id: "alerts", label: "Alerts", to: { kind: "alerts", addr } },
  ];

  return (
    <div className="relative mx-auto min-h-screen max-w-[1360px] overflow-x-clip">
      <div className="pointer-events-none absolute -top-[180px] -right-[160px] h-[420px] w-[700px] max-w-full bg-[radial-gradient(closest-side,rgba(241,201,140,.09),rgba(241,201,140,.02)_55%,transparent)]" aria-hidden="true"></div>
      <Nav head={head} />
      <header className="relative flex flex-col gap-4 px-14 pb-0 pt-10 max-[960px]:px-6 max-[560px]:px-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <h1 className="m-0 text-[22px] font-normal tracking-[-.01em]">Monitor</h1>
          <QuickSwitch target={target} node={node} feeParam={feeParam} />
          <div role="group" aria-label="Which sidecars to read" className="inline-flex overflow-hidden rounded-lg border border-ln2">
            {NODES.map((c) => (
              <button key={c} type="button" aria-pressed={node === c} onClick={() => navigate(queryFor(target, c, feeParam))}
                className={cx("min-h-11 border-r border-ln2 px-3.5 font-mono text-[12.5px] last:border-r-0", node === c ? "bg-amberbg text-amber" : "text-fg2 hover:text-fg")}>{c}</button>
            ))}
          </div>
        </div>
        <nav aria-label="Monitor views" className="-mb-px flex overflow-x-auto border-b border-ln">
          {views.map((v) => (
            <A key={v.id} to={v.to} aria-current={target.kind === v.id ? "page" : undefined}
              className={cx("flex-1 whitespace-nowrap border-b-2 px-4 py-3 text-center font-mono text-[13px] min-[561px]:flex-none min-[561px]:px-5 max-[480px]:px-1",
                target.kind === v.id ? "border-amber text-amber" : "border-transparent text-fg2 hover:text-fg")}>{v.label}</A>
          ))}
        </nav>
      </header>
      <main className="relative px-14 py-10 max-[960px]:px-6 max-[560px]:px-4">
        {target.kind === "entity" && <Entity key={target.addr + node} addr={target.addr} choice={node} fee={fee} alerts={alerts} />}
        {target.kind === "alerts" && <AlertsView key={target.addr + node} addr={target.addr} choice={node} fee={fee} cfg={alerts} setCfg={setAlerts} />}
        {target.kind === "compare" && <Compare addrs={target.addrs} choice={node} fee={fee} />}
        {target.kind === "tx" && <Tx hash={target.hash} choice={node} />}
        {target.kind === "network" && <Network choice={node} />}
      </main>
      <footer className="flex flex-wrap justify-between gap-3 border-t border-ln px-14 py-8 font-mono text-[12px] text-fg2 max-[960px]:px-6 max-[560px]:px-4">
        <span>Devnet only, chain 1337. Read from the sidecars' explorer API and ethrex.</span>
        <a href="/#toolkit" className="text-amber">Back to the toolkit</a>
      </footer>
    </div>
  );
};
