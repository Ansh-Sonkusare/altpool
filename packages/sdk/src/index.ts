// Owner: Dev B. Usage: createWalletClient({ chain: altDevnet, transport }).extend(altMempoolActions)
import type { Client } from "viem";
import { todo, type AdmissionChecker, type Address, type FrameTx, type Hex, type Mempool } from "@altpool/core";

export { altDevnet, DEVNET } from "@altpool/core";
export type { AdmissionReport, AltpoolError, EntityStatus, FrameTx } from "@altpool/core";

export interface SendOptions {
  /** auto: public if precheck says public admits it, else alt. */
  mempool?: Mempool | "auto";
  /** Any AdmissionChecker (apps pass @altpool/simulator). Rejections throw before signing. */
  precheck?: AdmissionChecker;
  privateKey: Hex;
}

export interface StakeOptions { entity: Address; amount: bigint; unstakeDelaySec?: number; privateKey: Hex }

export const altMempoolActions = (_client: Client) => ({
  /** Fill gas, pick a nonce key, precheck, sign, send to the right mempool. Returns the tx hash. */
  sendFrameTransaction: (_tx: FrameTx, _opts: SendOptions): Promise<Hex> => todo("sendFrameTransaction"),
  /** Per-frame limits from eth_estimateFrameTransactionGas. Sign (or use a placeholder signature) first: unsigned fails. */
  fillFrameGas: (_tx: FrameTx): Promise<FrameTx> => todo("fillFrameGas"),
  /** Registry addStake(uint32) payable; stake strictly more than DEVNET.minStakeWei. */
  stakeEntity: (_opts: StakeOptions): Promise<Hex> => todo("stakeEntity"),
  getStake: (_entity: Address): Promise<{ amount: bigint; unstakeDelaySec: number; isStaked: boolean }> => todo("getStake"),
  /** A free nonce key for sender, or reserve the caller's key (QuietSend passes the nullifier). One pending tx per key. */
  allocateNonceKey: (_sender: Address, _key?: bigint): Promise<bigint> => todo("allocateNonceKey"),
});

export type AltMempoolActions = ReturnType<typeof altMempoolActions>;
