// Owner: Dev C.
// Ground truth to build on:
//   public: ethrex().simulateFrameTransaction(raw) -> { canonicalMempoolValid, canonicalMempoolViolation } (fixtures public/29-31)
//   alt:    there is no dry-run (frame_simulateTransactionV1 is -32601, fixture public/22). Use the explorer record
//           gateway().admission(hash) for sent txs; otherwise a local rule model with source "model" (unverified).
//   error text -> rule family: explainRejection() from @altpool/core (re-exported from hegota-support).
import { todo, type AdmissionChecker, type AdmissionReport, type FrameTx } from "@altpool/core";

export const checkAdmission = (_tx: FrameTx): Promise<AdmissionReport> => todo("checkAdmission");

export const simulator: AdmissionChecker = { check: checkAdmission };
