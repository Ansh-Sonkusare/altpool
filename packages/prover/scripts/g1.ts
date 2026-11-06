// Gate G1: an offline one-leaf proof verifies on the devnet Verifier (true), and fails at fee + 1 (false).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAddress, generatePrivateKey } from "viem/accounts";
import { DEVNET, altDevnet } from "@altpool/core";
import { createNote, pathFor, proveWithPath } from "../src/index";

const note = createNote();
const path = pathFor([BigInt(note.commitment)], 0);
const to = { recipient: privateKeyToAddress(generatePrivateKey()), relayer: "0x000000000000000000000000000000000000dEaD" as const, fee: 10n ** 16n };
console.time("prove");
const p = proveWithPath(note, path, to);
console.timeEnd("prove");
writeFileSync(fileURLToPath(new URL("../artifacts/g1-proof.json", import.meta.url)), JSON.stringify(p, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const client = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl) });
const verify = (fee: bigint) =>
  client.readContract({
    address: DEVNET.verifier,
    abi: parseAbi(["function verifyProof(bytes proof, uint256[6] input) view returns (bool)"]),
    functionName: "verifyProof",
    args: [p.proof, [BigInt(p.root), BigInt(p.nullifierHash), BigInt(p.recipient), BigInt(p.relayer), fee, p.refund]],
  });

const ok = await verify(p.fee);
console.log(`G1 ${ok}`);
const tampered = await verify(p.fee + 1n);
console.log(`G1 ${tampered}`);
process.exit(ok === true && tampered === false ? 0 : 1);
