// Live devnet check: both endpoints answer for chain 1337.
import { DEVNET, ethrex, gateway } from "../src";

const gw = gateway();
const node = ethrex();
const [gwChain, nodeChain, info] = await Promise.all([gw.call("eth_chainId"), node.call("eth_chainId"), gw.explorerInfo()]);
const ok = Number(gwChain) === DEVNET.chainId && Number(nodeChain) === DEVNET.chainId && info.chainId === DEVNET.chainId;
console.log({ gateway: gw.url, ethrex: node.url, gwChain: Number(gwChain), nodeChain: Number(nodeChain), sidecar: info.version, block: Number(await node.call("eth_blockNumber")) });
if (!ok) { console.error("SMOKE FAILED: chain id mismatch"); process.exit(1); }
console.log("smoke ok");
