// POST /prove {note, recipient} -> Groth16 withdraw proof for ExitRelay. Run: bun apps/site/server/prove.ts
// The caller sends the note's secret here, so whoever runs this server can link that deposit to its exit.
import { isAddress, type Address } from "viem";
import { EXIT_FEE, deployments } from "@altpool/contracts";
import { parseNote, prove } from "@altpool/prover";

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.ALLOW_ORIGIN ?? "http://localhost:5179").split(",");
const relayer = deployments.exitRelay as Address;
let busy = false;

const reply = (origin: string | null, status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: {
      "content-type": "application/json",
      ...(origin && ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", vary: "origin" } : {}),
    },
  });

Bun.serve({
  port: PORT,
  maxRequestBodySize: 1024,
  idleTimeout: 255,
  async fetch(req) {
    const origin = req.headers.get("origin");
    const path = new URL(req.url).pathname;
    if (req.method === "OPTIONS") return reply(origin, 204);
    if (req.method === "GET" && path === "/health") return reply(origin, 200, { busy });
    if (req.method !== "POST" || path !== "/prove") return reply(origin, 404, { error: "POST /prove" });
    if (origin && !ORIGINS.includes(origin)) return reply(origin, 403, { error: "origin not allowed" });
    let note, recipient: unknown;
    try {
      const body = (await req.json()) as { note?: unknown; recipient?: unknown };
      note = parseNote(String(body.note));
      recipient = body.recipient;
      if (typeof recipient !== "string" || !isAddress(recipient)) throw new Error("bad recipient");
    } catch (e) {
      return reply(origin, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    // ponytail: one proof at a time (~70 s, ~700 MB); add a queue if several visitors need to wait in line.
    if (busy) return reply(origin, 503, { error: "busy: another visitor's proof is running" });
    busy = true;
    const t0 = performance.now();
    try {
      const proof = await prove(note, { recipient: recipient as Address, relayer, fee: EXIT_FEE });
      return reply(origin, 200, { ...proof, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      return reply(origin, 500, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
    }
  },
});
console.log(`prove server on :${PORT}, origins ${ORIGINS.join(" ")}, relayer ${relayer}`);
