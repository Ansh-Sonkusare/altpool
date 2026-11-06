// JSON-RPC transports. HTTP for calls, WebSocket for skandha_subscribe. Nothing here retries a call: a signed
// submission must never be resent blindly, so retry policy belongs to the caller.
import { decodeRpcError, SubscriptionError, TransportError, type EndpointKind } from "./errors";

export interface RpcTraceEntry { url: string; method: string; params: unknown[]; response?: unknown; error?: unknown; ms: number }

export interface RpcRequester {
  readonly url: string;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export interface HttpRpcOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Which mempool's node this is; picks how error text is classified. */
  kind?: EndpointKind;
  /** Called with every request and the raw reply, for debugging. */
  trace?: (e: RpcTraceEntry) => void;
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `0x${x.toString(16)}` : x));

export function httpRpc(url: string, opts: HttpRpcOptions = {}): RpcRequester {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let id = 0;
  return {
    url,
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
      const t0 = Date.now();
      const body = { jsonrpc: "2.0", id: ++id, method, params };
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...opts.headers },
          body: json(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        opts.trace?.({ url, method, params, error: String(e), ms: Date.now() - t0 });
        throw new TransportError(`Cannot reach ${url} (${method}): ${(e as Error).message}`, { rpc: { method, url, message: String(e), params }, cause: e });
      }
      let reply: any;
      try {
        reply = await res.json();
      } catch (e) {
        throw new TransportError(`${url} answered HTTP ${res.status} without JSON (${method})`, { rpc: { method, url, message: `HTTP ${res.status}`, params }, cause: e });
      }
      opts.trace?.({ url, method, params, response: reply, ms: Date.now() - t0 });
      if (reply?.error) {
        throw decodeRpcError({ method, url, code: reply.error.code, message: reply.error.message, data: reply.error.data, raw: reply, params }, opts.kind ?? "alt");
      }
      return reply?.result as T;
    },
  };
}

// ---------------------------------------------------------------- WebSocket

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
};
export type WebSocketCtor = new (url: string) => WsLike;

export type WsStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface WsRpcOptions {
  WebSocket?: WebSocketCtor;
  requestTimeoutMs?: number;
  /** Reconnect backoff: starts at minDelayMs and doubles up to maxDelayMs. `false` disables reconnecting. */
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number };
  kind?: EndpointKind;
  onStatus?: (s: WsStatus, info?: { attempt?: number; error?: unknown }) => void;
}

export interface WsSubscription {
  /** The current server subscription id (changes after a reconnect). */
  readonly id: string | undefined;
  unsubscribe(): Promise<void>;
}

export interface WsRpc extends RpcRequester {
  readonly status: WsStatus;
  /**
   * `skandha_subscribe(...params())`. `params` is called again on every (re)subscribe so a caller can resume from
   * where it left off (explorerEvents takes the last seen seq). `onEvent` gets each notification's `result`.
   */
  subscribe(params: () => unknown[], onEvent: (result: unknown) => void, onError?: (e: SubscriptionError) => void): Promise<WsSubscription>;
  close(): void;
}

interface Sub { params: () => unknown[]; onEvent: (r: unknown) => void; onError?: (e: SubscriptionError) => void; serverId?: string; active: boolean; inflight?: Promise<void> }

export function wsRpc(url: string, opts: WsRpcOptions = {}): WsRpc {
  const Ctor = opts.WebSocket ?? (globalThis as any).WebSocket;
  if (!Ctor) throw new SubscriptionError("No WebSocket implementation: pass `WebSocket` in the options.");
  const timeoutMs = opts.requestTimeoutMs ?? 20_000;
  const reconnect = opts.reconnect === false ? false : { minDelayMs: opts.reconnect?.minDelayMs ?? 500, maxDelayMs: opts.reconnect?.maxDelayMs ?? 15_000 };
  let ws: WsLike | undefined;
  let status: WsStatus = "idle";
  let opened: Promise<void> | undefined;
  let attempt = 0;
  let closedByUser = false;
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void; method: string; params: unknown[]; timer: ReturnType<typeof setTimeout> }>();
  const subs = new Set<Sub>();
  const byServerId = new Map<string, Sub>();

  const setStatus = (s: WsStatus, info?: { attempt?: number; error?: unknown }) => { status = s; opts.onStatus?.(s, info); };

  const failPending = (why: string) => {
    for (const [k, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError(`${why} (${p.method})`, { rpc: { method: p.method, url, message: why, params: p.params } }));
      pending.delete(k);
    }
  };

  const connect = (): Promise<void> => {
    if (opened) return opened;
    setStatus(attempt === 0 ? "connecting" : "reconnecting", { attempt });
    opened = new Promise<void>((resolve, reject) => {
      let sock: WsLike;
      try {
        sock = new Ctor(url);
      } catch (e) {
        opened = undefined;
        return reject(new TransportError(`Cannot open ${url}: ${(e as Error).message}`, { rpc: { method: "ws", url, message: String(e) }, cause: e }));
      }
      ws = sock;
      let isOpen = false;
      sock.onopen = () => {
        isOpen = true;
        attempt = 0;
        setStatus("open");
        resolve();
        void resubscribeAll();
      };
      sock.onmessage = (ev) => onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
      sock.onerror = (ev) => {
        if (!isOpen) {
          opened = undefined;
          reject(new TransportError(`WebSocket error on ${url}`, { rpc: { method: "ws", url, message: String((ev as any)?.message ?? "error") } }));
        }
      };
      sock.onclose = () => {
        opened = undefined;
        ws = undefined;
        for (const s of subs) s.serverId = undefined;
        byServerId.clear();
        failPending("WebSocket closed");
        if (!isOpen) reject(new TransportError(`WebSocket to ${url} closed before opening`, { rpc: { method: "ws", url, message: "closed" } }));
        if (closedByUser || !reconnect) return setStatus("closed");
        if (subs.size === 0) return setStatus("idle");
        scheduleReconnect();
      };
    });
    return opened;
  };

  const scheduleReconnect = () => {
    if (!reconnect) return;
    attempt++;
    const delay = Math.min(reconnect.maxDelayMs, reconnect.minDelayMs * 2 ** (attempt - 1));
    setStatus("reconnecting", { attempt });
    setTimeout(() => {
      if (closedByUser) return;
      connect().catch((error) => {
        opts.onStatus?.("reconnecting", { attempt, error });
        scheduleReconnect();
      });
    }, delay);
  };

  const onMessage = (text: string) => {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.method === "skandha_subscription" && msg.params?.subscription) {
      const sub = byServerId.get(msg.params.subscription);
      if (sub?.active) {
        try { sub.onEvent(msg.params.result); } catch (e) { sub.onError?.(new SubscriptionError(`subscriber threw: ${(e as Error).message}`, { cause: e })); }
      }
      return;
    }
    if (typeof msg?.id !== "number") return; // the sidecar also sends empty `{}` frames
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(decodeRpcError({ method: p.method, url, code: msg.error.code, message: msg.error.message, data: msg.error.data, raw: msg, params: p.params }, opts.kind ?? "alt"));
    else p.resolve(msg.result);
  };

  const request = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    await connect();
    const n = ++id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new TransportError(`${method} timed out after ${timeoutMs} ms on ${url}`, { rpc: { method, url, message: "timeout", params } }));
      }, timeoutMs);
      pending.set(n, { resolve, reject, method, params, timer });
      ws!.send(json({ jsonrpc: "2.0", id: n, method, params }));
    });
  };

  const subscribeOne = (s: Sub): Promise<void> => {
    if (s.inflight) return s.inflight;
    s.inflight = (async () => {
      try {
        const serverId = await request<string>("skandha_subscribe", s.params());
        if (!s.active) { void request("skandha_unsubscribe", [serverId]).catch(() => {}); return; }
        s.serverId = serverId;
        byServerId.set(serverId, s);
      } finally {
        s.inflight = undefined;
      }
    })();
    return s.inflight;
  };

  const resubscribeAll = async () => {
    for (const s of subs) {
      if (s.active && !s.serverId) {
        await subscribeOne(s).catch((e) => s.onError?.(new SubscriptionError(`resubscribe failed: ${(e as Error).message}`, { cause: e })));
      }
    }
  };

  return {
    url,
    get status() { return status; },
    request,
    async subscribe(params, onEvent, onError) {
      closedByUser = false;
      const s: Sub = { params, onEvent, onError, active: true };
      subs.add(s);
      try {
        await connect();
        if (!s.serverId) await subscribeOne(s);
      } catch (e) {
        subs.delete(s);
        throw e instanceof SubscriptionError ? e : new SubscriptionError(`skandha_subscribe failed: ${(e as Error).message}`, { cause: e, rpc: (e as any)?.rpc });
      }
      return {
        get id() { return s.serverId; },
        async unsubscribe() {
          s.active = false;
          subs.delete(s);
          const sid = s.serverId;
          if (sid) {
            byServerId.delete(sid);
            if (status === "open") await request("skandha_unsubscribe", [sid]).catch(() => {});
          }
        },
      };
    },
    close() {
      closedByUser = true;
      for (const s of subs) s.active = false;
      subs.clear();
      byServerId.clear();
      ws?.close(1000);
      failPending("WebSocket closed by client");
      setStatus("closed");
    },
  };
}
