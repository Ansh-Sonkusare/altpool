// waitForFrameTransactionReceipt falls back to the execution client when the sidecar lags the chain (seen live on
// 2026-11-07: ethrex had the receipt for minutes while the miner sidecar still answered "not found").
import { describe, expect, it } from "vitest";
import { createPublicClient, custom, toHex } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { altDevnet } from "@altpool/core";
import { altpoolActions, createAltMempoolClient } from "../src/index";

const hash = "0x0fe30bd5ce6c906aa15177c3605767a1f16bd608bc24d10b678131331e57df26" as const;

describe("waitForFrameTransactionReceipt", () => {
  it("returns ethrex's receipt when the sidecar does not have it", async () => {
    // Port 1 refuses connections: every sidecar call fails, as a lagging or overloaded sidecar would.
    const sidecar = createAltMempoolClient({ httpUrl: "http://127.0.0.1:1/rpc", profile, name: "down", timeoutMs: 1_000 });
    const client = createPublicClient({
      chain: altDevnet,
      transport: custom({
        async request({ method }: { method: string }) {
          if (method !== "eth_getTransactionReceipt") throw new Error(`unmocked ${method}`);
          return {
            blockNumber: toHex(10428), blockHash: `0x${"11".repeat(32)}`, status: "0x1", cumulativeGasUsed: "0x19ebee", effectiveGasPrice: "0x10670d0",
            frameReceipts: [
              { gasUsed: "0x752a", stateGasUsed: "0x0", status: "0x1", logs: [] },
              { gasUsed: "0xbb8", stateGasUsed: "0x2cd30", status: "0x1", logs: [] },
            ],
          };
        },
      }),
    }).extend(altpoolActions({ sidecar }));
    const { receipt } = await client.altpool.waitForFrameTransactionReceipt({ hash, timeoutMs: 5_000, pollingIntervalMs: 10 });
    expect(receipt.source).toBe("execution");
    expect(receipt.blockNumber).toBe(10428n);
    expect(receipt.frames.map((f) => f.gasUsed)).toEqual([{ execution: 29_994n, state: 0n }, { execution: 3_000n, state: 183_600n }]);
  });
});
