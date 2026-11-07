// Gate 0: does SIGDATACOPY work on ERC8421_WORKSHOP, does TXPARAM(SIG_HASH) equal the codec's sigHash(), and what do
// SIGPARAM(MSG) / RESOLVED_SIGNER return for an ARBITRARY entry with msg = "0x"? Live, via ethrex_simulateFrameTransaction.
// One opcode read per simulation (Gate0Probe calldata byte 0), so a halt is pinned to one read. `PROBE=0x..` reuses a probe.
import { concat, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeTx, frame, newTx, sigHash, sigScheme, signTx, secp256k1Placeholder, type FrameTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, ethrex } from "@altpool/core";
import { artifact, decodeRevert, deploy, envKey, fund, pub } from "./lib";

const profile = getProfile(DEVNET.profile);
const pk = envKey("DEPLOYER_PK");
const deployer = privateKeyToAccount(pk).address;
await fund(deployer, 10n ** 17n);
const probe = (process.env.PROBE as Address | undefined) ?? (await deploy(pk, "Gate0Probe", [], 10n ** 16n)).address;
const abi = artifact("Gate0Probe").abi;
const SIG: Hex = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
const READS = ["SIG_HASH", "SIGNATURE_COUNT", "RESOLVED_SIGNER", "SCHEME", "MSG", "SIGNATURE_LENGTH", "SIGDATACOPY", "NONCE", "MAX_COST", "CURRENT_FRAME_INDEX"];
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? toHex(x) : x));

async function read(sigs: FrameTx["signatures"], what: number, o: { sig?: number; len?: number; sign?: Hex } = {}) {
  const nonce = BigInt(await pub.getTransactionCount({ address: probe }));
  let tx = newTx({
    chainId: DEVNET.chainId, sender: probe, nonceSeq: nonce, signatures: sigs,
    fees: { maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n },
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: 90_000n, data: concat([toHex(what, { size: 1 }), toHex(o.sig ?? 0, { size: 1 }), toHex(o.len ?? 65, { size: 2 })]) }),
      frame(profile, "SENDER", { target: deployer, execution: 30_000n, value: 1n }),
    ],
  });
  if (o.sign) tx = await signTx(profile, tx, o.sign, 0);
  const r: any = await ethrex().call("ethrex_simulateFrameTransaction", [encodeTx(profile, tx), "latest", {}]);
  const err = decodeRevert(abi, r.revertData);
  let out = err ? `${show(err.args)} (public verdict: ${r.canonicalMempoolViolation ?? "valid"})` : `revertData=${r.revertData ?? "-"} violation=${r.canonicalMempoolViolation} halt=${r.haltReason ?? "-"} ${r.haltDetail ?? ""}`;
  if (what === 0 && err) out += (toHex((err.args as bigint[])[1]!, { size: 32 }) === sigHash(profile, tx) ? "  == codec sigHash()" : `  != codec sigHash() ${sigHash(profile, tx)}`);
  console.log(`  ${READS[what]}${o.sig ? `[${o.sig}]` : ""}${what === 6 ? ` len ${o.len ?? 65}` : ""}: ${out}`);
  return { r, tx };
}

const ARB = sigScheme(profile, "ARBITRARY");
const arb = (msg: Hex = "0x"): FrameTx["signatures"][number] => ({ scheme: ARB, signer: "0x", msg, signature: SIG });
console.log(`probe ${probe}`);
console.log("\nARBITRARY entry, signer 0x, msg 0x, 65-byte signature:");
for (const w of [0, 1, 2, 3, 4, 5, 7]) await read([arb()], w);
for (const len of [0, 32, 65]) await read([arb()], 6, { len });
console.log("\nARBITRARY entry, msg = 32 bytes 0xab:");
for (const w of [0, 4, 5]) await read([arb(`0x${"ab".repeat(32)}`)], w);
await read([arb(`0x${"ab".repeat(32)}`)], 6, { len: 65 });
console.log("\nSECP256K1 entry 0 (signed by the deployer key), ARBITRARY entry 1:");
const k1 = { ...secp256k1Placeholder(profile, deployer), signature: "0x" as Hex };
for (const w of [2, 3, 4, 5]) await read([k1, arb()], w, { sign: pk });
await read([k1, arb()], 6, { sig: 1, len: 65, sign: pk });
console.log("\nno signatures:");
await read([], 0);

console.log("\nMAX_COST vs the simulator's maxCost, and CURRENT_FRAME_INDEX:");
for (const w of [8, 9]) {
  const { r, tx } = await read([arb()], w);
  const limits = tx.frames.reduce((s, f) => s + f.limits.execution + f.limits.state, 0n);
  console.log(`    simulate maxCost ${r.maxCost}; frame limits ${limits} x maxFeePerGas ${tx.fees.maxFeePerGas} = ${toHex(limits * tx.fees.maxFeePerGas)}`);
}
console.log("\nSECP256K1 entry 0 by the deployer key (signer != sender), ARBITRARY entry 1, SIGDATACOPY of entry 1:");
await read([k1, arb()], 6, { sig: 1, len: 65, sign: pk }).catch((e) => console.log(e));
