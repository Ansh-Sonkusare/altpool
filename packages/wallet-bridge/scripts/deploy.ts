// Deploys a BridgeAccount for an owner and funds it through the creation value; merges it into deployments.json.
//   bun scripts/deploy.ts                 owner = OWNER_PK from .env (generated: the smoke test's stand-in wallet)
//   bun scripts/deploy.ts --owner 0xABC   owner = a MetaMask/Rabby address (for the web demo)
// Validation needs no stake (immutables + ecrecover only), so there is no stake step.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatEther, getAddress, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEVNET, explorerTx } from "@altpool/core";
import { deploy, envKey, fund, pub } from "./lib";

const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);
const FLOAT = parseEther(process.env.FLOAT ?? "0.05");
const i = process.argv.indexOf("--owner");
const owner: Address = i > 0 ? getAddress(process.argv[i + 1]!) : privateKeyToAccount(envKey("OWNER_PK")).address;

const pk = envKey("DEPLOYER_PK");
await fund(privateKeyToAccount(pk).address, FLOAT + parseEther("0.05"));
const { address, hash } = await deploy(pk, "BridgeAccount", [owner], FLOAT);
const nonce = await pub.getTransactionCount({ address });
console.log(`BridgeAccount ${address} owner ${owner}, balance ${formatEther(await pub.getBalance({ address }))} ETH, nonce ${nonce}`);
console.log(`deploy ${explorerTx(hash)}`);

const d = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : { chainId: DEVNET.chainId, accounts: {} };
d.accounts[owner] = { address, deployTx: hash, deployedAt: new Date().toISOString() };
writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
console.log("wrote packages/wallet-bridge/deployments.json");
