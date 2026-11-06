// The monitor's URL is its state, like apps/monitor-web: ?entity=a  ?entity=a,b  ?tx=0x…  ?view=network  &node=  &fee=
import { useMemo, useSyncExternalStore } from "react";
import { parseEther } from "viem";
import type { Address, Hex } from "@altpool/core";
import { PAY_RELAY } from "../live";
import { isAddress, isHash, type NodeChoice } from "./fmt";

export type Target =
  | { kind: "entity"; addr: Address }
  | { kind: "compare"; addrs: Address[] }
  | { kind: "tx"; hash?: Hex }
  | { kind: "alerts"; addr: Address }
  | { kind: "network" };

const NAV = "monitor:nav";
const subscribe = (cb: () => void) => {
  addEventListener("popstate", cb);
  addEventListener(NAV, cb);
  return () => { removeEventListener("popstate", cb); removeEventListener(NAV, cb); };
};

export const navigate = (query: string, replace = false) => {
  const q = query.replace(/^\?/, "");
  history[replace ? "replaceState" : "pushState"](null, "", location.pathname + (q ? `?${q}` : ""));
  dispatchEvent(new Event(NAV));
};

export const queryFor = (t: Target, node: NodeChoice, fee: string | null) => {
  const q = new URLSearchParams();
  if (t.kind === "entity") q.set("entity", t.addr);
  if (t.kind === "compare") q.set("entity", t.addrs.join(","));
  if (t.kind === "tx") t.hash ? q.set("tx", t.hash) : q.set("view", "tx");
  if (t.kind === "alerts") { q.set("view", "alerts"); q.set("entity", t.addr); }
  if (t.kind === "network") q.set("view", "network");
  if (node !== "both") q.set("node", node);
  if (fee) q.set("fee", fee);
  return q.toString();
};

export const parseTarget = (p: URLSearchParams): Target => {
  const view = p.get("view");
  if (view === "network") return { kind: "network" };
  const tx = p.get("tx") ?? "";
  const addrs = [...new Set((p.get("entity") ?? "").split(",").map((s) => s.trim()).filter(isAddress))] as Address[];
  if (view === "alerts") return { kind: "alerts", addr: addrs[0] ?? PAY_RELAY };
  if (isHash(tx)) return { kind: "tx", hash: tx };
  if (view === "tx") return { kind: "tx" };
  if (addrs.length > 1) return { kind: "compare", addrs: addrs.slice(0, 6) };
  if (addrs.length === 1) return { kind: "entity", addr: addrs[0]! };
  return { kind: "entity", addr: PAY_RELAY };
};

export const useRoute = () => {
  const search = useSyncExternalStore(subscribe, () => location.search);
  return useMemo(() => {
    const p = new URLSearchParams(search);
    const n = p.get("node");
    const node: NodeChoice = n === "gateway" || n === "miner" ? n : "both";
    let fee: bigint | undefined;
    try { fee = p.get("fee") ? parseEther(p.get("fee")!) : undefined; } catch { /* bad fee in the URL: ignore it */ }
    return { target: parseTarget(p), node, fee, feeParam: p.get("fee"), isDefault: !p.has("entity") && !p.has("tx") && !p.has("view") };
  }, [search]);
};
