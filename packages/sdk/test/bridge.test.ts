import { describe, expect, it } from "vitest";
import { createWalletClient, custom, decodeAbiParameters, hashTypedData, keccak256, toHex, stringToHex, isAddressEqual, recoverAddress, recoverTypedDataAddress, sliceHex, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import {
  BRIDGE_TAG, bridgeAccount, decodeTx, encodeSessionVerifyData, sessionTypes, sigHash, signFrameTransaction, typedDataSigner, txHash,
} from "../src/index";
import live from "./fixtures/bridge-live.json";

// Test-only keys derived from labels (never funded, never a published devnet key).
const ownerPk = keccak256(stringToHex("altpool bridge test owner"));
const sessionPk = keccak256(stringToHex("altpool bridge test session"));
const owner = privateKeyToAccount(ownerPk);
const account = "0x9f1331A6E016620Bab4674ECf3e233E72A92862a" as const;
const to = "0x23864f6a599992d1964F3988ddE398F989D134A0" as const;
const bridge = bridgeAccount({ address: account, owner: owner.address, profile });
const fees = { maxFeePerGas: 20n, maxPriorityFeePerGas: 1n };

describe("bridge: live fixtures (txs the devnet admitted and included)", () => {
  const liveBridge = bridgeAccount({ address: live.account as Hex, owner: live.owner as Hex, profile });

  it("Mode A: the ARBITRARY entry recovers the owner over the re-derived FrameTx typed data", async () => {
    const tx = decodeTx(profile, live.modeA.raw as Hex);
    expect(txHash(profile, tx)).toBe(live.modeA.hash);
    const entry = tx.signatures[0]!;
    expect(entry).toMatchObject({ scheme: 0, signer: "0x", msg: "0x" });
    expect(tx.frames[0]!.data).toBe(BRIDGE_TAG.owner);
    const td = liveBridge.typedDataFor(tx);
    expect(td.message.sigHash).toBe(sigHash(profile, tx));
    expect(td.message).toMatchObject({ to, value: 1n, frameCount: 2n });
    expect(await liveBridge.isOwnerSignature(tx, entry.signature)).toBe(true);
    // sigHash elides the entry's own bytes, so the signature does not change what it signed
    expect(liveBridge.typedDataFor(liveBridge.attachSignature(tx, `0x${"00".repeat(65)}`)).message.sigHash).toBe(td.message.sigHash);
  });

  it.each(live.modeB.map((t, i) => [i + 1, t] as const))("Mode B #%i: owner authorised the session, session key signed SIG_HASH", async (_, t) => {
    const tx = decodeTx(profile, t.raw as Hex);
    expect(txHash(profile, tx)).toBe(t.hash);
    expect(tx.frames.map((f) => f.mode)).toEqual([1, 1, 2]);
    expect(tx.frames[0]!.target?.toLowerCase()).toBe("0x0000000000000000000000000000000000008141");
    const data = tx.frames[1]!.data;
    expect(sliceHex(data, 0, 1)).toBe(BRIDGE_TAG.session);
    const [session, ownerSig] = decodeAbiParameters(
      [{ type: "tuple", components: sessionTypes.Session.map((f) => ({ name: f.name, type: f.type })) }, { type: "bytes" }],
      sliceHex(data, 1),
    ) as unknown as [{ key: Hex; validUntil: bigint; maxValuePerTx: bigint; maxCostPerTx: bigint; target: Hex }, Hex];
    expect(isAddressEqual(await recoverTypedDataAddress({ ...liveBridge.authorizeSession(session), signature: ownerSig }), live.owner as Hex)).toBe(true);
    const entry = tx.signatures[0]!;
    expect(entry.scheme).toBe(1);
    expect(entry.msg).toBe("0x");
    // codec layout v||r||s with v = 0/1
    const sig = entry.signature;
    const rsv = `0x${sig.slice(4)}${(parseInt(sig.slice(2, 4), 16) + 27).toString(16)}` as Hex;
    expect(isAddressEqual(await recoverAddress({ hash: sigHash(profile, tx), signature: rsv }), session.key)).toBe(true);
    expect(isAddressEqual(entry.signer as Hex, session.key)).toBe(true);
    // the expiry deadline is within the session
    expect(BigInt(tx.frames[0]!.data)).toBeLessThanOrEqual(session.validUntil);
  });
});

describe("bridge: Mode A building and signing", () => {
  it("builds [VERIFY self 0x01, SENDER...] with an ARBITRARY entry that names no signer", () => {
    const { tx, typedData } = bridge.buildTx({ calls: [{ to, value: 1n }, { to, value: 2n }], nonce: 8n, fees });
    expect(tx.frames.map((f) => [f.mode, f.flags, f.target])).toEqual([[1, 3, null], [2, 0, to], [2, 0, to]]); // null = tx.sender
    expect(tx.frames[0]!.limits.execution).toBe(40_000n);
    expect(tx.signatures).toEqual([{ scheme: 0, signer: "0x", msg: "0x", signature: `0x${"00".repeat(65)}` }]);
    expect(typedData.domain).toEqual({ name: "AltpoolBridge", version: "1", chainId: 1337, verifyingContract: account });
    expect(typedData.message).toEqual({ sigHash: sigHash(profile, tx), to, value: 1n, nonce: 8n, frameCount: 3n, maxFeePerGas: 20n });
  });

  it("typedDataSigner stores r||s||v as returned (no repack) via signFrameTransaction", async () => {
    const { tx, typedData } = bridge.buildTx({ calls: [{ to, value: 1n }], nonce: 8n, fees });
    const signed = await signFrameTransaction(profile, tx, typedDataSigner(owner, bridge));
    expect(signed.signatures[0]!.signature).toBe(await owner.signTypedData(typedData));
    expect(signed.signatures[0]!.signature.slice(-2)).toMatch(/1b|1c/);
    expect(await bridge.isOwnerSignature(signed, signed.signatures[0]!.signature)).toBe(true);
    expect(hashTypedData(bridge.typedDataFor(signed))).toBe(hashTypedData(typedData));
  });

  it("works over EIP-1193 eth_signTypedData_v4 (the JSON payload MetaMask receives)", async () => {
    const seen: string[] = [];
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        seen.push(method);
        if (method === "eth_signTypedData_v4") {
          const [from, payload] = params as [string, string];
          expect(from.toLowerCase()).toBe(owner.address.toLowerCase());
          const { domain, types, primaryType, message } = JSON.parse(payload);
          delete types.EIP712Domain;
          return owner.signTypedData({ domain, types, primaryType, message });
        }
        if (method === "eth_chainId") return "0x539";
        throw new Error(`unexpected ${method}`);
      },
    };
    const wallet = createWalletClient({ transport: custom(provider) });
    const { tx } = bridge.buildTx({ calls: [{ to, value: 1n }], nonce: 8n, fees });
    const signed = await signFrameTransaction(profile, tx, typedDataSigner(wallet, bridge, owner.address));
    expect(seen).toContain("eth_signTypedData_v4");
    expect(await bridge.isOwnerSignature(signed, signed.signatures[0]!.signature)).toBe(true);
  });

  it("any change to the tx changes what the owner must sign", async () => {
    const { tx } = bridge.buildTx({ calls: [{ to, value: 1n }], nonce: 8n, fees });
    const signed = await signFrameTransaction(profile, tx, typedDataSigner(owner, bridge));
    const sig = signed.signatures[0]!.signature;
    for (const changed of [{ ...signed, nonceSeq: 9n }, { ...signed, chainId: 1n }, { ...signed, frames: [signed.frames[0]!, { ...signed.frames[1]!, value: 2n }] }]) {
      expect(await bridge.isOwnerSignature(changed, sig)).toBe(false);
    }
  });

  it("rejects malformed signatures and txs without the Mode A layout", () => {
    const { tx } = bridge.buildTx({ calls: [{ to }], nonce: 0n, fees });
    expect(() => bridge.attachSignature(tx, "0x1234")).toThrow(/65-byte/);
    expect(() => bridge.typedDataFor({ ...tx, frames: [tx.frames[0]!] })).toThrow(/SENDER/);
    expect(() => bridge.buildTx({ calls: [], nonce: 0n, fees })).toThrow(/At least one call/);
  });
});

describe("bridge: Mode B building", () => {
  const key = privateKeyToAccount(sessionPk);
  const session = { key: key.address, validUntil: 2_000_000_000n, maxValuePerTx: 10n, maxCostPerTx: 10n ** 16n, target: to };

  it("lays out [VERIFY 0x8141 deadline, VERIFY self 0x02||session, SENDER...] and signs with the session key", async () => {
    const ownerSignature = await owner.signTypedData(bridge.authorizeSession(session));
    const tx = bridge.buildSessionTx({ session, ownerSignature, calls: [{ to, value: 3n }, { to }], nonce: 0n, nonceKey: 77n, deadline: 1_999_999_000n, fees });
    expect(tx.frames.map((f) => f.mode)).toEqual([1, 1, 2, 2]);
    expect(tx.frames[0]!.data).toBe(toHex(1_999_999_000n, { size: 8 }));
    expect(tx.frames[0]!.limits.execution).toBe(10_000n);
    expect(tx.frames[1]!.limits.execution).toBe(64_000n);
    expect(tx.frames[1]!.data).toBe(encodeSessionVerifyData(session, ownerSignature));
    expect(tx.nonceKeys).toEqual([77n]);
    const signed = await signFrameTransaction(profile, tx, { privateKey: sessionPk });
    expect(signed.signatures[0]!.signer).toBe(key.address);
    expect(signed.signatures[0]!.signature).toMatch(/^0x0[01][0-9a-f]{128}$/);
  });

  it("refuses calls the contract would reject", async () => {
    const ownerSignature = await owner.signTypedData(bridge.authorizeSession(session));
    const args = { session, ownerSignature, nonce: 0n, fees, deadline: 1_000n };
    expect(() => bridge.buildSessionTx({ ...args, deadline: session.validUntil + 1n, calls: [{ to }] })).toThrow(/validUntil/);
    expect(() => bridge.buildSessionTx({ ...args, calls: [{ to: zeroAddress }] })).toThrow(/session target/);
    expect(() => bridge.buildSessionTx({ ...args, calls: [{ to, value: 11n }] })).toThrow(/maxValuePerTx/);
  });
});
