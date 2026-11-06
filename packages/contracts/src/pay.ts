// The one place the 9-frame Pledge Paid transaction is laid out. PayRelayWETH.sol (PayChecks) pins these modes, flags,
// calldata and, as floors, these limits.
import {
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { frame, newTx, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, type WithdrawProof } from "@altpool/core";
import { EXIT_FEE } from "./exit";

export type Terms = { invoiceId: bigint; book: Address; amount: bigint; maxIn: bigint; change: Address };

const termsType = [
  {
    type: "tuple",
    components: [
      { name: "invoiceId", type: "uint256" },
      { name: "book", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "maxIn", type: "uint256" },
      { name: "change", type: "address" },
    ],
  },
] as const;

export const settlerAbi = parseAbi([
  "function unwrap()",
  "function swap()",
  "function sweep()",
  "function assertSettled() view",
  "function refund()",
  "function invoiceId() view returns (uint256)",
]);
export const settlerFactoryAbi = parseAbi([
  "function deploy((uint256 invoiceId, address book, uint256 amount, uint256 maxIn, address change) t) returns (address)",
  "function addressOf((uint256 invoiceId, address book, uint256 amount, uint256 maxIn, address change) t) view returns (address)",
  "function settlerCodeHash() view returns (bytes32)",
]);
export const invoiceBookAbi = parseAbi([
  "function create(address payee, address token, uint256 amount) returns (uint256)",
  "function settle(uint256 id, address from)",
  "function paid(uint256 id) view returns (bool)",
  "function invoices(uint256 id) view returns (address payee, address token, uint256 amount, bool paid)",
  "event Created(uint256 indexed id, address indexed payee, address token, uint256 amount)",
  "event Paid(uint256 indexed id, address indexed from)",
]);
const poolAbi = parseAbi([
  "function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable",
]);

/** CREATE2(factory, keccak256(abi.encode(terms)), settlerCodeHash): the withdraw proof's recipient. */
export const settlerAddress = (factory: Address, settlerCodeHash: Hex, t: Terms): Address =>
  getContractAddress({ opcode: "CREATE2", from: factory, salt: keccak256(encodeAbiParameters(termsType, [t])), bytecodeHash: settlerCodeHash });

const EXPIRY_VERIFIER: Address = "0x0000000000000000000000000000000000008141";
const DEADLINE_GRID_SEC = 600;
const ATOMIC = 0x4;
/** PayChecks.PAY_VERIFY_GAS_MAX. */
const VERIFY_GAS = 600_000n;
// Frames 3..8, [execution, state]; PayChecks.floors() requires at least these. Frame 3's state pays the Settler's code
// deposit (EIP-8037: ~6.8 KB unoptimized via-IR runtime x 1530 + the 183,600 account).
const BATCH_LIMITS: [bigint, bigint][] = [
  [400_000n, 11_000_000n],
  [100_000n, 100_000n],
  [400_000n, 400_000n],
  [150_000n, 300_000n],
  // sweep pays a fresh account: it used 13,037 but halted at a 100k limit and passed at 300k (simulated, cause not traced).
  [300_000n, 200_000n],
  [100_000n, 0n],
];
/** Every frame limit plus intrinsic gas (ethrex: 12,000 + 475 per frame + calldata, ~30k here) with margin;
 *  maxFeePerGas = fee / budget keeps max_cost <= fee. */
const PAY_GAS_BUDGET = 10_000n + VERIFY_GAS + 1_300_000n + BATCH_LIMITS.reduce((s, [g, st]) => s + g + st, 0n) + 60_000n;

type PayOpts = {
  payRelay: Address;
  pool: Address;
  factory: Address;
  settlerCodeHash: Hex;
  terms: Terms;
  nonceSeq?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nowSec?: number;
};

export function payTx(p: WithdrawProof & { rootIdx: number }, o: PayOpts): FrameTx {
  const settler = settlerAddress(o.factory, o.settlerCodeHash, o.terms);
  if (!isAddressEqual(p.recipient, settler)) throw new Error(`proof recipient ${p.recipient} is not the terms' Settler ${settler}`);
  if (!isAddressEqual(p.relayer, o.payRelay)) throw new Error(`proof relayer ${p.relayer} is not ${o.payRelay}`);
  if ((p.refund ?? 0n) !== 0n) throw new Error("PayRelayWETH requires refund 0");
  const profile = getProfile(DEVNET.profile);
  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  const deadline = Math.ceil((now + DEADLINE_GRID_SEC) / DEADLINE_GRID_SEC) * DEADLINE_GRID_SEC;
  const call = (i: number, mode: "DEFAULT" | "SENDER", target: Address, data: Hex) =>
    frame(profile, mode, { target, data, execution: BATCH_LIMITS[i]![0], state: BATCH_LIMITS[i]![1], flags: i === 5 ? 0 : ATOMIC });
  const s = (fn: "unwrap" | "swap" | "sweep" | "assertSettled") => encodeFunctionData({ abi: settlerAbi, functionName: fn });
  return newTx({
    chainId: DEVNET.chainId,
    sender: o.payRelay,
    nonceKeys: [BigInt(p.nullifierHash)],
    nonceSeq: o.nonceSeq ?? 0n,
    signatures: [],
    fees: { maxFeePerGas: o.maxFeePerGas ?? EXIT_FEE / PAY_GAS_BUDGET, maxPriorityFeePerGas: o.maxPriorityFeePerGas ?? 10n ** 6n },
    frames: [
      frame(profile, "VERIFY", { target: EXPIRY_VERIFIER, execution: 10_000n, data: toHex(BigInt(deadline), { size: 8 }) }),
      frame(profile, "VERIFY", {
        scope: "EXECUTION_AND_PAYMENT",
        target: o.payRelay,
        execution: VERIFY_GAS,
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(p.rootIdx)]),
      }),
      frame(profile, "SENDER", {
        target: o.pool,
        execution: 1_000_000n,
        state: 300_000n,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "withdraw",
          args: [p.proof, p.root, p.nullifierHash, settler, o.payRelay, p.fee, 0n],
        }),
      }),
      call(0, "DEFAULT", o.factory, encodeFunctionData({ abi: settlerFactoryAbi, functionName: "deploy", args: [o.terms] })),
      call(1, "SENDER", settler, s("unwrap")),
      call(2, "SENDER", settler, s("swap")),
      call(3, "SENDER", o.terms.book, encodeFunctionData({ abi: invoiceBookAbi, functionName: "settle", args: [o.terms.invoiceId, settler] })),
      call(4, "SENDER", settler, s("sweep")),
      call(5, "DEFAULT", settler, s("assertSettled")),
    ],
  });
}
