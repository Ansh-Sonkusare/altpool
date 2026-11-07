// Live: spend from an already deployed, funded Falcon wallet whose secret key is in .env (FALCON_*_SK_*), through the
// SDK (falconAccount + sendFrameTransaction with prepare). Retries a spend whose first submit timed out or was dropped.
//   bun scripts/falcon-spend.ts <wallet address> [to] [value in ETH]
import { existsSync, readFileSync } from "node:fs";
import { getAddress, hexToBytes, isAddressEqual, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { altpoolActions, createAltMempoolClient } from "altpool";
import { DEVNET } from "@altpool/core";
import { falconKeyFromSecret } from "../src/falcon";
import { falconAccount } from "../src/account";
import { eth, pub } from "./lib";

const [walletArg, toArg, valueArg] = process.argv.slice(2);
if (!walletArg) throw new Error("usage: bun scripts/falcon-spend.ts <wallet address> [to] [value in ETH]");
const wallet = getAddress(walletArg);
const env = existsSync(new URL("../.env", import.meta.url)) ? readFileSync(new URL("../.env", import.meta.url), "utf8") : "";
const pq = [...env.matchAll(/^FALCON_\w+_SK_\w+=(0x[0-9a-fA-F]+)\s*$/gm)]
  .map((m) => falconAccount({ key: falconKeyFromSecret(hexToBytes(m[1] as Hex)) }))
  .find((a) => isAddressEqual(a.address, wallet));
if (!pq) throw new Error(`no Falcon key in packages/falcon/.env for ${wallet}`);
if (!(await pq.isDeployed(pub))) throw new Error(`${wallet} has no code: deploy it first (pq.deployCall())`);

const to = (toArg ? getAddress(toArg) : privateKeyToAccount(generatePrivateKey()).address) as Address;
const value = parseEther(valueArg ?? "0.01");
const before = await pub.getBalance({ address: wallet });
const nonce = await pq.getNonce(pub);
console.log(`wallet ${wallet}: ${eth(before)}, nonce ${nonce}; spending ${eth(value)} to ${to}`);

const sdk = pub.extend(altpoolActions({ sidecar: createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, profile: getProfile(DEVNET.profile), name: "miner" }), explorerUrl: DEVNET.explorerUrl }));
for (let attempt = 1; ; attempt++) {
  try {
    const sent = await sdk.altpool.sendFrameTransaction({ transaction: pq.buildTx({ nonce, to, value, maxFeePerGas: 2n * 10n ** 9n }), signer: pq.signer, prepare: true, mempool: "alt" });
    const g = sent.gas?.frames;
    console.log(`attempt ${attempt}: submitted ${sent.hash}; estimator measured VERIFY ${g?.[0]?.measured.execution}, SENDER ${g?.[1]?.measured.execution} (limit ${g?.[1]?.suggested.execution})`);
    const { receipt } = await sdk.altpool.waitForFrameTransactionReceipt({ hash: sent.hash, timeoutMs: 180_000 });
    const failed = receipt.frames.find((f) => f.status !== "success");
    if (failed) throw new Error(`spend frame ${failed.index} ${failed.status}`);
    console.log(`included in block ${receipt.blockNumber}: ${receipt.frames.map((f) => `frame ${f.index} ${f.status} exec ${f.gasUsed.execution} state ${f.gasUsed.state}`).join(", ")}`);
    break;
  } catch (e) {
    const m = (e as Error).message;
    // Nonce moved on: an earlier submit (one that timed out on our side) was included after all.
    if ((await pq.getNonce(pub)) > nonce) { console.log(`nonce ${nonce} already used: an earlier submit landed (${m.split("\n")[0]})`); break; }
    console.log(`attempt ${attempt} failed: ${m.split("\n")[0]}`);
    if (attempt >= 3) throw e;
  }
}
const got = await pub.getBalance({ address: to });
const after = await pub.getBalance({ address: wallet });
console.log(`${to} holds ${eth(got)}; wallet ${eth(before)} -> ${eth(after)}`);
if (got < value) throw new Error(`destination holds ${got}, want >= ${value}`);
console.log("FALCON SPEND PASSED");
