// Shared by deploy.ts and deploy-weth-pool.ts: the deployer key, its faucet top-up, and read-modify-write of deployments.json.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { formatEther, type Account, type Hex, type PublicClient } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { gateway } from "@altpool/core";

const ENV = new URL("../.env", import.meta.url);
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);

export function deployerKey(): Hex {
  const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const found = env.match(/^DEPLOYER_PK=(0x[0-9a-fA-F]{64})\s*$/m)?.[1] as Hex | undefined;
  if (found) return found;
  const pk = generatePrivateKey();
  appendFileSync(ENV, `${env && !env.endsWith("\n") ? "\n" : ""}DEPLOYER_PK=${pk}\n`);
  console.log(`generated DEPLOYER_PK into packages/contracts/.env`);
  return pk;
}

export async function ensureFunded(pub: PublicClient, account: Account, min: bigint): Promise<void> {
  const balance = () => pub.getBalance({ address: account.address });
  if ((await balance()) < min) {
    console.log(`funding ${account.address} from the faucet`);
    console.log(`faucet ${JSON.stringify(await gateway().faucet(account.address))}`);
    for (let i = 0; i < 60 && (await balance()) < min; i++) await sleep(2000);
  }
  console.log(`deployer ${account.address} has ${formatEther(await balance())} ETH`);
}

export const readDeployments = (): Record<string, unknown> | undefined =>
  existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : undefined;

/** Adds `patch` to the existing deployments.json, never dropping keys. */
export function mergeDeployments(patch: Record<string, unknown>, base: Record<string, unknown> = readDeployments() ?? {}): void {
  writeFileSync(DEPLOYMENTS, JSON.stringify({ ...base, ...patch }, null, 2) + "\n");
  console.log("wrote packages/contracts/deployments.json");
}
