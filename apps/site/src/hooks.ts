import { useCallback, useEffect, useRef, useState } from "react";
import { watchEntity, type EntityReport } from "@altpool/monitor";
import type { Address, Hex } from "viem";
import { client, minerGateway } from "./altpool";
import type { DoctorJob, DoctorView, Live, PresetId } from "./live";

const POLL_MS = 5000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const snapshotOf = <T>(s: Live<T>): T | undefined => (s.status === "live" ? s.value : s.status === "error" ? s.snapshot : undefined);

export const useReducedMotion = () => {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
};

export const useHeadBlock = (): Live<number> => {
  const [state, setState] = useState<Live<number>>({ status: "loading" });
  useEffect(() => {
    // Chained, not setInterval: a slow answer never stacks a second call on top of the first.
    let alive = true;
    let id: ReturnType<typeof setTimeout> | undefined;
    const tick = () =>
      client.getBlockNumber({ cacheTime: 0 }).then(
        (b) => alive && setState({ status: "live", value: Number(b), at: new Date() }),
        (e) => alive && setState((s) => ({ status: "error", error: message(e), snapshot: snapshotOf(s) })),
      ).finally(() => { if (alive) id = setTimeout(tick, 4000); });
    void tick();
    return () => { alive = false; clearTimeout(id); };
  }, []);
  return state;
};


/** firstSeen: inclusion hashes in the first poll; anything else landed while the page was open. */
export const useEntity = (address: Address): { state: Live<EntityReport>; firstSeen: ReadonlySet<Hex> } => {
  const [state, setState] = useState<Live<EntityReport>>({ status: "loading" });
  const [firstSeen, setFirstSeen] = useState<ReadonlySet<Hex>>(new Set());
  const seeded = useRef(false);
  useEffect(() => {
    seeded.current = false;
    let stop = () => {};
    // Deferred a tick so StrictMode's throwaway mount never starts a watcher.
    const boot = setTimeout(() => {
      stop = watchEntity(address, {
        gateway: minerGateway,
        intervalMs: POLL_MS,
        onStatus: (s) => {
          if (!seeded.current) {
            seeded.current = true;
            setFirstSeen(new Set(s.inclusions.map((i) => i.hash)));
          }
          setState({ status: "live", value: s, at: new Date() });
        },
        onError: (e) => setState((s) => ({ status: "error", error: message(e), snapshot: snapshotOf(s) })),
      });
    }, 0);
    return () => { clearTimeout(boot); stop(); };
  }, [address]);
  return { state, firstSeen };
};

export type DoctorRun = { title: string; preset?: PresetId } & (
  | { status: "running" }
  | { status: "done"; text: string; ok: boolean; ms: number; view: DoctorView }
  | { status: "error"; error: string; ms: number }
  /** A usage error from the input box: nothing ran. */
  | { status: "invalid"; error: string }
);

/** Starts "running" until the Doctor section picks its first run. A newer run supersedes an older one still in flight. */
export const useDoctor = (): { current: DoctorRun; run(job: DoctorJob): void; invalid(error: string): void } => {
  const [current, setCurrent] = useState<DoctorRun>({ title: "frame-doctor", status: "running" });
  const seq = useRef(0);
  const run = useCallback((job: DoctorJob) => {
    const id = ++seq.current;
    const base = { title: job.title, preset: job.preset };
    setCurrent({ ...base, status: "running" });
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    job.run().then(
      (r) => id === seq.current && setCurrent({ ...base, status: "done", text: r.text, ok: r.ok, ms: r.ms ?? ms(), view: r.view }),
      (e) => id === seq.current && setCurrent({ ...base, status: "error", error: message(e), ms: ms() }),
    );
  }, []);
  const invalid = useCallback((error: string) => {
    seq.current++;
    setCurrent({ title: "Input", status: "invalid", error });
  }, []);
  return { current, run, invalid };
};
