// Deploys a fresh ExitRelay on the public devnet, funds its float, stakes it, and writes deployments.json.
// Fresh per run on purpose (docs/03): a new address dodges the gateway's opsIncluded = 0 throttle.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";
import { EXIT_FEE } from "../src/exit";

const ENV = new URL("../.env", import.meta.url);
const ARTIFACT = new URL("../out/ExitRelay.sol/ExitRelay.json", import.meta.url);
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);
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

// 18M gas: eth_estimateGas says ~14.85M (the HegotaSupport constructor CREATEs nine opcode helpers).
const deployTx = await wallet.deployContract({
  abi: art.abi,
  bytecode: art.bytecode.object,
  args: [DEVNET.pool, DEVNET.verifier, EXIT_FEE],
  value: FLOAT,
  gas: 18_000_000n,
  type: "legacy",
});
const exitRelay = (await mined(deployTx)).contractAddress!;
console.log(`ExitRelay ${exitRelay} (${deployTx}), float ${formatEther(FLOAT)} ETH`);

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

writeFileSync(DEPLOYMENTS, JSON.stringify({ chainId: DEVNET.chainId, exitRelay, stakedAt, deployTx }, null, 2) + "\n");
console.log("wrote packages/contracts/deployments.json");
