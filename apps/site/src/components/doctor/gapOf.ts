import type { DoctorView } from "../../live";
import { fixFor } from "../../livePledge/presets";

/** The alt mempool admits a transaction whose atomic batch then fails: docs/10 finding 9. */
export interface Gap {
  /** presend: the node's simulation predicts it. onchain: the receipt shows it. */
  phase: "presend" | "onchain";
  frame: number;
  reason?: string;
  fix?: string;
}

/** A gap needs both halves in the same view: an admitting alt verdict and a failed frame. Neither is invented here. */
export const gapOf = (v: DoctorView | undefined): Gap | undefined => {
  const failed = v?.frames?.rows.find((r) => r.state === "failed");
  if (v?.alt?.verdict !== "admitted" || !failed) return undefined;
  const reason = failed.note?.replace(/^reverted: /, "");
  return { phase: v.frames!.source.startsWith("ethrex_") ? "presend" : "onchain", frame: failed.index, reason, fix: v.alt.fix ?? fixFor(reason) };
};
