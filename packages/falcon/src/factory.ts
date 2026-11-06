// Off-chain mirror of FalconWalletFactory.predictAddress: no RPC, same CREATE2 inputs.
import { readFileSync } from "node:fs";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, type Address, type Hex } from "viem";
import { pkHashOf } from "./falcon";

const walletInitCode = (verifier: Address, pkHash: Hex): Hex => {
  const art = JSON.parse(readFileSync(new URL("../out/FalconWallet.sol/FalconWallet.json", import.meta.url), "utf8"));
  return concatHex([art.bytecode.object, encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [verifier, pkHash])]);
};

/** The address FalconWalletFactory(factory, verifier) gives the wallet for this Falcon public key. Needs `forge build`. */
export function predictWalletAddress(o: { factory: Address; verifier: Address; publicKey: Uint8Array }): Address {
  const pkHash = pkHashOf(o.publicKey);
  return getContractAddress({ opcode: "CREATE2", from: o.factory, salt: pkHash, bytecodeHash: keccak256(walletInitCode(o.verifier, pkHash)) });
}
