import { EXPIRY, type FrameRow } from "../../frames";

export type FrameState = "success" | "rolled back" | "reverted" | "skipped" | "pending";

/** Collapse the receipt status into the five states the rail draws. A frame with no status yet is pending. */
export const stateOf = (r: FrameRow): FrameState => {
  const s = r.status;
  if (!s) return "pending";
  if (s === "success") return "success";
  if (s === "rolled back") return "rolled back";
  if (s === "pending") return "pending";
  return /skip/i.test(s) ? "skipped" : "reverted";
};

/** Plain-English step name from target + decoded call. */
export const stepName = (r: FrameRow): string => {
  const n = r.targetName ?? "";
  if (r.target.toLowerCase() === EXPIRY) return "expiry";
  if (r.mode === "VERIFY") return /relay/i.test(n) ? "relay checks the proof and pays" : "sender approves";
  if (/^deploy/.test(r.call)) return "deploy Settler";
  if (/^settle/.test(r.call)) return "settle invoice";
  if (/Router|Uniswap/.test(n) || /^(swap|execute)/.test(r.call)) return "swap on v4";
  if (/^withdraw/.test(r.call) && /pool/i.test(n)) return "withdraw";
  if (/WETH9/.test(n)) return "unwrap";
  if (/InvoiceBook/.test(n) || /^assert/.test(r.call)) return "check books";
  if (/^transfer|^sweep|^refund/.test(r.call)) return "sweep change";
  return r.call.replace(/\(.*$/, "") || "call";
};

export const GROUPS = {
  verify: { title: "Validation", sub: "who approves and who pays" },
  out: { title: "Outside the batch", sub: "always kept, repays the relay" },
  atomic: { title: "Atomic batch", sub: "all or nothing" },
} as const;
export type GroupKey = keyof typeof GROUPS;

export const groupOf = (r: FrameRow): GroupKey => (r.mode === "VERIFY" ? "verify" : r.batch === "outside" ? "out" : "atomic");

/** Consecutive frames sharing a group. */
export const grouped = (rows: FrameRow[]): { key: GroupKey; rows: FrameRow[] }[] => {
  const out: { key: GroupKey; rows: FrameRow[] }[] = [];
  for (const r of rows) {
    const k = groupOf(r);
    const last = out[out.length - 1];
    if (last?.key === k) last.rows.push(r); else out.push({ key: k, rows: [r] });
  }
  return out;
};

export const STATE_TEXT: Record<FrameState, string> = {
  success: "success", "rolled back": "rolled back", reverted: "reverted", skipped: "skipped", pending: "pending",
};

/** Why the frame is in this state, in words a judge can follow. */
export const explain = (r: FrameRow, st: FrameState, rows: FrameRow[]): string => {
  const bad = rows.find((x) => stateOf(x) === "reverted");
  switch (st) {
    case "success": return "Ran and its effects stand.";
    case "rolled back": return `The receipt says success with empty logs. Frame ${bad?.index ?? "a later one"} of the same atomic batch reverted and undid this one.`;
    case "reverted": return "This frame failed. Every earlier frame of its atomic batch was undone with it.";
    case "skipped": return `Receipt status 2. It never ran, because frame ${bad?.index ?? "an earlier one"} of its batch reverted.`;
    case "pending": return "Planned, not sent yet.";
  }
};

/** What a Pledge Paid frame does, and why it sits in its group. Keyed by stepName; other frame types get none. */
const DOES: Record<string, { what: string; why: string }> = {
  expiry: {
    what: "Checks the transaction's deadline against the block time.",
    why: "As validation, it lets a node drop a stale payment before spending anything on it.",
  },
  "relay checks the proof and pays": {
    what: "PayRelayWETH verifies the Groth16 proof of the pool withdrawal, then approves execution and payment, so the relay pays the gas and the transaction needs no signature.",
    why: "As validation, it decides admission. The alt mempool simulates this frame before it admits the transaction.",
  },
  withdraw: {
    what: "Calls the WETH pool's withdraw. It pays the note out to the Settler's address and the relay fee to PayRelayWETH.",
    why: "It is outside the batch, so it stays final even if a later frame fails, and the relay is always repaid.",
  },
  "deploy Settler": {
    what: "SettlerFactory deploys the Settler contract at the address the invoice terms fix. The proof already named that address as recipient, so the funds are waiting there.",
    why: "It opens the atomic batch: if any later frame of the batch fails, the deployment is undone.",
  },
  unwrap: {
    what: "Calls the Settler to unwrap its WETH into ETH for the swap.",
    why: "It is atomic with the swap, so a failed swap cannot leave the Settler holding ETH it should not have.",
  },
  "swap on v4": {
    what: "Calls the Settler to buy exactly the invoice amount of fgUSD on Uniswap v4, spending at most the quoted maximum.",
    why: "It is atomic: either the invoice amount arrives or nothing in the batch happens.",
  },
  "settle invoice": {
    what: "Calls InvoiceBook.settle with the Settler, which pays the fgUSD to the invoice payee and marks the invoice paid. It reverts if the invoice is already paid.",
    why: "It is atomic with the swap, so a payee is never paid twice and a failed payment never keeps the swap.",
  },
  "sweep change": {
    what: "Calls the Settler to send the ETH left after the swap to the fund (the invoice payee), unless the sender chose another change address.",
    why: "It is atomic, so the leftover ETH moves only when the invoice was paid.",
  },
  "check books": {
    what: "Calls assertSettled on the Settler. It reverts unless the invoice is paid and the Settler holds no ETH, WETH or fgUSD.",
    why: "It closes the atomic batch. If the books are off, the whole batch is undone.",
  },
};
export const doesOf = (r: FrameRow) => DOES[stepName(r)];

/** One sentence per mode and per state, for the legend. */
export const MODE_HELP = {
  VERIFY: "A validation frame. It runs first, read-only, and must approve who pays or the transaction is invalid.",
  SENDER: "Runs as the transaction's sender. Here the sender is the PayRelayWETH contract, so it needs no signature.",
  DEFAULT: "A plain call from the protocol's entry point, not from the sender.",
} as const;

export const STATE_HELP: Record<FrameState, string> = {
  pending: "Planned, or sent and not in a block yet.",
  success: "Ran, and its effects stand.",
  "rolled back": "The receipt says success with empty logs, because a later frame of the same atomic batch reverted and undid it.",
  reverted: "This frame failed and undid the earlier frames of its atomic batch.",
  skipped: "Receipt status 2. It never ran, because an earlier frame of its batch reverted.",
};

export const GROUP_HELP: Record<GroupKey, string> = {
  verify: "Frames 0 and 1. Who approves and who pays.",
  out: "Frame 2. The withdraw and the relay's repayment always stand.",
  atomic: "Frames 3 to 8. All of them take effect, or none does.",
};
