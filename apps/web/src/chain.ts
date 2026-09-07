/**
 * Wallet + chain plumbing shared by both roles.
 *
 * Deliberately small: a judge opens this on a phone and must reach a filled
 * order without reading anything, so the only wallet interaction before trading
 * is "connect" and, if needed, one Add-Network tap.
 */
import {
  createPublicClient, createWalletClient, custom, http, parseAbi,
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
  type Address, type Hex,
} from "viem";

export const CHAIN_ID = 50312;
export const CHAIN_ID_HEX = "0xc488";
export const RPC = "https://api.infra.testnet.somnia.network";
export const EXPLORER = "https://shannon-explorer.somnia.network";
export const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;

/**
 * The deployed registry. Overridable at build time so a redeploy does not need a
 * code change, and at runtime via ?r= so a QR can point at a specific instance.
 */
const ENV = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
export const REGISTRY: string =
  new URLSearchParams(globalThis.location?.search ?? "").get("r") ??
  ENV.VITE_REGISTRY ??
  "0x7ca9dA7Be8C8F8Ca5E1c9821061cD4fc23418864";
export const HANDLER: string =
  ENV.VITE_HANDLER ?? "0xBffC022eC263C43B80bd040ded7e0A4a43101a97";

export const chain = {
  id: CHAIN_ID,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Shannon", url: EXPLORER } },
} as const;

export const registryAbi = parseAbi([
  "function createMandate(address delegate, uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint64 expiry, bytes32[] marketIds) returns (uint256)",
  "function placeForDelegator(uint256 mandateId, bytes32 marketId, address pool, uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs) returns (uint128)",
  "function revoke(uint256 mandateId)",
  "function mandates(uint256) view returns (address delegator, address delegate, uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint128 usedExposure, uint64 expiry, bool revoked, bool exists)",
  "function remainingExposure(uint256) view returns (uint256)",
  "function isActive(uint256) view returns (bool)",
  "function nextMandateId() view returns (uint256)",
  "function allowedMarket(uint256, bytes32) view returns (bool)",
  "function holdsNoFunds() view returns (bool)",
  "function unattributed() view returns (uint256)",
  "function refundClaim(uint256) view returns (uint256)",
  "error NotDelegator()",
  "error NotDelegate()",
  "error Revoked()",
  "error Expired()",
  "error MarketNotAllowed()",
  "error StakeExceedsPerTrade(uint256 cost, uint128 limit)",
  "error ExceedsCumulative(uint256 wouldBe, uint128 limit)",
]);

/** Read-only handler surface, for the desktop context column. */
export const handlerAbi = parseAbi([
  "function batchCap() view returns (uint256)",
  "function subscriptionId() view returns (uint256)",
  "function marketsSettled() view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(uint256)",
]);

export const pub = createPublicClient({ chain, transport: http(RPC) });

type Eth = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
export const eth = (): Eth | null =>
  (globalThis as unknown as { ethereum?: Eth }).ethereum ?? null;

/**
 * The account we are ALREADY authorized for, without prompting.
 *
 * `eth_accounts` returns the connected account if the user has previously
 * approved this origin, and an empty array otherwise — unlike
 * `eth_requestAccounts`, it never opens the wallet. Without this the app
 * forgets who you are on every reload, which is what made a returning
 * delegator land on step 1 of a wizard they had already finished.
 */
export async function restoreAccount(): Promise<Address | null> {
  const e = eth();
  if (!e) return null;
  try {
    const accounts = (await e.request({ method: "eth_accounts" })) as Address[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export async function connect(): Promise<Address> {
  const e = eth();
  if (!e) throw new Error("No wallet found. Open this in a wallet browser, or install MetaMask.");
  const accounts = (await e.request({ method: "eth_requestAccounts" })) as Address[];
  const a = accounts[0];
  if (!a) throw new Error("No account returned");
  return a;
}

/**
 * One-tap network add. Judges bounce if they have to add a chain by hand, and
 * `wallet_addEthereumChain` is a no-op when the chain is already present.
 */
export async function addNetwork(): Promise<void> {
  const e = eth();
  if (!e) throw new Error("No wallet found");
  try {
    await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch {
    await e.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: CHAIN_ID_HEX,
        chainName: "Somnia Shannon Testnet",
        nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
        rpcUrls: [RPC],
        blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}

export async function onRightChain(): Promise<boolean> {
  const e = eth();
  if (!e) return false;
  const id = (await e.request({ method: "eth_chainId" })) as string;
  return parseInt(id, 16) === CHAIN_ID;
}

export function wallet(account: Address) {
  const e = eth();
  if (!e) throw new Error("No wallet");
  return createWalletClient({ account, chain, transport: custom(e as never) });
}

export const txUrl = (h: Hex) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: Address) => `${EXPLORER}/address/${a}`;

/** 6dp collateral, read never assumed elsewhere; fixed here for display only. */
export const fmt = (raw: bigint, dp = 6) => {
  const s = raw.toString().padStart(dp + 1, "0");
  const whole = s.slice(0, -dp);
  const frac = s.slice(-dp).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

export const toRaw = (human: string, dp = 6): bigint => {
  const [i = "0", f = ""] = human.trim().split(".");
  return BigInt(i + f.padEnd(dp, "0").slice(0, dp));
};

/** Turn a viem error into the contract error name, so the UI can be specific. */
/**
 * The name of the custom error a call actually reverted with.
 *
 * This used to `JSON.stringify` the whole error and substring-match the error
 * names against it. viem attaches the ABI to its errors, so EVERY name in that
 * list appears in the serialization of any contract error - and the first one
 * checked, `NotDelegator`, was returned for anything at all, including a user
 * simply rejecting in their wallet.
 *
 * That is not a cosmetic mislabel. `refusal()` on the delegate screen turns
 * this name into a sentence about WHICH limit stopped the order, so a
 * per-order-cap breach could be reported as "this market is not on the
 * mandate". The product's whole claim is that it reports what the contract
 * said; saying the wrong thing confidently is worse than saying nothing.
 *
 * viem already decodes this properly. Walk the error chain and ask it.
 */
export function errName(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) {
      return "you rejected the request in your wallet.";
    }
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      // errorName is the decoded custom error; reason covers require(...).
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name) return name;
    }
    return (e.shortMessage || e.message).split(/\r?\n/)[0] ?? "Transaction failed";
  }
  // The provider layer, before viem wraps it. 4001 is EIP-1193 "user rejected".
  const raw = e as { code?: number; shortMessage?: string; message?: string };
  if (raw?.code === 4001) return "you rejected the request in your wallet.";
  return (raw?.shortMessage ?? raw?.message ?? "Transaction failed").split(/\r?\n/)[0] ?? "Transaction failed";
}
