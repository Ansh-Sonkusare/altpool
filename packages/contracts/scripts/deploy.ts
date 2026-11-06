// Deploys a fresh ExitRelay on the public devnet, funds its float, stakes it, and writes deployments.json.
// Fresh per run on purpose (docs/03): a new address dodges the gateway's opsIncluded = 0 throttle.
// ExitRelay verifies against a patched copy of the pool's verifier (see src/verifier-patch.ts); the pool keeps its own.
// `--rr` deploys ExitRelayRR (recent-root VERIFY) the same way and merges its keys into the existing deployments.json.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";
import { EXIT_FEE } from "../src/exit";
import { initcodeFor, patchVerifierRuntime } from "../src/verifier-patch";

const ENV = new URL("../.env", import.meta.url);
const RR = process.argv.includes("--rr");
const NAME = RR ? "ExitRelayRR" : "ExitRelay";
const ARTIFACT = new URL(`../out/${NAME}.sol/${NAME}.json`, import.meta.url);
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);
const G1_PROOF = new URL("../../prover/artifacts/g1-proof.json", import.meta.url);
const FLOAT = parseEther("0.05");
const STAKE = parseEther("0.012"); // strictly above minStake 0.01
const MIN_BALANCE = parseEther("0.2");

function deployerKey(): Hex {
  const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const found = env.match(/^DEPLOYER_PK=(0x[0-9a-fA-F]{64})\s*$/m)?.[1] as Hex | undefined;
  if (found) return found;
  const pk = generatePrivateKey();
  appendFileSync(ENV, `${env && !env.endsWith("\n") ? "\n" : ""}DEPLOYER_PK=${pk}\n`);
  console.log(`generated DEPLOYER_PK into packages/contracts/.env`);
  return pk;
}

if (!existsSync(ARTIFACT)) throw new Error("no forge artifact: run `bun run --filter @altpool/contracts abi` first");
const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const account = privateKeyToAccount(deployerKey());
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const balance = () => pub.getBalance({ address: account.address });

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r;
}

if ((await balance()) < MIN_BALANCE) {
  console.log(`funding ${account.address} from the faucet`);
  console.log(`faucet ${JSON.stringify(await gateway().faucet(account.address))}`);
  for (let i = 0; i < 60 && (await balance()) < MIN_BALANCE; i++) await sleep(2000);
}
console.log(`deployer ${account.address} has ${formatEther(await balance())} ETH`);

const original = await pub.getCode({ address: DEVNET.verifier });
if (!original) throw new Error(`no code at verifier ${DEVNET.verifier}`);
const patchedRuntime = patchVerifierRuntime(original);
// No fixed gas: this devnet prices code deposit as state gas, so 2M ran out; viem estimates it.
const verifierTx = await wallet.sendTransaction({ data: initcodeFor(patchedRuntime), to: null, type: "legacy" });
const verifier = (await mined(verifierTx)).contractAddress!;
if ((await pub.getCode({ address: verifier }))?.toLowerCase() !== patchedRuntime.toLowerCase()) {
  throw new Error(`patched verifier ${verifier} runtime differs from the patch`);
}
console.log(`patched verifier ${verifier} (${verifierTx})`);

if (!existsSync(G1_PROOF)) throw new Error("no prover/artifacts/g1-proof.json: run `bun run --filter @altpool/prover g1` first");
const g1 = JSON.parse(readFileSync(G1_PROOF, "utf8"));
const verifierAbi = parseAbi(["function verifyProof(bytes proof, uint256[6] input) view returns (bool)"]);
const verdict = (address: Address, fee: bigint) =>
  pub.readContract({
    address,
    abi: verifierAbi,
    functionName: "verifyProof",
    args: [g1.proof, [BigInt(g1.root), BigInt(g1.nullifierHash), BigInt(g1.recipient), BigInt(g1.relayer), fee, 0n]],
  });
for (const [fee, want] of [[BigInt(g1.fee), true], [BigInt(g1.fee) + 1n, false]] as const) {
  const got = [await verdict(DEVNET.verifier, fee), await verdict(verifier, fee)];
  if (got.some((v) => v !== want)) throw new Error(`fee ${fee}: original ${got[0]}, patched ${got[1]}, want ${want}`);
}
console.log("patched verifier agrees with the original on the G1 proof (true, then false at fee + 1)");

// 18M gas: eth_estimateGas says ~14.85M (the HegotaSupport constructor CREATEs nine opcode helpers; RR adds the 0xB6 one).
const deployTx = await wallet.deployContract({
  abi: art.abi,
  bytecode: art.bytecode.object,
  args: [DEVNET.pool, verifier, EXIT_FEE],
  value: FLOAT,
  gas: 18_000_000n,
  type: "legacy",
});
const exitRelay = (await mined(deployTx)).contractAddress!;
console.log(`${NAME} ${exitRelay} (${deployTx}), float ${formatEther(FLOAT)} ETH`);

const stakedAt = await wallet.writeContract({
  address: exitRelay,
  abi: art.abi,
  functionName: "stake",
  args: [DEVNET.stakingRegistry, DEVNET.unstakeDelaySec],
  value: STAKE,
  gas: 300_000n,
  type: "legacy",
});
await mined(stakedAt);
const [stake] = await pub.readContract({
  address: DEVNET.stakingRegistry,
  abi: parseAbi(["function getDepositInfo(address) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)"]),
  functionName: "getDepositInfo",
  args: [exitRelay],
});
if (stake < STAKE) throw new Error(`stake not recorded for ${exitRelay}: ${stake}`);
console.log(`staked ${formatEther(stake)} ETH, unstake delay ${DEVNET.unstakeDelaySec}s (${stakedAt})`);

const deployments = RR
  ? {
      ...(existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : { chainId: DEVNET.chainId }),
      exitRelayRR: exitRelay,
      exitRelayRRDeployTx: deployTx,
      exitRelayRRStakedAt: stakedAt,
    }
  : { chainId: DEVNET.chainId, exitRelay, stakedAt, deployTx, verifier, verifierTx };
writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + "\n");
console.log("wrote packages/contracts/deployments.json");
