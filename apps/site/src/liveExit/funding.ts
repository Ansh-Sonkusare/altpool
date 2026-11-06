// Who signs the chain transactions around a live run (the deposit, the fund's invoice, a rescue) and how each gets funded.
// Shared so LiveExit can reuse it later; nothing here touches the frame transaction, which carries no signature.
import { createWalletClient, formatEther, http, isHex, parseEther, type Account, type Address, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEVNET, altDevnet, gateway, type Note } from "@altpool/core";
import { WETH9, erc20PoolAbi, wethAbi } from "@altpool/contracts";
import { client } from "../altpool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Funder {
  label: string;
  /** What the page may say about this signer. */
  note: string;
  address: Address;
  wallet: WalletClient<Transport, Chain, Account>;
  /** Top the balance up to at least `min`, from the faucet if needed. Returns the faucet tx hash when it paid. */
  ensureFunds(min: bigint, onBalance: (wei: bigint) => void, onTx?: (hash: Hex) => void): Promise<Hex | undefined>;
}

/** Wrap + approve + deposit gas need: one denomination plus margin. */
export const DEPOSIT_NEED = DEVNET.denomination + parseEther("0.02");

const read = (address: Address) => client.getBalance({ address }).catch(() => undefined);

const keyFunder = (pk: Hex, label: string, note: string): Funder => {
  const account = privateKeyToAccount(pk);
  return {
    label,
    note,
    address: account.address,
    wallet: createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl) }),
    async ensureFunds(min, onBalance, onTx) {
      const have = await read(account.address);
      if (have !== undefined) onBalance(have);
      if (have !== undefined && have >= min) return undefined;
      let hash: Hex | undefined;
      try {
        const res: unknown = await gateway().faucet(account.address);
        const h = typeof res === "string" ? res : (res as { hash?: string; txHash?: string } | null)?.hash ?? (res as { txHash?: string } | null)?.txHash;
        if (h && /^0x[0-9a-fA-F]{64}$/.test(h)) { hash = h as Hex; onTx?.(hash); }
      } catch (e) {
        throw new Error(`${have === undefined ? "Balance unreadable" : `${formatEther(have)} ETH is below the ${formatEther(min)} ETH needed`}, and the faucet refused (it allows about 1 ETH per address per hour): ${msg(e)}`);
      }
      for (let i = 0; i < 60; i++) {
        // A dropped poll is not a failed faucet: skip it and ask again.
        const b = await read(account.address);
        if (b !== undefined) {
          onBalance(b);
          if (b >= min) return hash;
        }
        await sleep(2000);
      }
      throw new Error("the faucet did not pay out within 120 s");
    },
  };
};

/** A configured key when it is well formed; Vite inlines it into the bundle, so it is devnet only and readable by anyone. */
const configured = (v: unknown): Hex | undefined => (typeof v === "string" && isHex(v) && v.length === 66 ? v : undefined);

/** A fresh key in this tab's memory, funded by the faucet on first use. The rescue after a rolled-back batch signs with one. */
export const freshKeyFunder = (label = "Fresh in-memory key"): Funder =>
  keyFunder(generatePrivateKey(), label, "A fresh key that lives in this tab's memory and is funded by the faucet.");

/**
 * VITE_DEMO_PK: the shared depositor. Unset or malformed, a fresh key per run.
 * TODO(teammate): add `injectedFunder()` beside this for a browser wallet. Use window.ethereum with
 * wallet_switchEthereumChain / wallet_addEthereumChain (chain 1337, rpc DEVNET.ethrexUrl; altDevnet has the params),
 * `createWalletClient({ account: address, chain: altDevnet, transport: custom(window.ethereum) })`, same Funder shape.
 */
export const demoKeyFunder = (): Funder => {
  const pk = configured(import.meta.env.VITE_DEMO_PK);
  return pk
    ? keyFunder(pk, "Demo wallet", "A shared devnet key, so the deposit is public and tied to it. Anyone who opens this site's bundle can read the key: it holds devnet ETH only.")
    : freshKeyFunder();
};

/** VITE_FUND_PK: the aid fund that issues invoices, so the depositor never signs after its deposit. Unset, a fresh key. */
export const fundKeyFunder = (): Funder => {
  const pk = configured(import.meta.env.VITE_FUND_PK);
  return pk
    ? keyFunder(pk, "Fund key", "The aid fund's devnet key. It creates every invoice and never deposits.")
    : freshKeyFunder("Fresh fund key");
};

const TX = { gas: 2_000_000n, type: "legacy" } as const;

/** Wait for a receipt; a reverted tx throws. */
export async function mined(hash: Hex, what: string, onMined?: (hash: Hex, block: bigint, ok: boolean) => void): Promise<Hex> {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  onMined?.(hash, r.blockNumber, r.status === "success");
  if (r.status !== "success") throw new Error(`${what} ${hash} reverted`);
  return hash;
}

/** Wrap one denomination of ETH, approve the ERC20 pool, deposit the note. The WETH-pool counterpart of depositNote. */
export async function wrapAndDeposit(f: Funder, note: Note, pool: Address, onTx: (what: "wrap" | "approve" | "deposit", hash: Hex) => void, onMined?: (hash: Hex, block: bigint, ok: boolean) => void): Promise<Hex> {
  const send = async (what: "wrap" | "approve" | "deposit", hash: Hex) => (onTx(what, hash), mined(hash, what, onMined));
  await send("wrap", await f.wallet.writeContract({ address: WETH9, abi: wethAbi, functionName: "deposit", value: DEVNET.denomination, ...TX }));
  await send("approve", await f.wallet.writeContract({ address: WETH9, abi: wethAbi, functionName: "approve", args: [pool, DEVNET.denomination], ...TX }));
  return send("deposit", await f.wallet.writeContract({ address: pool, abi: erc20PoolAbi, functionName: "deposit", args: [note.commitment], ...TX }));
}
