// Deploys a second Tornado pool on the devnet: tornado-core v2.0 ERC20Tornado over the predeployed WETH9, same 0.1
// denomination, 20 levels, and the same original verifier and MiMC hasher as the ETH pool. Merges `wethPool` into
// deployments.json. Needs `forge build --profile tornado` first (solc 0.5.17, see foundry.toml).
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeDeployData, getAddress, http, parseEther, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet } from "@altpool/core";
import { WETH9, erc20PoolAbi } from "../src/pools";
import { deployerKey, ensureFunded, mergeDeployments } from "./deployer";

const ARTIFACT = new URL("../out/tornado/ERC20Tornado.sol/ERC20Tornado.json", import.meta.url);
const EMPTY_ROOT: Hex = "0x29d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4";

if (!existsSync(ARTIFACT)) throw new Error("no tornado artifact: run `forge build --profile tornado` in packages/contracts first");
const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const account = privateKeyToAccount(deployerKey());
const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
await ensureFunded(pub, account, parseEther("0.2"));

// WETH9, the hasher and the verifier must exist.
for (const [name, address] of [["WETH9", WETH9], ["hasher", DEVNET.hasher], ["verifier", DEVNET.verifier]] as const) {
  if (!(await pub.getCode({ address }))) throw new Error(`no code at ${name} ${address}`);
}
const probe = [123456789n, 987654321n] as const;
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hashOn = (address: Hex) =>
  pub.readContract({ address, abi: erc20PoolAbi, functionName: "hashLeftRight", args: [word(probe[0]), word(probe[1])] });
const ethPoolHash = await hashOn(DEVNET.pool);

// The only external dependency is the linked library `Hasher`: put the predeployed hasher at its placeholder.
const placeholders = new Set<string>(art.bytecode.object.match(/__\$[0-9a-f]{34}\$__/g) ?? []);
if (placeholders.size !== 1) throw new Error(`expected exactly one library placeholder, found ${[...placeholders]}`);
const [placeholder] = placeholders;
const linked: Hex = art.bytecode.object.replaceAll(placeholder, DEVNET.hasher.slice(2).toLowerCase());
if (/__\$/.test(linked)) throw new Error("unlinked placeholder left in bytecode");

// operator = 0: v2.0's operator can swap the verifier, and nobody should hold that.
const args = [DEVNET.verifier, DEVNET.denomination, DEVNET.treeLevels, zeroAddress, WETH9] as const;
// The constructor runs ~2 MiMC hashes per level and writes 41 slots; this devnet prices new slots as state gas.
const estimate = await pub.estimateGas({ account, data: encodeDeployData({ abi: art.abi, bytecode: linked, args: [...args] }) }).catch(() => 0n);
const gas = estimate ? (estimate * 13n) / 10n : 30_000_000n;
console.log(`deploy gas estimate ${estimate || "unavailable"}, limit ${gas}`);
const wethPoolTx = await wallet.deployContract({ abi: art.abi, bytecode: linked, args: [...args], gas, type: "legacy" });
const receipt = await pub.waitForTransactionReceipt({ hash: wethPoolTx, timeout: 180_000 });
if (receipt.status !== "success") throw new Error(`deploy ${wethPoolTx} reverted`);
const wethPool = receipt.contractAddress!;
console.log(`ERC20Tornado ${wethPool} (${wethPoolTx}), gasUsed ${receipt.gasUsed}`);

const read = (functionName: "denomination" | "token" | "verifier" | "operator" | "levels" | "getLastRoot") =>
  pub.readContract({ address: wethPool, abi: erc20PoolAbi, functionName });
const checks: [string, unknown, unknown][] = [
  ["denomination()", await read("denomination"), DEVNET.denomination],
  ["token()", getAddress(String(await read("token"))), getAddress(WETH9)],
  ["verifier()", getAddress(String(await read("verifier"))), getAddress(DEVNET.verifier)],
  ["operator()", getAddress(String(await read("operator"))), zeroAddress],
  ["levels()", Number(await read("levels")), DEVNET.treeLevels],
  ["getLastRoot() (empty tree)", await read("getLastRoot"), EMPTY_ROOT],
];
for (const [name, got, want] of checks) {
  if (got !== want) throw new Error(`${name}: got ${got}, want ${want}`);
  console.log(`verified ${name} = ${got}`);
}
const poolHash = await hashOn(wethPool);
if (poolHash !== ethPoolHash) throw new Error(`hashLeftRight differs from the ETH pool: ${poolHash} vs ${ethPoolHash}`);
console.log("verified hashLeftRight(wethPool) == hashLeftRight(ETH pool)");

mergeDeployments({ wethPool, wethPoolTx });
