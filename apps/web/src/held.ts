/**
 * The landing page's headline number, as a function with no DOM in it.
 *
 * It lives apart from `landing.ts` so `scripts/verify.ts` can run THIS code —
 * the code that actually ships — against a dead RPC and assert what it returns,
 * rather than re-implementing the logic in a test and asserting the
 * re-implementation. A test that exercises a copy of the code proves something
 * about the copy.
 *
 * The rule it exists to keep: an unreachable chain must render an em dash, not
 * a confident `0.00`. Those two look similar and mean opposite things — one is
 * "we checked and the registry is empty", the other is "we did not check".
 */
import type { Address } from "viem";
import { erc20Abi, registryAbi, fmt } from "./chain.js";

/**
 * Only what this function needs. Deliberately structural rather than viem's
 * `PublicClient`: the web app and the repo root resolve viem from different
 * node_modules, so a nominal type here would make the shipped function
 * un-callable from `scripts/verify.ts` — and then verify would test a copy.
 */
export interface Reader {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface Held {
  /** What to print. "—" whenever the chain did not answer. */
  value: string;
  /** The line under the pipeline row. */
  note: string;
  /** True only when a read completed. */
  read: boolean;
  /** True only when a read completed AND every unit is attributed. */
  clean: boolean;
}

export const UNREAD: Held = {
  value: "—",
  note: "chain unreachable",
  read: false,
  clean: false,
};

export async function readHeld(
  client: Reader,
  registry: string,
  collateral: Address,
): Promise<Held> {
  if (!registry) return { ...UNREAD, note: "registry not configured" };
  try {
    const [bal, clean] = (await Promise.all([
      client.readContract({
        address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [registry as Address],
      }),
      client.readContract({
        address: registry as Address, abi: registryAbi, functionName: "holdsNoFunds",
      }),
    ])) as [bigint, boolean];
    const shown = fmt(bal) === "0" ? "0.00" : fmt(bal);
    return {
      value: shown,
      note: clean ? `balance back to ${shown}` : "UNATTRIBUTED BALANCE — see doctor",
      read: true,
      clean,
    };
  } catch {
    return UNREAD;
  }
}
