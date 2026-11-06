// Writes test/vector.json: a Falcon key and a signature over a fixed digest in the wallet's encoding, for forge tests.
import { falconKeygen, falconSign, pkHashOf } from "../src/falcon";
import { writeFileSync } from "node:fs";
import { bytesToHex, keccak256, toHex } from "viem";

const key = falconKeygen();
const digest = keccak256(toHex("QuietSend falcon wallet vector"));
const sig = falconSign(digest, key);
writeFileSync(
  new URL("../test/vector.json", import.meta.url),
  JSON.stringify({ digest, pkHash: pkHashOf(key.publicKey), sig, publicKey: bytesToHex(key.publicKey) }, null, 2) + "\n",
);
console.log("wrote test/vector.json");
