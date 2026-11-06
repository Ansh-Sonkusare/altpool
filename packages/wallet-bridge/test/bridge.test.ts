// Contract-shape checks that need no chain. EIP-712 digest parity against the deployed contract runs live in
// scripts/smoke.ts (eth_call), and the pure-logic vectors in test/BridgeLib.t.sol (forge).
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, stringToHex, toFunctionSelector, type AbiFunction } from "viem";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { bridgeAccount, frameTxTypes, sessionTypes } from "altpool";
import { bridgeAccountAbi, bridgeAccountBytecode, VERIFY_TAGS } from "../src/index";

const ACCOUNT = "0x9f1331A6E016620Bab4674ECf3e233E72A92862a";
const TO = "0x23864f6a599992d1964F3988ddE398F989D134A0";

describe("BridgeAccount artifact", () => {
  it("has no public selector that a VERIFY tag could hit", () => {
    const selectors = bridgeAccountAbi.filter((x) => x.type === "function").map((f) => toFunctionSelector(f as AbiFunction));
    for (const tag of Object.values(VERIFY_TAGS)) expect(selectors.some((s) => parseInt(s.slice(2, 4), 16) === tag)).toBe(false);
  });

  it("has a payable constructor (funding by creation value) and creation code", () => {
    expect(bridgeAccountAbi.find((x) => x.type === "constructor")).toMatchObject({ stateMutability: "payable" });
    expect(bridgeAccountBytecode.length).toBeGreaterThan(1000);
  });

  it("SDK typed-data types match the Solidity type strings", () => {
    const str = (name: string, fields: readonly { name: string; type: string }[]) => `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(str("FrameTx", frameTxTypes.FrameTx)).toBe("FrameTx(bytes32 sigHash,address to,uint256 value,uint256 nonce,uint256 frameCount,uint256 maxFeePerGas)");
    expect(str("Session", sessionTypes.Session)).toBe("Session(address key,uint64 validUntil,uint256 maxValuePerTx,uint256 maxCostPerTx,address target)");
  });

  it("SDK digests equal the vectors pinned in BridgeLib.t.sol", () => {
    const b = bridgeAccount({ address: ACCOUNT, owner: TO, profile });
    const domain = b.authorizeSession({ key: TO, validUntil: 0n, maxValuePerTx: 0n, maxCostPerTx: 0n, target: TO }).domain;
    expect(hashTypedData({ domain, types: frameTxTypes, primaryType: "FrameTx", message: { sigHash: keccak256(stringToHex("sighash")), to: TO, value: 1n, nonce: 8n, frameCount: 2n, maxFeePerGas: 20n } }))
      .toBe("0x0c72af2e71b16557ac3971beae261ff24978671eb2004e6441db4db457f00a7c");
    expect(hashTypedData(b.authorizeSession({ key: "0x5B4e79C0E4b5eeF465D7aF4D2Fb33E1c9680f7C5", validUntil: 1794002422n, maxValuePerTx: 1000n, maxCostPerTx: 10n ** 16n, target: TO })))
      .toBe("0x80f12ff8ad059c57795ed6001748ab0da947255decca3f4d1f962fb0ad2073d7");
  });
});
