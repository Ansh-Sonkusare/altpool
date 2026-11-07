// The admission rules an agent hits most, condensed from https://docs.altmempool.wtf/rules/ (ERC-8421 draft) and what
// the public devnet does today (our findings: packages/wallet-bridge/README.md, research docs/10-rule-findings.md).
// `sidecar` lists the RuleCheck ids the sidecar's admission records use, so a failed check maps back to a rule here.
import { fail, ok, type ToolResult } from "./result";

export interface RuleEntry {
  id: string;
  sidecar: string[];
  title: string;
  rule: string;
  fix: string;
}

export const RULES: RuleEntry[] = [
  { id: "BUDGET-010", sidecar: ["gas-limit", "out-of-gas", "public-gas-cap"], title: "Verification gas budget",
    rule: "Sum of DECLARED limits.execution over an entity's validation frames (plus the signatures' intrinsic cost, for the sender): unstaked <= 100,000, staked <= 1,000,000 (draft). The public mempool caps the whole prefix at 100,000. A VERIFY frame that runs out of gas is a rejection (OPCODES-040).",
    fix: "Keep VERIFY limits tight (declared, not used, gas counts). Over 100k: stake the entity and use the alt mempool. 7 nonce keys need ~80k of VERIFY gas, not 30k." },
  { id: "PREFIX-010", sidecar: ["prefix", "structure"], title: "Validation prefix shape",
    rule: "Allowed: [self_verify], [deploy, self_verify], [only_verify, pay], [deploy, only_verify, pay]; one pre_verify before each approving frame; optional expiry_verify (0x8141) first. No ATOMIC_BATCH_FLAG in the prefix (PREFIX-040), no VERIFY after it (PREFIX-050); a VERIFY that reverts or never APPROVEs rejects (PREFIX-060).",
    fix: "Put VERIFY frames first, each targeting the sender (or a payer) and calling APPROVE; SENDER frames after. Empty VERIFY calldata hits receive(), not fallback: send at least 1 byte." },
  { id: "SIGNATURE-010", sidecar: ["signature"], title: "Signatures",
    rule: "Every SECP256K1 / P256 entry is verified against its message before simulation. ARBITRARY entries are not verified by the protocol (the account's code checks them) and must NOT name a signer (devnet: 'ARBITRARY signatures must not name a signer'). msg '0x' means the entry signs SIG_HASH, and its bytes are elided from SIG_HASH.",
    fix: "Sign after gas and fees are final (estimation swaps in placeholder limits). ARBITRARY: signer '0x'. A VERIFY that trusts SIGPARAM must also check MSG, or old signatures replay." },
  { id: "OPCODES", sidecar: ["OP-011", "OP-061", "OP-062"], title: "Banned opcodes in validation",
    rule: "Banned for everyone: GASPRICE, BLOCKHASH, COINBASE, TIMESTAMP, NUMBER, PREVRANDAO, GASLIMIT, BASEFEE, BLOBBASEFEE, SLOTNUM, GAS (except before *CALL), CREATE/CREATE2 (deploy frame only), INVALID, SELFDESTRUCT, SSTORE (except sender storage in the deploy frame). BALANCE / SELFBALANCE only for staked entities (OPCODES-010; devnet: stake strictly above minStake). No value in nested calls (OP-061).",
    fix: "Move time checks to an expiry_verify frame (0x8141) instead of TIMESTAMP/NUMBER; move balance checks to a staked entity; do state changes in SENDER frames." },
  { id: "STORAGE", sidecar: ["storage", "public-storage"], title: "Storage access in validation",
    rule: "Sender's own storage: always (STORAGE-010). Sender-associated slots in another contract: if the sender exists (021), or with a staked factory (022). A staked entity: its own storage (031), read-only anywhere in non-entity contracts (032), slots associated with its address (033). Unstaked non-sender entities: no access. The public mempool allows only the sender's own storage.",
    fix: "Stake the entity that reads (paymaster, relay) with stake_entity, then send to the alt mempool. If it is staked, check reputation: a banned entity is reported like an unstaked one." },
  { id: "CALLING-010", sidecar: ["COD-010", "entrypoint-access"], title: "Calls in validation",
    rule: "Calling an address with no code is forbidden. Stateless precompiles 0x01-0x11 and P256VERIFY (0x100) are allowed (CALLING-040; ecrecover works on the devnet since 2026-11-06).",
    fix: "Only call deployed contracts from VERIFY; deploy dependencies first." },
  { id: "STAKING-010", sidecar: ["stake"], title: "Stake",
    rule: "Staked iff registry stake >= MIN_STAKE_VALUE (devnet 0.01 ETH; BALANCE carve-out needs strictly more), unstake delay >= MIN_UNSTAKE_DELAY (draft 86,400 s; devnet config 0), and no withdrawal started. unlockStake() drops the status immediately. The registry keys on msg.sender: a contract must call addStake from its own code. No slashing.",
    fix: "stake_entity (agent EOA) or stake_entity { contract } for a contract with payable stake(registry, delay). Use 0.012 ETH and 86,400 s." },
  { id: "REPUTATION", sidecar: ["reputation"], title: "Reputation (throttle / ban)",
    rule: "Per entity: seen and included, decayed hourly x23/24. max_seen = seen / 10. BANNED if max_seen > included + 50 (not admitted); THROTTLED if > included + 10 (capped at 4 pending). New entities are ACTIVE. Devnet: opsIncluded can stay 0, so a busy staked sender throttles after ~110 sends; replacements count as seen.",
    fix: "entity_status shows headroom. Use a fresh entity address for demos; stop sending txs that fail revalidation." },
  { id: "LIFECYCLE-010", sidecar: ["mempool", "nonce"], title: "Nonces (EIP-8250 keyed)",
    rule: "1-16 strictly increasing keys; key 0 (the account nonce) only alone. nonceSeq must equal each key's current sequence. One pending tx per (sender, key); a replacement needs +10% on both fees. Unstaked sender: 4 pending linear txs.",
    fix: "Use a fresh random nonce key per tx to send in parallel (send_calls { parallel: true }); bump fees 10% to replace." },
  { id: "SOLVENCY-010", sidecar: ["execution", "simulation"], title: "Payer solvency",
    rule: "The payer must cover max cost = (all frame limits + intrinsic) x maxFeePerGas, minus what its other pending txs reserve; re-checked every block, newest dropped first. ethrex reports a missing balance as the ambiguous 'validation prefix frame reverted'.",
    fix: "fund_from_faucet the payer (the sender when it self-pays). Fund contracts through their creation value." },
  { id: "STATE-GAS", sidecar: ["execution"], title: "State gas (frame limits.state)",
    rule: "Creating an account costs 183,600 state gas, a new storage slot 97,920. A frame with limits.state = 0 that creates state halts silently and fails the tx. Unused limits are refunded.",
    fix: "Declare state gas on SENDER frames that transfer value to fresh addresses (~200k) or write new storage." },
  { id: "RECENT-ROOT", sidecar: ["recent-root"], title: "Recent roots (EIP-8272)",
    rule: "Up to 16 references {sourceId, slot, root}, committed in RECENT_ROOT_ADDRESS (0x...8272), usable while 1 <= head_slot + 1 - slot <= 8191. A root written in slot S is usable from S+1.",
    fix: "Wait one slot after publishing a root; drop references near expiry." },
];

export const RULES_MARKDOWN = [
  "# Alt mempool admission rules (ERC-8421 draft + public devnet behaviour)",
  "",
  "Source: https://docs.altmempool.wtf/rules/ . Sidecar check ids in brackets map an admission record's failed check to a rule.",
  "",
  ...RULES.flatMap((r) => [`## ${r.id}: ${r.title} [${r.sidecar.join(", ")}]`, "", r.rule, "", `Fix: ${r.fix}`, ""]),
].join("\n");

/** Look a rule up by ERC id, sidecar check id, or a word from its title/text. */
export function explainRuleTool(args: { rule: string }): ToolResult {
  const q = args.rule.trim().toLowerCase();
  if (!q) return fail("Empty rule.", "Pass a rule id (BUDGET-010, OP-061, storage) or a word (stake, nonce, timestamp).");
  const exact = RULES.filter((r) => r.id.toLowerCase() === q || r.sidecar.some((s) => s.toLowerCase() === q) || q.startsWith(r.id.toLowerCase()));
  const hits = exact.length ? exact : RULES.filter((r) => `${r.id} ${r.title} ${r.rule}`.toLowerCase().includes(q));
  if (!hits.length) return fail(`No rule matches "${args.rule}".`, `Try one of: ${RULES.map((r) => r.id).join(", ")}; or read the altpool://rules resource.`);
  return ok(hits.map((r) => `${r.id}: ${r.title} [sidecar: ${r.sidecar.join(", ")}]\n${r.rule}\nFix: ${r.fix}`).join("\n\n"));
}
