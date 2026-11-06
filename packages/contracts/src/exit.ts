// The one place the 3-frame exit transaction is laid out. ExitRelay.sol and ExitRelayRR.sol pin these limits and offsets.
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { frame, newTx, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, type WithdrawProof } from "@altpool/core";

export const EXIT_FEE = 10n ** 16n;
// Upper bound on total_gas_limit: 1.76M of frame gas plus ~18k intrinsic/calldata. ExitRelay requires
// max_cost = maxFeePerGas * total_gas_limit <= EXIT_FEE, so the fee cap is derived from this budget.
const EXIT_GAS_BUDGET = 1_850_000n;
// With a refund the pool also creates the recipient account (183,600 state gas): the state limit and the budget grow by 200k.
const EXIT_GAS_BUDGET_REFUND = 2_050_000n;
export const EXIT_MAX_FEE_PER_GAS = EXIT_FEE / EXIT_GAS_BUDGET;
/** ExitRelayToken's SENDER-frame ETH: the pool forwards it to the recipient (Tornado `refund`). 1M gas at 1 gwei. */
export const WETH_EXIT_REFUND = 10n ** 15n;

const EXPIRY_VERIFIER: Address = "0x0000000000000000000000000000000000008141";
const DEADLINE_GRID_SEC = 600;
const poolAbi = parseAbi([
  "function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable",
]);

type ExitOpts = { pool?: Address; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; nowSec?: number };

/** The 3 frames both relays pin; only frame 1's data differs (ExitRelay: rootIdx, ExitRelayRR: empty). */
function buildExit(p: WithdrawProof, relay: Address, verifyData: Hex, o: ExitOpts): FrameTx {
  if (!isAddressEqual(p.relayer, relay)) throw new Error(`proof relayer ${p.relayer} is not exit relay ${relay}`);
  const refund = p.refund ?? 0n;
  const budget = refund === 0n ? EXIT_GAS_BUDGET : EXIT_GAS_BUDGET_REFUND;
  const profile = getProfile(DEVNET.profile);
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  // A coarse grid so the deadline does not fingerprint the moment the user sent.
  const deadline = Math.ceil((now + DEADLINE_GRID_SEC) / DEADLINE_GRID_SEC) * DEADLINE_GRID_SEC;
  return newTx({
    chainId: DEVNET.chainId,
    sender: relay,
    nonceKeys: [BigInt(p.nullifierHash)],
    nonceSeq: 0n,
    signatures: [],
    // max_cost + refund <= fee, so the cap is taken from what is left of the fee after the refund.
    fees: { maxFeePerGas: o.maxFeePerGas ?? (EXIT_FEE - refund) / budget, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? 10n ** 9n },
    frames: [
      frame(profile, "VERIFY", { target: EXPIRY_VERIFIER, execution: 10_000n, data: toHex(BigInt(deadline), { size: 8 }) }),
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", target: relay, execution: 450_000n, data: verifyData }),
      frame(profile, "SENDER", {
        target: o.pool ?? DEVNET.pool,
        execution: 1_000_000n,
        state: refund === 0n ? 300_000n : 500_000n,
        value: refund,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "withdraw",
          args: [p.proof, p.root, p.nullifierHash, p.recipient, relay, p.fee, refund],
        }),
      }),
    ],
  });
}

export function exitTx(p: WithdrawProof & { rootIdx: number }, o: ExitOpts & { exitRelay: Address }): FrameTx {
  return buildExit(p, o.exitRelay, encodeAbiParameters([{ type: "uint256" }], [BigInt(p.rootIdx)]), o);
}

/** ExitRelayRR's namespace in the EIP-8272 predeploy: keccak256(abi.encodePacked(relay, bytes32(0))). */
export const rootSourceOf = (exitRelayRR: Address): Hex => keccak256(encodePacked(["address", "bytes32"], [exitRelayRR, zeroHash]));

/** ExitRelayRR exit: frame 1 carries one ignored byte; the root comes from the one recent-root reference (r13 §5). */
export function exitTxRR(p: WithdrawProof & { rootSlot: bigint }, o: ExitOpts & { exitRelayRR: Address }): FrameTx {
  // One byte, not "0x": empty calldata routes to receive(), which returns without APPROVE.
  const tx = buildExit(p, o.exitRelayRR, "0x00", o);
  // newTx defaults this field to []; the 1337 codec encodes it as the envelope's last field.
  tx.recentRootReferences = [{ sourceId: rootSourceOf(o.exitRelayRR), slot: p.rootSlot, root: p.root }];
  return tx;
}
