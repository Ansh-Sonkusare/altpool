// The only place proof numbers live. A value still shaped like "{TOKEN}" renders as "pending" (ui.tsx Stat).
export type ProofState = "ok" | "unverified" | "pending";
export interface ProofStat { value: string; label: string; method: string; href?: string; state: ProofState }

const LIVE_MD = "https://github.com/Ansh-Sonkusare/altpool/blob/main/packages/simulator/accuracy/LIVE.md";

export const ACCURACY: ProofStat = {
  value: "16 / 17",
  label: "Prediction matches node outcome",
  method: "Live devnet run: verdict predicted before sending, compared with what the node did. 9 of 9 from ethrex's simulate, 7 of 8 from our rule model. The miss exposed a stake-delay bug, fixed after the run.",
  href: LIVE_MD,
  state: "ok",
};

export const CONFORMANCE: ProofStat = {
  value: "43 / 45",
  label: "Modelled rule cases pass",
  method: "ERC-8421 vectors our model covers; the 2 misses follow the devnet sidecar.",
  href: "https://github.com/Ansh-Sonkusare/altpool/blob/main/packages/simulator/conformance/NOTICE.md",
  state: "ok",
};

export const LIVE_SUITE: ProofStat = {
  value: "17 cases",
  label: "Live devnet cases",
  method: "Each case predicted first, then sent; rows link their transaction.",
  href: LIVE_MD,
  state: "ok",
};

export const FINDINGS: { total: number; filed: string } = { total: 15, filed: "1" };

export const PLEDGE_TX: { hash?: `0x${string}`; placeholder: "{PLEDGE_TX}" } = { placeholder: "{PLEDGE_TX}" };

export interface SuiteTx {
  name: string;
  admitted: boolean;
  /** Only set when the node kept a record or the tx was included. */
  hash?: `0x${string}`;
  predicted: "admit" | "reject";
  /** "admitted": the node admitted it but has not mined it. */
  outcome: "included" | "admitted" | "rejected" | "reverted";
}
export const SUITE_TXS: SuiteTx[] = [
  { name: "Case 1 · plain self-paid frame tx (VERIFY 60k) · public", admitted: true, hash: "0x174e06afd24bf517bf0d602866b71d5a28446f0cddce53f26883b8db5798e63d", predicted: "admit", outcome: "included" },
  { name: "Case 1 · plain self-paid frame tx (VERIFY 60k) · alt", admitted: true, hash: "0x80c24c777b0ed53f368e422d57ee994c461c6f43803aebba7d7df70fba416cf9", predicted: "admit", outcome: "admitted" },
  { name: "Case 2 · VERIFY gas 150k, over the 100k public cap · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 2 · VERIFY gas 150k, over the 100k public cap · alt", admitted: true, hash: "0x4a0022744be619099ee1e07a439ca76093bf6915905a7a0cde637c6821defbf9", predicted: "admit", outcome: "admitted" },
  { name: "Case 3 · unstaked contract whose VERIFY reads another contract's storage · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 3 · unstaked contract whose VERIFY reads another contract's storage · alt", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 4 · the same contract, staked · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 4 · the same contract, staked · alt", admitted: true, hash: "0x5b7a6f0d5cb36e21dd1a1254560438b89c5dab0bbf44f6040a207928599dfcd5", predicted: "reject", outcome: "admitted" },
  { name: "Case 5 · bad signature · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 5 · bad signature · alt", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 6 · ATOMIC_BATCH flag on the last frame · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 6 · ATOMIC_BATCH flag on the last frame · alt", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 7 · nonce replay of an included tx · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 8 · expiry deadline in the past · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 8 · expiry deadline in the past · alt", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 9 · double-spend: newest included ExitRelay exit, re-sent · public", admitted: false, predicted: "reject", outcome: "rejected" },
  { name: "Case 9 · double-spend: newest included ExitRelay exit, re-sent · alt", admitted: false, predicted: "reject", outcome: "rejected" },];
