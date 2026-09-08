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
 * The newest LIVE mandate — not revoked, not expired.
 *
 * A revoked one would still render, but every assertion about trading against
 * it would be testing the revoked path by accident, which is how a green suite
 * ends up proving the wrong thing.
 */
export async function liveMandate(): Promise<FoundMandate> {
  if (cached) return cached;
  const next = Number(await pub.readContract({
    address: REGISTRY as Address, abi, functionName: "nextMandateId",
  }));
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (let id = next - 1; id > 0 && id > next - 60; id--) {
    const m = (await pub.readContract({
      address: REGISTRY as Address, abi, functionName: "mandates", args: [BigInt(id)],
    })) as readonly [Address, Address, bigint, bigint, bigint, bigint, boolean, boolean];
    const [delegator, delegate, , , , expiry, revoked, exists] = m;
    if (!exists || revoked || expiry <= now) continue;
    cached = { id: BigInt(id), delegator, delegate };
    return cached;
  }
  throw new Error(
    `no live mandate on ${REGISTRY} in the last 60 ids — run: npx tsx scripts/demo-reset.ts`,
  );
}
