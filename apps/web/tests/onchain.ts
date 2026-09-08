/**
 * Find a mandate to test against, on whatever registry is currently deployed.
 *
 * The specs used to name mandate 151 and 152 by number. A redeploy invalidated
 * both in one step, and a test that fails because the fixture moved teaches you
 * nothing about the product. Ids are discovered the same way the app discovers
 * them — walk back from `nextMandateId` and match the party — so these survive
 * the next redeploy too.
 *
 * Read-only, against the real RPC. Nothing here writes.
 */
import { createPublicClient, http, parseAbi, type Address } from "viem";
// From the app's own source, so a redeploy that updates chain.ts updates the
// tests in the same edit. chain.ts guards `globalThis.location`, so it is
// safe to import in Node.
import { REGISTRY } from "../src/chain.js";

const RPC = "https://dream-rpc.somnia.network";

const abi = parseAbi([
  "function nextMandateId() view returns (uint256)",
  "function mandates(uint256) view returns (address delegator, address delegate, uint128 perTrade, uint128 cap, uint128 used, uint64 expiry, bool revoked, bool exists)",
]);

const pub = createPublicClient({ transport: http(RPC) });

export interface FoundMandate {
  id: bigint;
  delegator: Address;
  delegate: Address;
}

let cached: FoundMandate | null = null;

/**
 * A mandate to render tests against.
 *
 * Prefers one that is still live, and falls back to the newest un-revoked one.
 *
 * The fallback is the point. Seeded mandates take their expiry from the MARKET
 * they are seeded on, and Event Contract markets resolve in 2-12 minutes — so a
 * strict "must be live" fixture goes stale between the seeding step and the
 * sweep finishing, and the suite fails for a reason that has nothing to do with
 * the product. It failed exactly that way twice.
 *
 * Safe because no test here needs a TRADABLE mandate: the wallet stub refuses
 * to sign, so these assert rendering, routing and wallet identity. A revoked
 * one is still excluded — that would silently test the revoked path instead.
 */
export async function someMandate(): Promise<FoundMandate> {
  if (cached) return cached;
  const next = Number(await pub.readContract({
    address: REGISTRY as Address, abi, functionName: "nextMandateId",
  }));
  const now = BigInt(Math.floor(Date.now() / 1000));
  let fallback: FoundMandate | null = null;

  for (let id = next - 1; id > 0 && id > next - 60; id--) {
    const m = (await pub.readContract({
      address: REGISTRY as Address, abi, functionName: "mandates", args: [BigInt(id)],
    })) as readonly [Address, Address, bigint, bigint, bigint, bigint, boolean, boolean];
    const [delegator, delegate, , , , expiry, revoked, exists] = m;
    if (!exists || revoked) continue;
    const found = { id: BigInt(id), delegator, delegate };
    if (expiry > now) { cached = found; return cached; }
    if (!fallback) fallback = found;
  }
  if (fallback) { cached = fallback; return cached; }
  throw new Error(
    `no usable mandate on ${REGISTRY} in the last 60 ids — run: npx tsx scripts/demo-reset.ts`,
  );
}

/** Back-compat alias: the specs read better with this name at the call sites. */
export const liveMandate = someMandate;
