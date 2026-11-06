// Entity staking against the sidecar's staking registry. The registry address and minimums come from the node's
// skandha_config, never from constants. Staking is keyed on msg.sender: an EOA can only stake itself, and a contract
// (payer, factory, a contract sender) must call addStake from its own code.
import type { Address, Hex } from "@altpool/core";
import { encodeFunctionData, parseAbi, type Account, type Chain, type Client, type Transport } from "viem";
import { getCode, readContract, simulateContract, writeContract } from "viem/actions";
import { InsufficientStakeError, StakeConfigurationError } from "./errors";
import { assertAddress, type NodeIdentity, type SidecarConfig } from "./normalize";

export const stakingRegistryAbi = parseAbi([
  "function addStake(uint32 unstakeDelaySec) payable",
  "function unlockStake()",
  "function withdrawStake(address withdrawAddress)",
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
]);

export interface StakingParameters {
  registry: Address;
  minStake: bigint;
  minUnstakeDelaySec: number;
  node: NodeIdentity;
}

export function stakingParameters(config: SidecarConfig, node: NodeIdentity): StakingParameters {
  if (!config.stakingRegistry) throw new StakeConfigurationError(`Node "${node.name}" reports no stakingRegistryAddress in skandha_config.`);
  return { registry: config.stakingRegistry, minStake: config.minStake, minUnstakeDelaySec: config.minUnstakeDelaySec, node };
}

export type StakeState = "none" | "staked" | "unlocking" | "withdrawable";

export interface EntityStake {
  entity: Address;
  amount: bigint;
  unstakeDelaySec: number;
  /** 0 while staked; set by unlockStake to the earliest withdrawal time (unix seconds). */
  withdrawTime: bigint;
  state: StakeState;
  /** Whether the amount and delay satisfy this node's minimums (contract view; see isEntityStaked for the node's own verdict). */
  meetsMinimum: boolean;
  isContract: boolean;
  params: StakingParameters;
}

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export async function getEntityStake(client: Client, params: StakingParameters, entity: Address): Promise<EntityStake> {
  assertAddress(entity, "entity");
  const [[amount, unstakeDelaySec, withdrawTime], code] = await Promise.all([
    readContract(client, { address: params.registry, abi: stakingRegistryAbi, functionName: "getDepositInfo", args: [entity] }),
    getCode(client, { address: entity }),
  ]);
  const state: StakeState = amount === 0n ? "none" : withdrawTime === 0n ? "staked" : nowSec() >= withdrawTime ? "withdrawable" : "unlocking";
  return {
    entity, amount, unstakeDelaySec, withdrawTime, state,
    // The sidecar's isStaked is false once unlockStake runs (fixtures local/r5-stake 05). Amount must exceed the minimum.
    meetsMinimum: state === "staked" && amount > params.minStake && unstakeDelaySec >= params.minUnstakeDelaySec,
    isContract: !!code && code !== "0x",
    params,
  };
}

export type WalletLike = Client<Transport, Chain | undefined, Account>;

function requireAccount(wallet: Client, what: string): Account {
  const account = (wallet as WalletLike).account;
  if (!account) throw new StakeConfigurationError(`${what} needs a wallet client with an account: staking acts for msg.sender.`);
  return account;
}

function assertSelf(account: Account, entity: Address | undefined, isContract: boolean | undefined, what: string) {
  if (entity && entity.toLowerCase() !== account.address.toLowerCase()) {
    throw new StakeConfigurationError(
      `${what} would act for ${account.address}, not ${entity}. The registry keys stakes on msg.sender: ` +
        (isContract
          ? `${entity} is a contract, so it must call ${what === "addStake" ? "addStake{value}(delay)" : what} itself (add an owner-only function that forwards to the registry; see registryCalldata()).`
          : `sign with ${entity}'s own key.`),
    );
  }
}

export interface StakeEntityArgs {
  /** Wei to stake. Must exceed the node's minStake. */
  amount: bigint;
  /** Defaults to the node's minUnstakeDelay. */
  unstakeDelaySec?: number;
  /** The entity you intend to stake. Must be the wallet's own address (checked). */
  entity?: Address;
}

/** `addStake(delay)` from the wallet's own account. Simulated first; throws on a misconfiguration before sending. */
export async function stakeEntity(publicClient: Client, wallet: Client, params: StakingParameters, args: StakeEntityArgs): Promise<Hex> {
  const account = requireAccount(wallet, "addStake");
  const isContract = args.entity ? (await getCode(publicClient, { address: args.entity }).then((c) => !!c && c !== "0x")) : false;
  assertSelf(account, args.entity, isContract, "addStake");
  if (args.amount <= params.minStake) {
    throw new InsufficientStakeError(`Stake ${args.amount} wei is not above node "${params.node.name}"'s minStake ${params.minStake} wei.`, { fix: `Stake more than ${params.minStake} wei.` });
  }
  const delay = args.unstakeDelaySec ?? params.minUnstakeDelaySec;
  if (delay < params.minUnstakeDelaySec) throw new StakeConfigurationError(`unstakeDelaySec ${delay} is below the node's minimum ${params.minUnstakeDelaySec}.`);
  const { request } = await simulateContract(publicClient, { account, address: params.registry, abi: stakingRegistryAbi, functionName: "addStake", args: [delay], value: args.amount, chain: wallet.chain });
  return writeContract(wallet, request as any);
}

/** `unlockStake()` from the wallet's own account. Starts the unstake delay; the node stops treating it as staked. */
export async function unlockEntityStake(publicClient: Client, wallet: Client, params: StakingParameters, entity?: Address): Promise<Hex> {
  const account = requireAccount(wallet, "unlockStake");
  assertSelf(account, entity, undefined, "unlockStake");
  const s = await getEntityStake(publicClient, params, account.address);
  if (s.state !== "staked") throw new StakeConfigurationError(`Nothing to unlock: ${account.address} is "${s.state}".`);
  const { request } = await simulateContract(publicClient, { account, address: params.registry, abi: stakingRegistryAbi, functionName: "unlockStake", chain: wallet.chain });
  return writeContract(wallet, request as any);
}

/** `withdrawStake(to)` from the wallet's own account, only once the unstake delay has passed. */
export async function withdrawEntityStake(publicClient: Client, wallet: Client, params: StakingParameters, args: { to?: Address; entity?: Address } = {}): Promise<Hex> {
  const account = requireAccount(wallet, "withdrawStake");
  assertSelf(account, args.entity, undefined, "withdrawStake");
  const s = await getEntityStake(publicClient, params, account.address);
  if (s.state !== "withdrawable") {
    const when = s.withdrawTime > 0n ? ` (withdrawable at ${new Date(Number(s.withdrawTime) * 1000).toISOString()})` : "";
    throw new StakeConfigurationError(`Stake of ${account.address} is "${s.state}", not withdrawable${when}. Call unlockStake first and wait out the delay.`);
  }
  const to = args.to ?? account.address;
  assertAddress(to, "to");
  const { request } = await simulateContract(publicClient, { account, address: params.registry, abi: stakingRegistryAbi, functionName: "withdrawStake", args: [to], chain: wallet.chain });
  return writeContract(wallet, request as any);
}

/** Calldata a contract entity must send to the registry from its own code (it cannot be staked from outside). */
export const registryCalldata = {
  addStake: (unstakeDelaySec: number): Hex => encodeFunctionData({ abi: stakingRegistryAbi, functionName: "addStake", args: [unstakeDelaySec] }),
  unlockStake: (): Hex => encodeFunctionData({ abi: stakingRegistryAbi, functionName: "unlockStake" }),
  withdrawStake: (to: Address): Hex => encodeFunctionData({ abi: stakingRegistryAbi, functionName: "withdrawStake", args: [to] }),
};
