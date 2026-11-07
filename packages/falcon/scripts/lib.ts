// Shared by falcon-smoke.ts and falcon-recipient.ts: a persisted fresh key, faucet funding, deploys, the shared verifier.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway } from "@altpool/core";

const ENV = new URL("../.env", import.meta.url);
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);

// Long timeout: the devnet has been answering in 10-30 s per call.
export const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 90_000, retryCount: 3 }) });

/** NAME from the gitignored packages/falcon/.env, or a new one written there. Never a published devnet key. */
export function persistedKey(name: string): Hex {
  const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const found = env.match(new RegExp(`^${name}=(0x[0-9a-fA-F]+)\\s*$`, "m"))?.[1];
  if (found) return found as Hex;
  const pk = generatePrivateKey();
  appendFileSync(ENV, `${env && !env.endsWith("\n") ? "\n" : ""}${name}=${pk}\n`);
  return pk;
}

export function persistEnv(name: string, value: string) {
  appendFileSync(ENV, `${existsSync(ENV) && !readFileSync(ENV, "utf8").endsWith("\n") ? "\n" : ""}${name}=${value}\n`);
}
export const readEnv = (name: string) => (existsSync(ENV) ? readFileSync(ENV, "utf8").match(new RegExp(`^${name}=(\\S+)\\s*$`, "m"))?.[1] : undefined);

export async function fund(address: Address, min: bigint) {
  if ((await pub.getBalance({ address })) >= min) return;
  console.log(`faucet ${address}: ${JSON.stringify(await gateway().faucet(address))}`);
  for (let i = 0; i < 60 && (await pub.getBalance({ address })) < min; i++) await sleep(2000);
  if ((await pub.getBalance({ address })) < min) throw new Error(`${address} not funded`);
}

export const artifact = (name: string): { abi: Abi; bytecode: Hex } => {
  const a = JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
};

export async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return r;
}

export function deployer() {
  const account = privateKeyToAccount(persistedKey("FALCON_DEPLOYER_PK"));
  return { account, wallet: createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) }) };
}

export type Deployments = { verifier?: Address; verifierTx?: Hex; factory?: Address; factoryTx?: Hex };
export const readDeployments = (): Deployments => (existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {});
export const writeDeployments = (d: Deployments) => writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");

/** The shared ZKNOX_falcon verifier: deployed once, address kept in deployments.json. */
export async function sharedVerifier(wallet: ReturnType<typeof deployer>["wallet"]): Promise<Address> {
  const d = readDeployments();
  if (d.verifier && (await pub.getCode({ address: d.verifier }))) return d.verifier;
  const { abi, bytecode } = artifact("ZKNOX_falcon");
  // 10.5 KB of code: state gas for code deposit (1530/byte) dominates, so give it room and let the receipt say.
  const hash = await wallet.deployContract({ abi, bytecode, gas: 18_000_000n, type: "legacy" });
  const r = await mined(hash);
  console.log(`ZKNOX_falcon verifier ${r.contractAddress} (${hash}) gasUsed ${r.gasUsed}`);
  writeDeployments({ ...d, verifier: r.contractAddress!, verifierTx: hash });
  return r.contractAddress!;
}

export const eth = (v: bigint) => `${formatEther(v)} ETH`;
export { parseEther };
