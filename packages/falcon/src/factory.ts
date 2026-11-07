// Off-chain mirror of FalconWalletFactory.predictAddress: no RPC, no fs, same CREATE2 inputs (browser-safe).
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, type Address, type Hex } from "viem";
import { pkHashOf } from "./falcon";
import { falconWalletCreationCode } from "./generated/bytecode";

const walletInitCode = (verifier: Address, pkHash: Hex): Hex =>
  concatHex([falconWalletCreationCode, encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [verifier, pkHash])]);

/** The address FalconWalletFactory(factory, verifier) gives the wallet for this Falcon public key. */
export function predictWalletAddress(o: { factory: Address; verifier: Address; publicKey: Uint8Array }): Address {
  const pkHash = pkHashOf(o.publicKey);
  return getContractAddress({ opcode: "CREATE2", from: o.factory, salt: pkHash, bytecodeHash: keccak256(walletInitCode(o.verifier, pkHash)) });
}
