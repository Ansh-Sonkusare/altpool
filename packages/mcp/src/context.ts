// Shared clients and signers for the write tools. Endpoints come from @altpool/core's DEVNET, which reads ETHREX_URL,
// GATEWAY_URL and MINER_SIDECAR_URL, so the same server runs against altpool-localnet by setting those env vars.
//
// Keys: the server never asks for or prints the user's wallet key. It signs with
//   - the agent key: ALTPOOL_AGENT_PK, else generated once into packages/mcp/.env (gitignored). A devnet throwaway.
//   - a BridgeAccount session: ALTPOOL_SESSION (a path to, or the JSON of, the file apps/wallet-bridge-web exports).
//     The account's own VERIFY code bounds it: one target, value and fee cap per tx, expiry.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, isHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { DEVNET, altDevnet, explorerTx } from "@altpool/core";
import { altpoolActions, bridgeAccount, createAltMempoolClient, type BridgeSession } from "altpool";

export const profile = getProfile(DEVNET.profile);

let _ctx: ReturnType<typeof makeContext> | undefined;
function makeContext() {
  const pub = createPublicClient({ chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000 }) });
  // Submit to the miner's sidecar: the gateway admits but does not gossip every tx to the miner (packages/contracts/src/flow.ts).
  const sidecar = createAltMempoolClient({ httpUrl: DEVNET.minerSidecarUrl, profile, name: "miner", timeoutMs: 60_000 });
  const sdk = pub.extend(altpoolActions({ sidecar, explorerUrl: DEVNET.explorerUrl }));
  return { pub, sidecar, sdk };
}
export const ctx = () => (_ctx ??= makeContext());

/** Explorer link on the miner's view (the explorer defaults to the gateway, which may not see miner-submitted txs). */
export const explorerLink = (hash: Hex) => `${explorerTx(hash)}?node=${encodeURIComponent(DEVNET.minerSidecarUrl)}`;

// ------------------------------------------------------------------------------------------- agent key ------

const ENV = new URL("../.env", import.meta.url);

/** The agent's own devnet key. Generated on first use; the key itself never leaves this process. */
export function agentKey(): Hex {
  const fromEnv = process.env.ALTPOOL_AGENT_PK;
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error("ALTPOOL_AGENT_PK is not a 32-byte 0x hex key.");
    return fromEnv as Hex;
  }
  const file = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const found = file.match(/^ALTPOOL_AGENT_PK=(0x[0-9a-fA-F]{64})\s*$/m)?.[1] as Hex | undefined;
  if (found) return found;
  const pk = generatePrivateKey();
  appendFileSync(ENV, `${file && !file.endsWith("\n") ? "\n" : ""}ALTPOOL_AGENT_PK=${pk}\n`);
  return pk;
}

export function agent() {
  const account = privateKeyToAccount(agentKey());
  const wallet = createWalletClient({ account, chain: altDevnet, transport: http(DEVNET.ethrexUrl, { timeout: 60_000 }) });
  return { account, wallet, address: account.address };
}

// -------------------------------------------------------------------------------------------- session ------

/** The file apps/wallet-bridge-web's "Export session for an agent" button downloads. Numbers are decimal strings. */
export interface SessionFile {
  kind: "altpool-bridge-session";
  chainId: number;
  account: Address;
  owner: Address;
  session: { key: Address; validUntil: string; maxValuePerTx: string; maxCostPerTx: string; target: Address };
  ownerSignature: Hex;
  sessionPrivateKey: Hex;
}

export interface LoadedSession {
  account: Address;
  owner: Address;
  session: BridgeSession;
  ownerSignature: Hex;
  sessionPrivateKey: Hex;
  bridge: ReturnType<typeof bridgeAccount>;
}

/** Parse and check a session file (shape, chain, key matches session.key). Throws with what is wrong. */
export function parseSession(json: unknown, chainId: number = DEVNET.chainId): LoadedSession {
  const s = json as Partial<SessionFile>;
  if (!s || s.kind !== "altpool-bridge-session") throw new Error('Not an altpool session file (kind must be "altpool-bridge-session").');
  if (s.chainId !== chainId) throw new Error(`Session is for chain ${s.chainId}, this server talks to chain ${chainId}.`);
  for (const k of ["account", "owner"] as const) if (!s[k] || !isAddress(s[k]!)) throw new Error(`Session ${k} is not an address.`);
  if (!s.session || !isAddress(s.session.key) || !isAddress(s.session.target)) throw new Error("Session key/target missing.");
  if (!s.ownerSignature || !isHex(s.ownerSignature) || s.ownerSignature.length !== 132) throw new Error("ownerSignature must be 65 bytes.");
  if (!s.sessionPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(s.sessionPrivateKey)) throw new Error("sessionPrivateKey must be 32 bytes.");
  const keyAddr = privateKeyToAccount(s.sessionPrivateKey).address;
  if (getAddress(keyAddr) !== getAddress(s.session.key)) throw new Error("sessionPrivateKey does not match session.key.");
  const session: BridgeSession = {
    key: getAddress(s.session.key),
    validUntil: BigInt(s.session.validUntil),
    maxValuePerTx: BigInt(s.session.maxValuePerTx),
    maxCostPerTx: BigInt(s.session.maxCostPerTx),
    target: getAddress(s.session.target),
  };
  const account = getAddress(s.account!);
  const owner = getAddress(s.owner!);
  return { account, owner, session, ownerSignature: s.ownerSignature, sessionPrivateKey: s.sessionPrivateKey, bridge: bridgeAccount({ address: account, owner, profile }) };
}

/** ALTPOOL_SESSION: a file path or inline JSON. Undefined when unset. */
export function loadSession(): LoadedSession | undefined {
  const v = process.env.ALTPOOL_SESSION;
  if (!v) return undefined;
  const text = v.trim().startsWith("{") ? v : readFileSync(v, "utf8");
  return parseSession(JSON.parse(text));
}
