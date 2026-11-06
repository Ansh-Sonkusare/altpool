// Owner: Dev C. Node response -> RuleId + entity + fix line.
// Patterns are pinned to captured strings (core fixtures) and the sidecar/ethrex messages in the
// research repo's derisk/rules.md. Order matters: the first match wins.
import { decodeAbiParameters } from "viem";
import type { Address, EntityRole, EthrexSimulation, Hex, Mempool, RuleCheck, RuleId } from "@altpool/core";

export interface Diagnosis {
  rule: RuleId;
  /** ERC-8421 rule id, when the sidecar rule maps to one. */
  ercRule?: string;
  /** address is missing when the node names only the role; checkAdmission fills it from the tx. */
  entity?: { role: EntityRole; address?: Address };
  frameIndex?: number;
  revertReason?: string;
  /** The node's own text. */
  detail: string;
  fix: string;
}

/** A JSON-RPC error as the node sent it, or hegota-support's RpcError (code "RPC_-32502"). */
export interface NodeError { code: number | string; message: string; data?: unknown }

const ERC_RULE: Partial<Record<RuleId, string>> = {
  prefix: "PREFIX-010",
  signature: "SIGNATURE-010",
  "OP-011": "OPCODES-010",
  "OP-061": "OPCODES (static VERIFY)",
  "out-of-gas": "OPCODES-040",
  create: "CREATION-010",
  storage: "STORAGE-031..033",
  "public-storage": "STORAGE-010",
  "COD-010": "CALLING-010",
  "public-gas-cap": "BUDGET-010",
};

const ROLES = "sender|payer|factory|paymaster";
const role = (s: string | undefined): EntityRole | undefined =>
  s === "paymaster" ? "payer" : (s as EntityRole | undefined);

const fixFor = (rule: RuleId, mempool: Mempool, d: Partial<Diagnosis>): string => {
  const who = d.entity ? [d.entity.role, d.entity.address].filter(Boolean).join(" ") : "the entity whose storage VERIFY reads";
  switch (rule) {
    case "public-storage":
      return "The public mempool lets VERIFY read only the sender's own storage. Send to the alt mempool with the reading entity staked.";
    case "storage":
      return `Stake ${who} in the staking registry (> 0.01 ETH, 1-day unstake delay), then resend to the alt mempool. If it is already staked, check its reputation: a banned entity is reported as unstaked.`;
    case "public-gas-cap":
      return mempool === "public"
        ? "The public mempool caps the whole validation prefix at 100k gas. Lower the VERIFY limits or send to the alt mempool."
        : "Lower the VERIFY frame limits: the prefix is over this node's MAX_VERIFY_GAS.";
    case "gas-limit":
      return "Lower the frame limits: the total is over the node's per-transaction gas cap.";
    case "signature":
      return "Re-sign over the final tx. Gas estimation swaps in placeholder limits, so sign after filling gas, not before.";
    case "recent-root":
      return "Reference a recent root that is committed in the RECENT_ROOT_ADDRESS predeploy and still inside the window, or drop the reference.";
    case "prefix":
      return "Reshape the frames: the validation prefix must be one of the recognised shapes (self_verify, or only_verify + pay).";
    case "structure":
      return "Fix the tx structure: VERIFY frames target the sender (or null), sit only in the prefix, and never set ATOMIC_BATCH_FLAG.";
    case "OP-011":
      return "Remove the banned opcode from VERIFY (TIMESTAMP, NUMBER, BALANCE, GAS not before a CALL, ...). BALANCE/SELFBALANCE are allowed once the entity is staked.";
    case "create":
      return "Only the deploy frame may CREATE/CREATE2, once, to install code at tx.sender.";
    case "OP-061":
      return "VERIFY runs static: remove the CALL with value.";
    case "out-of-gas":
      return "Raise the VERIFY frame's execution limit: an entity frame may not revert on out-of-gas.";
    case "COD-010":
      return "VERIFY touched an address with no code. Deploy it first or remove the call.";
    case "entrypoint-access":
      return "Don't read the EntryPoint sentinel's code during validation.";
    case "nullifier-spent":
      return "This note was already withdrawn. Use a fresh note.";
    case "simulation": {
      const n = d.detail?.match(/Nonce mismatch: expected (\d+), got (\d+)/);
      if (n) return `Nonce ${n[2]} is used up: rebuild the tx with nonceSeq ${n[1]} (or a fresh nonce key) and re-sign.`;
      return d.revertReason
        ? `VERIFY frame ${d.frameIndex ?? "?"} reverted: "${d.revertReason}". Fix the input the contract rejects.`
        : "Validation failed in simulation. Check the nonce, the payer's balance and the VERIFY frame's revert.";
    }
    case "mempool":
      return "Mempool policy rejected it: wait for the pending tx on this nonce key, bump fees by at least 10%, use a fresh key, or let the entity's reputation recover.";
    case "admission":
      return "Read the admission record on the explorer for the failing check.";
    default:
      return "Unrecognised rejection. Run frame-doctor on the tx hash to read the explorer's admission record.";
  }
};

/** Error(string) revert data -> its reason. */
export const decodeRevert = (data: string | undefined): string | undefined => {
  if (!data?.startsWith("0x08c379a0")) return undefined;
  try {
    return decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}` as Hex)[0];
  } catch {
    return undefined;
  }
};

const NULLIFIER_SPENT = /already (been )?spent|nullifier.*(spent|used)|note has been/i;

type Match = { rule: RuleId; entity?: Diagnosis["entity"]; frameIndex?: number; revertReason?: string };

const dataAddress = (data: unknown, r?: EntityRole): Address | undefined => {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  const a = (r && d[r]) ?? d.payer ?? d.sender ?? d.factory;
  return typeof a === "string" ? (a as Address) : undefined;
};

const classify = (message: string, code: number | undefined, data: unknown): Match => {
  const m = message;
  let x: RegExpMatchArray | null;

  if (/Error decoding field/i.test(m)) return { rule: "structure" };
  if (code === -32507 || /Invalid frame transaction signature|InvalidFrameSignature/i.test(m)) return { rule: "signature" };
  if (/recent-root|RECENT_ROOT|RecentRoot/i.test(m)) return { rule: "recent-root" };
  if (/prefix gas budget|exceeds MAX_VERIFY_GAS|VerifyGasBudgetExceeded|VerifyGasExceeded/i.test(m)) return { rule: "public-gas-cap" };
  if (/gas limit is too high|per-transaction gas cap/i.test(m)) return { rule: "gas-limit" };
  if (/validation prefix not recognized/i.test(m)) return { rule: "prefix" };
  if (/ATOMIC_BATCH_FLAG|AtomicBatchInPrefix|expected tx\.sender|VerifyTargetNotSender|VERIFY frame after|VerifyFrameAfterPrefix|chain id .* does not match|state gas sum|PreVerify/i.test(m))
    return { rule: "structure", frameIndex: frameOf(m) };

  if ((x = m.match(new RegExp(`(${ROLES}) uses banned opcode: (CREATE2?)\\b`))) || /too many CREATE2/.test(m))
    return { rule: "create", entity: entityOf(x?.[1], data) };
  if ((x = m.match(new RegExp(`(?:(${ROLES}) uses )?banned opcode|BannedOpcode`, "i"))))
    return { rule: "OP-011", entity: entityOf(x[1], data) };
  if (/nested CALL with value/i.test(m)) return { rule: "OP-061" };
  if ((x = m.match(new RegExp(`(${ROLES}) internally reverts on oog`)))) return { rule: "out-of-gas", entity: entityOf(x[1], data) };
  if ((x = m.match(new RegExp(`(${ROLES}) accesses un-deployed contract`))) || /CallToNonexistentOrDelegated/.test(m))
    return { rule: "COD-010", entity: entityOf(x?.[1], data) };
  if ((x = m.match(new RegExp(`(${ROLES}) accesses EntryPoint`)))) return { rule: "entrypoint-access", entity: entityOf(x[1], data) };

  if (/StorageReadNonSender|StorageWrite/i.test(m)) return { rule: "public-storage" };
  if ((x = m.match(new RegExp(`unstaked (${ROLES}) accessed|(${ROLES}) has forbidden (read|write)`))))
    return { rule: "storage", entity: entityOf(x[1] ?? x[2], data) };

  if (/is banned|is throttled|is unstaked|stake .* is too low|unstake delay .* is too low|already held by pending|cannot be replaced|cannot cover its pending|used as a different entity/i.test(m))
    return { rule: "mempool", entity: entityOf(m.match(new RegExp(`\\b(${ROLES})\\b`, "i"))?.[1]?.toLowerCase(), data) };

  if ((x = m.match(/validation frame (\d+): reverted(?: with data (0x[0-9a-fA-F]*))?/))) {
    const revertReason = decodeRevert(x[2]);
    return { rule: revertReason && NULLIFIER_SPENT.test(revertReason) ? "nullifier-spent" : "simulation", frameIndex: Number(x[1]), revertReason };
  }
  if (/validation frame \d+:|Nonce mismatch|Invalid Transaction|has \d+ wei/i.test(m)) return { rule: "simulation", frameIndex: frameOf(m) };

  return { rule: "unknown" };
};

const frameOf = (m: string): number | undefined => {
  const x = m.match(/frame (\d+)/i);
  return x ? Number(x[1]) : undefined;
};

const entityOf = (r: string | undefined, data: unknown): Diagnosis["entity"] => {
  const er = role(r);
  if (!er) return undefined;
  const address = dataAddress(data, er);
  return address ? { role: er, address } : { role: er };
};

const toCode = (c: number | string): number | undefined => {
  if (typeof c === "number") return c;
  const n = Number(c.replace(/^RPC_/, ""));
  return Number.isFinite(n) ? n : undefined;
};

const finish = (x: Match, detail: string, mempool: Mempool): Diagnosis => {
  const d: Diagnosis = { ...x, ercRule: ERC_RULE[x.rule], detail, fix: "" };
  d.fix = fixFor(x.rule, mempool, d);
  // public-gas-cap is ethrex's verdict; the sidecar records its own MAX_VERIFY_GAS check as "structure".
  if (x.rule === "public-gas-cap" && mempool === "alt") d.rule = "structure";
  return d;
};

/** A send / estimate rejection from the gateway (alt) or ethrex (public). */
export const diagnoseError = (err: NodeError, mempool: Mempool): Diagnosis =>
  finish(classify(err.message, toCode(err.code), err.data), err.message, mempool);

/** ethrex_simulateFrameTransaction result. Undefined when the public mempool would admit the tx. */
export const diagnoseSimulation = (sim: EthrexSimulation & { executionError?: string | null }): Diagnosis | undefined => {
  if (sim.canonicalMempoolValid) return undefined;
  const message = sim.canonicalMempoolViolation ?? sim.executionError ?? "canonical mempool rejected the tx";
  return finish(classify(message, undefined, undefined), message, "public");
};

/** The first failing check of an explorer admission record (skandha_explorer_getTransaction().admission). */
export const diagnoseAdmission = (admission: { outcome: string; checks?: RuleCheck[] }): Diagnosis | undefined => {
  if (admission.outcome !== "rejected") return undefined;
  const failed = admission.checks?.find((c) => c.verdict === "fail");
  if (!failed) return finish({ rule: "admission" }, "rejected, no failing check recorded", "alt");
  // The check's detail is the node's message: classify it for entity, frame and revert reason, but keep the sidecar's rule id.
  const fromDetail: Match = failed.detail ? classify(failed.detail, undefined, undefined) : { rule: failed.rule };
  const rule = fromDetail.rule === "nullifier-spent" ? fromDetail.rule : failed.rule;
  const entity = fromDetail.entity ?? (failed.entity ? { role: failed.entity } : undefined);
  return finish({ ...fromDetail, rule, entity, frameIndex: failed.frameIndex ?? fromDetail.frameIndex }, failed.detail ?? failed.rule, "alt");
};
