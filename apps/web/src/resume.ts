/**
 * Finding your delegation again when the URL does not carry it.
 *
 * The mandate id lived ONLY in `?m=`. Reload `/app` with no query string, or
 * close the tab, and a delegator who had just created a delegation was returned
 * to step 1 of setup with no route back — the delegation existed on chain the
 * whole time, and the app simply had no idea which one was theirs.
 *
 * The id is recoverable from the contract, so it is recovered from the
 * contract. Mandate ids are sequential from 1 and `nextMandateId` is public, so
 * walking backwards from the newest and matching `delegator` (or `delegate`)
 * finds the most recent one belonging to an account.
 *
 * `localStorage` holds a POINTER to the id and nothing else — never a limit,
 * never a balance, never an expiry. Every figure the product asserts still
 * comes from `mandates(id)` on the deployed registry, and the pointer itself is
 * re-checked against the contract before it is trusted. A stored id that no
 * longer belongs to you is discarded, not displayed.
 */
import { pub, registryAbi, REGISTRY } from "./chain.js";
import type { Role } from "./state.js";
import type { Address } from "viem";

/** How far back a full scan will walk. */
const SCAN_DEPTH = 120;
/** Reads issued at once. Enough to be quick, small enough not to trip limits. */
const BATCH = 20;

const key = (a: Address) => `leash:mandate:${a.toLowerCase()}`;

/** Best-effort, and genuinely optional: private windows throw on access. */
function readPointer(account: Address): bigint | null {
  try {
    const v = localStorage.getItem(key(account));
    return v && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

export function rememberMandate(account: Address, id: bigint): void {
  try {
    localStorage.setItem(key(account), String(id));
  } catch {
    /* a pointer we cannot store is a slower next load, not a broken one. */
  }
}

export function forgetMandate(account: Address): void {
  try {
    localStorage.removeItem(key(account));
  } catch { /* as above */ }
}

type Row = readonly [Address, Address, bigint, bigint, bigint, bigint, boolean, boolean];

async function row(id: bigint): Promise<Row | null> {
  try {
    return (await pub.readContract({
      address: REGISTRY as Address, abi: registryAbi,
      functionName: "mandates", args: [id],
    })) as Row;
  } catch {
    return null;
  }
}

/** Does this mandate belong to `account` in the role they are acting in? */
function mine(r: Row | null, account: Address, role: Role): boolean {
  if (!r || !r[7]) return false; // [7] is `exists`
  const party = role === "delegate" ? r[1] : r[0];
  return party.toLowerCase() === account.toLowerCase();
}

/**
 * The newest mandate belonging to `account`, or null.
 *
 * Bounded on purpose: 151 mandates already exist on the deployed registry from
 * rehearsals, and an unbounded backward walk on every page load would be a slow
 * boot for someone who has no mandate at all. Past `SCAN_DEPTH` we stop and let
 * them use their link — which is the honest outcome, not a guess.
 */
export async function findMandate(account: Address, role: Role): Promise<bigint | null> {
  // The cheap path: a remembered pointer, re-verified on chain before use.
  const cached = readPointer(account);
  if (cached !== null && mine(await row(cached), account, role)) return cached;
  if (cached !== null) forgetMandate(account);

  let next: bigint;
  try {
    next = (await pub.readContract({
      address: REGISTRY as Address, abi: registryAbi, functionName: "nextMandateId",
    })) as bigint;
  } catch {
    return null;
  }

  const newest = next - 1n;
  const floor = newest > BigInt(SCAN_DEPTH) ? newest - BigInt(SCAN_DEPTH) : 0n;

  for (let hi = newest; hi > floor; hi -= BigInt(BATCH)) {
    const ids: bigint[] = [];
    for (let i = hi; i > floor && ids.length < BATCH; i--) ids.push(i);
    const rows = await Promise.all(ids.map(row));
    // ids descend, so the first match in this batch is the newest match.
    for (let i = 0; i < ids.length; i++) {
      if (mine(rows[i] ?? null, account, role)) {
        rememberMandate(account, ids[i]!);
        return ids[i]!;
      }
    }
  }
  return null;
}
