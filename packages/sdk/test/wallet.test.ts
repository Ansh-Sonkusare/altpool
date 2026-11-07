// Browser-wallet paths: one popup per tx, prepare without signing, and the chain-1337 clash check. Offline: every
// RPC is a mocked EIP-1193 transport.
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, keccak256, stringToHex, toHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { profile } from "@forshtat/hegota-support/profiles/ethrex-eip8141-tracer";
import { altDevnet } from "@altpool/core";
import {
  InteractiveSignerError, NEW_ACCOUNT_STATE_GAS, PREPARED_CALL_GAS, PREPARED_CALL_STATE_GAS, WrongNetworkError,
  altpoolActions, bridgeAccount, checkWalletNetwork, connectAltDevnet, createAltMempoolClient, isInteractiveSigner,
  prepareCalls, typedDataSigner,
} from "../src/index";

const owner = privateKeyToAccount(keccak256(stringToHex("altpool wallet test owner")));
const account = "0x9f1331A6E016620Bab4674ECf3e233E72A92862a" as const;
const existing = "0x23864f6a599992d1964F3988ddE398F989D134A0" as const;
const fresh = "0x1234567890123456789012345678901234567893" as const;
const bridge = bridgeAccount({ address: account, owner: owner.address, profile });

/** A chain whose only non-empty account is `existing`; the bridge account has nonce 9. */
function chain(head = 9000n) {
  const calls: string[] = [];
  const client = createPublicClient({
    chain: altDevnet,
    transport: custom({
      async request({ method, params }: { method: string; params?: any }) {
        calls.push(method);
        const addr = (params?.[0] as string | undefined)?.toLowerCase();
        switch (method) {
          case "eth_chainId": return toHex(altDevnet.id);
          case "eth_blockNumber": return toHex(head);
          case "eth_gasPrice": return toHex(3_000_000_000n);
          case "eth_getBalance": return addr === existing.toLowerCase() ? toHex(10n ** 18n) : "0x0";
          case "eth_getTransactionCount": return addr === account.toLowerCase() ? "0x9" : "0x0";
          case "eth_getCode": return "0x";
          case "eth_getStorageAt": return toHex(0n, { size: 32 });
          default: throw new Error(`unmocked ${method}`);
        }
      },
    }),
  });
  return { client, calls };
}

describe("wallet: interactive signers sign once", () => {
  const signer = typedDataSigner(owner, bridge);

  it("typedDataSigner is interactive; key signers are not", () => {
    expect(isInteractiveSigner(signer)).toBe(true);
    expect(isInteractiveSigner({ privateKey: keccak256("0x01") })).toBe(false);
    expect(isInteractiveSigner(undefined)).toBe(false);
  });

  it("gas estimation refuses to ask a wallet to sign the estimator's probe", async () => {
    const sidecar = createAltMempoolClient({ httpUrl: "http://127.0.0.1:1/rpc", profile, name: "unused" });
    const sdk = chain().client.extend(altpoolActions({ sidecar }));
    const sign = vi.spyOn(signer, "signFrame");
    const { tx } = bridge.buildTx({ calls: [{ to: existing, value: 1n }], nonce: 0n, fees: { maxFeePerGas: 20n } });
    await expect(sdk.altpool.estimateFrameTransactionGas({ transaction: tx, signer })).rejects.toBeInstanceOf(InteractiveSignerError);
    await expect(sdk.altpool.sendFrameTransaction({ transaction: tx, signer, prepare: true })).rejects.toBeInstanceOf(InteractiveSignerError);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("wallet: prepare without signing", () => {
  it("declares state gas only where a call can create state", async () => {
    const { client } = chain();
    const [toExisting, toFresh, contractCall, zeroToFresh, pinned] = await prepareCalls(client, [
      { to: existing, value: 1n },
      { to: fresh, value: 1n },
      { to: existing, data: "0xd0e30db0" },
      { to: fresh },
      { to: fresh, value: 1n, gas: 7n, state: 0n },
    ]);
    expect(toExisting).toMatchObject({ gas: PREPARED_CALL_GAS, state: 0n });
    expect(toFresh).toMatchObject({ gas: PREPARED_CALL_GAS, state: NEW_ACCOUNT_STATE_GAS });
    expect(contractCall).toMatchObject({ gas: PREPARED_CALL_GAS, state: PREPARED_CALL_STATE_GAS });
    expect(zeroToFresh).toMatchObject({ state: 0n }); // no value: nothing is created
    expect(pinned).toMatchObject({ gas: 7n, state: 0n }); // explicit limits win
  });

  it("Mode A: reads the nonce, takes fees from the sidecar, leaves VERIFY tight", async () => {
    const { client, calls } = chain();
    const sidecar = { getGasPrice: async () => ({ maxFeePerGas: 9n, maxPriorityFeePerGas: 1n }) };
    const { tx, typedData } = await bridge.prepareTx({ client, sidecar, calls: [{ to: fresh, value: 1n }] });
    expect(tx.nonceSeq).toBe(9n);
    expect(tx.fees).toMatchObject({ maxFeePerGas: 18n, maxPriorityFeePerGas: 1n });
    expect(tx.frames[0]!.limits.execution).toBe(40_000n);
    expect(tx.frames[1]!.limits).toEqual({ execution: PREPARED_CALL_GAS, state: NEW_ACCOUNT_STATE_GAS });
    expect(typedData.message).toMatchObject({ nonce: 9n, to: fresh, value: 1n, maxFeePerGas: 18n });
    expect(calls).not.toContain("eth_gasPrice");
  });

  it("Mode A: explicit fees and nonce skip the reads", async () => {
    const { client, calls } = chain();
    const { tx } = await bridge.prepareTx({ client, calls: [{ to: existing, value: 1n, gas: 21_000n, state: 0n }], nonce: 3n, fees: { maxFeePerGas: 5n } });
    expect(tx.nonceSeq).toBe(3n);
    expect(tx.fees.maxFeePerGas).toBe(5n);
    expect(tx.frames[1]!.limits).toEqual({ execution: 21_000n, state: 0n });
    expect(calls).toEqual([]);
  });

  it("Mode B: a fresh nonce key per tx (seq 0) and a deadline inside the session", async () => {
    const { client } = chain();
    const key = privateKeyToAccount(keccak256(stringToHex("altpool wallet test session")));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const session = { key: key.address, validUntil: now + 120n, maxValuePerTx: 10n, maxCostPerTx: 10n ** 16n, target: existing as Address };
    const ownerSignature = await owner.signTypedData(bridge.authorizeSession(session));
    const a = await bridge.prepareSessionTx({ client, session, ownerSignature, calls: [{ to: existing, value: 1n }], fees: { maxFeePerGas: 5n } });
    const b = await bridge.prepareSessionTx({ client, session, ownerSignature, calls: [{ to: existing, value: 2n }], fees: { maxFeePerGas: 5n } });
    expect(a.nonceKeys[0]).not.toBe(b.nonceKeys[0]);
    expect(a.nonceSeq).toBe(0n);
    expect(BigInt(a.frames[0]!.data)).toBe(session.validUntil); // now + 600 would pass validUntil: capped
  });
});

describe("wallet: network check", () => {
  const wallet = (chainId: number, head: bigint) => {
    const w = {
      request: async ({ method }: { method: string }) => (method === "eth_chainId" ? toHex(chainId) : toHex(head)),
      switchChain: vi.fn(async () => {}),
      addChain: vi.fn(async () => {}),
    };
    return w;
  };

  it("passes when the wallet's 1337 is the devnet", async () => {
    await expect(checkWalletNetwork(wallet(1337, 9001n), { client: chain(9000n).client })).resolves.toMatchObject({ chainId: 1337, walletBlock: 9001n, devnetBlock: 9000n });
  });

  it("catches MetaMask's Localhost 8545 (same id, different chain)", async () => {
    await expect(checkWalletNetwork(wallet(1337, 12n), { client: chain(9000n).client })).rejects.toBeInstanceOf(WrongNetworkError);
  });

  it("rejects another chain id", async () => {
    await expect(checkWalletNetwork(wallet(1, 9000n), { client: chain(9000n).client })).rejects.toThrow(/chain 1, not 1337/);
  });

  it("adds the network when switching fails, then checks it", async () => {
    const w = wallet(1337, 9000n);
    w.switchChain.mockRejectedValueOnce(new Error("4902 unrecognized chain"));
    await connectAltDevnet(w, { client: chain(9000n).client });
    expect(w.addChain).toHaveBeenCalledWith({ chain: altDevnet });
    expect(w.switchChain).toHaveBeenCalledTimes(2);
  });
});
