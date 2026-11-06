// The one place the 3-frame ExitRelay transaction is laid out. ExitRelay.sol pins these limits and offsets.
import { encodeAbiParameters, encodeFunctionData, isAddressEqual, parseAbi, toHex, type Address } from "viem";
import { frame, newTx, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, type WithdrawProof } from "@altpool/core";

export const EXIT_FEE = 10n ** 16n;
// Upper bound on total_gas_limit: 1.71M of frame gas plus intrinsic/calldata. ExitRelay requires
// max_cost = maxFeePerGas * total_gas_limit <= EXIT_FEE, so the fee cap is derived from this budget.
const EXIT_GAS_BUDGET = 1_800_000n;
export const EXIT_MAX_FEE_PER_GAS = EXIT_FEE / EXIT_GAS_BUDGET;

const EXPIRY_VERIFIER: Address = "0x0000000000000000000000000000000000008141";
const DEADLINE_GRID_SEC = 600;
const poolAbi = parseAbi([
  "function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable",
]);

export function exitTx(
  p: WithdrawProof & { rootIdx: number },
  o: { exitRelay: Address; pool?: Address; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; nowSec?: number },
): FrameTx {
  if (!isAddressEqual(p.relayer, o.exitRelay)) throw new Error(`proof relayer ${p.relayer} is not exitRelay ${o.exitRelay}`);
  const profile = getProfile(DEVNET.profile);
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  // A coarse grid so the deadline does not fingerprint the moment the user sent.
  const deadline = Math.ceil((now + DEADLINE_GRID_SEC) / DEADLINE_GRID_SEC) * DEADLINE_GRID_SEC;
  return newTx({
    chainId: DEVNET.chainId,
    sender: o.exitRelay,
    nonceKeys: [BigInt(p.nullifierHash)],
    nonceSeq: 0n,
    signatures: [],
    fees: { maxFeePerGas: o.maxFeePerGas ?? EXIT_MAX_FEE_PER_GAS, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? 10n ** 9n },
    frames: [
      frame(profile, "VERIFY", { target: EXPIRY_VERIFIER, execution: 10_000n, data: toHex(BigInt(deadline), { size: 8 }) }),
      frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT",
        target: o.exitRelay,
        execution: 450_000n,
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(p.rootIdx)]),
      }),
      frame(profile, "SENDER", {
        target: o.pool ?? DEVNET.pool,
        execution: 1_000_000n,
        state: 250_000n,
        value: 0n,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "withdraw",
          args: [p.proof, p.root, p.nullifierHash, p.recipient, o.exitRelay, p.fee, 0n],
        }),
      }),
    ],
  });
}
