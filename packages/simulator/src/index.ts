// Owner: Dev C.
//   public: ethrex().simulateFrameTransaction(raw) -> { canonicalMempoolValid, canonicalMempoolViolation } (fixtures public/29-31)
//   alt:    there is no dry-run (frame_simulateTransactionV1 is -32601, fixture public/22). Use the explorer record
//           gateway().admission(hash) for sent txs; otherwise a local rule model with source "model" (unverified).
import type { AdmissionChecker } from "@altpool/core";
import { checkAdmission } from "./check";

export { checkAdmission, createSimulator, type SimulatorOptions } from "./check";
export { runModel, entitiesOf, prefixFrames, verifyGasOf, type Entity, type StakeInfo, type Reputation, type TraceFrame } from "./model";
export { diagnoseError, diagnoseSimulation, diagnoseAdmission, decodeRevert, type Diagnosis, type NodeError } from "./rules";

/** Pass as the SDK's `precheck`. */
export const simulator: AdmissionChecker = { check: checkAdmission };
