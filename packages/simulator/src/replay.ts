// Owner: Dev C. A simulator that answers from one captured ethrex_simulateFrameTransaction call: offline, no sends.
// Used by frame-doctor --fixture and the demo's fixture mode. Takes the captured call, so it never touches fs.
import { encodeAbiParameters } from "viem";
import type { Hex, gateway } from "@altpool/core";
import { createSimulator } from "./check";

export interface CapturedSimulation {
  request: { method: string; params: unknown[] };
  response: { result?: any; error?: { code: number; message: string; data?: unknown } };
}

/** `staked` decides what the registry's getDepositInfo answers for every entity. */
export const replaySimulator = (captured: CapturedSimulation, o: { staked?: boolean; label?: string } = {}) => {
  const deposit = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    o.staked ? [12n * 10n ** 15n, 86_400n, 0n] : [0n, 0n, 0n],
  );
  const sim = createSimulator({
    explorer: false,
    estimate: false,
    ethrex: {
      url: `replay:${o.label ?? "fixture"}`,
      call: async (method: string) => (method === "eth_call" ? deposit : null),
      simulateFrameTransaction: async () => {
        const e = captured.response.error;
        if (e) throw Object.assign(new Error(e.message), e);
        return captured.response.result;
      },
      sendRawTransaction: async () => { throw new Error("replay: no sends"); },
    },
    gateway: { listReputation: async () => ({ items: [] }) } as unknown as ReturnType<typeof gateway>,
  });
  return { ...sim, raw: captured.request.params[0] as Hex };
};
