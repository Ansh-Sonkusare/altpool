// Shared script plumbing: the fresh deployer key in .env, faucet funding, compiled artifacts, and contract deploys.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, decodeErrorResult, formatEther, http, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";

const ENV = new URL("../.env", import.meta.url);

/** A key from packages/wallet-bridge/.env (gitignored), generated on first use. Never the published devnet key. */
export function envKey(name: string): Hex {
  const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const found = env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]{64})\\s*$`, "m"))?.[1] as Hex | undefined;
  if (found) return found;
  const pk = generatePrivateKey();
  appendFileSync(ENV, `${env && !env.endsWith("\n") ? "\n" : ""}${name}=${pk}\n`);
  console.log(`generated ${name} into packages/wallet-bridge/.env`);
  return pk;
}

export const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000, retryCount: 5 }) });

export function walletFor(pk: Hex) {
  return createWalletClient({ account: privateKeyToAccount(pk), chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000, retryCount: 5 }) });
}

export async function fund(address: Hex, min: bigint) {
  if ((await pub.getBalance({ address })) >= min) return;
  console.log(`faucet ${address}: ${JSON.stringify(await gateway().faucet(address))}`);
  for (let i = 0; i < 60 && (await pub.getBalance({ address })) < min; i++) await sleep(2000);
  console.log(`${address} has ${formatEther(await pub.getBalance({ address }))} ETH`);
}

export interface Artifact { abi: Abi; bytecode: Hex; deployedBytecode: Hex }
export function artifact(name: string): Artifact {
  const f = new URL(`../out/${name}.json`, import.meta.url);
  if (!existsSync(f)) throw new Error(`no out/${name}.json: run \`bun run --filter @altpool/wallet-bridge build:sol\``);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** CREATE with `value` (funds the new account in the same tx). HegotaSupport's constructor CREATEs 7 helpers. */
export async function deploy(pk: Hex, name: string, args: unknown[], value = 0n) {
  const art = artifact(name);
  const wallet = walletFor(pk);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, value, type: "legacy" });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy ${hash} reverted`);
  console.log(`${name} ${r.contractAddress} deployed (${hash}, gasUsed ${r.gasUsed})`);
  return { address: r.contractAddress, hash, gasUsed: r.gasUsed };
}

/** The custom error inside revert data, decoded with `abi`, else undefined. */
export function decodeRevert(abi: Abi, data: string | undefined | null) {
  if (!data || data === "0x") return undefined;
  try { return decodeErrorResult({ abi, data: data as Hex }); } catch { return undefined; }
}
