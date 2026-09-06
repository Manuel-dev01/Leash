/**
 * One-command reset to a clean, REALISTIC demo state.
 *
 * Seeds SEVERAL mandates, not one. A single-mandate revocation and a batch of a
 * dozen settling in the same block are the same code and completely different in
 * the room — the batch is what turns "one subscription serves every delegation"
 * from a claim into something the viewer watches happen. Twenty rehearsals need
 * this to be one command.
 *
 *   npx tsx scripts/demo-reset.ts            # default seed
 *   MANDATES=12 npx tsx scripts/demo-reset.ts
 *   npx tsx scripts/demo-reset.ts --status   # report only, change nothing
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, formatEther, formatUnits,
  parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC, NETWORK, OrderKind, TOPICS } from "../packages/leash-ec/src/constants.js";
import { installUnwind, unwindPersistently } from "./unwind.js";
import { SHIP_GAS_LIMIT } from "./capfit.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../packages/leash-ec/src/discover.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const MANDATES = Number(process.env.MANDATES ?? 8);
const SUB_GAS_LIMIT = BigInt(SHIP_GAS_LIMIT);
const STATUS_ONLY = process.argv.includes("--status");

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing from .env`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(uint256)",
]);

const regAbi = parseAbi([
  "function createMandate(address,uint128,uint128,uint64,bytes32[]) returns (uint256)",
  "function placeForDelegator(uint256,bytes32,address,uint8,uint256,uint256,uint64) returns (uint128)",
  "function revoke(uint256)",
  "function nextMandateId() view returns (uint256)",
  "function isActive(uint256) view returns (bool)",
  "function remainingExposure(uint256) view returns (uint256)",
  "function pendingSettlement(bytes32) view returns (uint256)",
  "function holdsNoFunds() view returns (bool)",
]);

const hndAbi = parseAbi([
  "function subscriptionId() view returns (uint256)",
  "function batchCap() view returns (uint256)",
  "function invocations() view returns (uint256)",
]);

async function main() {
  if (!REGISTRY) throw new Error("MANDATE_REGISTRY not set in .env");
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wD = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wG = createWalletClient({ account: delegate, chain, transport: http(RPC) });

  const read = <T>(fn: string, args: unknown[] = []) =>
    pub.readContract({ address: REGISTRY, abi: regAbi, functionName: fn as never, args: args as never }) as Promise<T>;

  console.log("\n=== LEASH DEMO STATE ===");
  console.log(`registry ${REGISTRY}`);
  if (HANDLER) {
    const sub = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
    const cap = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" }) as bigint;
    const inv = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
    console.log(`handler  ${HANDLER}`);
    console.log(`         ${formatEther(await pub.getBalance({ address: HANDLER }))} STT · subscription ${sub === 0n ? "INACTIVE" : sub} · batchCap ${cap} · ${inv} invocations`);
    if (sub === 0n) console.log("         NOTE: not subscribed. Beat 3 will not fire until subscribeTo is called.");
  }
  console.log(`delegator ${delegator.address}  ${formatEther(await pub.getBalance({ address: delegator.address }))} STT`);
  console.log(`delegate  ${delegate.address}  ${formatEther(await pub.getBalance({ address: delegate.address }))} STT`);
  const tus = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  console.log(`delegator tUSDC ${formatUnits(tus, 6)}`);
  console.log(`registry holdsNoFunds() = ${await read<boolean>("holdsNoFunds")}`);

  const next = await read<bigint>("nextMandateId");
  let active = 0;
  for (let i = 1n; i < next; i++) if (await read<boolean>("isActive", [i])) active++;
  console.log(`mandates: ${next - 1n} created, ${active} active`);

  if (STATUS_ONLY) { console.log("\n(--status: nothing changed)\n"); return; }

  // ---- top up ------------------------------------------------------------
  if (tus < BigInt(MANDATES) * 3_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "faucet", args: [1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("topped up tUSDC from the public faucet");
  }
  const allow = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, REGISTRY] }) as bigint;
  if (allow < 100_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [REGISTRY, 500_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("delegator approved the registry");
  }

  // ---- retire whatever is still live -------------------------------------
  // Old mandates are revoked rather than left lying around, so a rehearsal never
  // inherits exposure from the previous one and rehearsal fifteen behaves like
  // rehearsal one.
  let retired = 0, retireFailed = 0;
  for (let i = 1n; i < next; i++) {
    if (!(await read<boolean>("isActive", [i]))) continue;
    try {
      const h = await wD.writeContract({ address: REGISTRY, abi: regAbi, functionName: "revoke", args: [i] as never });
      await pub.waitForTransactionReceipt({ hash: h });
      retired++;
    } catch { retireFailed++; }
  }
  if (retired) console.log(`retired ${retired} mandate(s) from the previous run`);
  // A silent failure here means a rehearsal inherits live exposure from the last
  // one, which is precisely how run fifteen stops matching run one.
  if (retireFailed) console.log(`WARNING: ${retireFailed} mandate(s) could NOT be retired — state is NOT clean`);

  // ---- pick a market -----------------------------------------------------
  const disc = ecClient(RPC);
  const found = await discoverMarkets(disc, { windows: 12 });
  const r = await tradableMarketsDetailed(disc, found, { headroomSec: 120n, limit: 3, maxChecks: 20 });
  console.log(`discovery: ${found.length} created, ${r.checked} checked, ${r.errors} errors, ${r.live.length} tradable`);
  if (r.live.length === 0) throw new Error("no tradable market — cannot seed");

  // NEVER SEED ONTO A MARKET THAT ALREADY CARRIES RESERVATIONS.
  //
  // Retiring mandates above does NOT close their reservations — only settleOne
  // does, and that needs the market resolved. So a market that inherited
  // reservations from an abandoned run cannot be cleaned; it can only be
  // avoided.
  //
  // This is the failure it prevents, and it has already happened once: leftover
  // reservations from an earlier run inflate `pending`, the batch clips at the
  // cap, and beat 3 shows a PARTIAL settle instead of the whole set landing
  // together. On camera that reads as the Deadhand not working. The gap between
  // the set we seed and the cap is only a few stale reservations wide.
  let mk: typeof r.live[number] | undefined;
  const dirty: string[] = [];
  for (const cand of r.live) {
    const pend = await read<bigint>("pendingSettlement", [cand.marketId]);
    if (pend === 0n) { mk = cand; break; }
    dirty.push(`${cand.marketId.slice(0, 12)}…:${pend}`);
  }
  if (!mk) {
    throw new Error(
      `every tradable market already carries open reservations (${dirty.join(", ")}). ` +
      "They cannot be drained until those markets resolve — wait for the next window rather than seeding on top of them.",
    );
  }
  if (dirty.length) console.log(`skipped ${dirty.length} market(s) carrying stale reservations: ${dirty.join(", ")}`);
  const ttl = Number(mk.expiry) - Math.floor(Date.now() / 1000);
  console.log(`seeding on ${mk.asset}, ttl ${ttl}s, marketId ${mk.marketId.slice(0, 18)}...`);

  // ---- seed the set ------------------------------------------------------
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const ids: bigint[] = [];
  for (let i = 0; i < MANDATES; i++) {
    const id = await read<bigint>("nextMandateId");
    const h = await wD.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "createMandate",
      args: [delegate.address, 2_000_000n, 5_000_000n, expiry, [mk.marketId]] as never,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    ids.push(id);
  }
  console.log(`created ${ids.length} mandates: ${ids[0]}..${ids[ids.length - 1]}`);

  // Resting orders: at finalization these are exactly the dead exposure the
  // Deadhand releases, which is what the audience sees settle together.
  // Capped at the market's expiry (OrderExpiryBeyondMarket otherwise), so sit
  // just inside it and the orders are still resting when the market resolves.
  const expireNs = (mk.expiry - 2n) * 1_000_000_000n;
  let placed = 0;
  for (const id of ids) {
    try {
      const h = await wG.writeContract({
        address: REGISTRY, abi: regAbi, functionName: "placeForDelegator",
        args: [id, mk.marketId, mk.pool, OrderKind.BUY_YES, 20_000n, 1_000_000n, expireNs] as never,
      });
      await pub.waitForTransactionReceipt({ hash: h });
      placed++;
    } catch (e) { console.log(`  mandate ${id} order failed: ${(e as Error).message.split(String.fromCharCode(10))[0]}`); }
  }
  console.log(`placed ${placed}/${ids.length} resting orders`);

  // ASSERT the state we built, rather than printing it and hoping someone
  // reads the number. We started this market at zero pending and placed
  // `placed` orders, so pending must be exactly `placed`.
  const pendAfter = await read<bigint>("pendingSettlement", [mk.marketId]);
  if (pendAfter !== BigInt(placed)) {
    throw new Error(
      `expected ${placed} open reservations on this market, found ${pendAfter}. ` +
      "State arrived from somewhere it was not put; do not rehearse against it.",
    );
  }
  console.log(`pending settlement on the market: ${pendAfter} (matches the ${placed} seeded)`);
  const capNow = await pub.readContract({ address: HANDLER as Address, abi: hndAbi, functionName: "batchCap" }) as bigint;
  if (BigInt(placed) > capNow) {
    console.log(`WARNING: ${placed} seeded exceeds batchCap ${capNow} — beat 3 will settle a PARTIAL batch on camera`);
  }
  console.log(`registry holdsNoFunds() = ${await read<boolean>("holdsNoFunds")}`);

  // ---- arm the subscription, or say plainly that beat 3 will not fire -----
  //
  // Seeding is not enough. Without a live subscription the validators never
  // invoke the handler and beat 3 simply does not happen — which on camera
  // reads as the Deadhand failing rather than as nobody having turned it on.
  // There was no command for this before, so it is here.
  const subNow = await pub.readContract({ address: HANDLER as Address, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
  if (process.env.ARM === "1" && subNow === 0n) {
    const ah = await wD.writeContract({
      address: HANDLER as Address, abi: hndAbi, functionName: "subscribeTo",
      args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, SUB_GAS_LIMIT, 7_000_000_000n] as never,
    });
    await pub.waitForTransactionReceipt({ hash: ah });
    const sub = await pub.readContract({ address: HANDLER as Address, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
    if (sub === 0n) throw new Error("subscribeTo mined but subscriptionId is still 0 — beat 3 will NOT fire");
    console.log(`
ARMED  subscription ${sub} at gasLimit ${SUB_GAS_LIMIT}`);
    console.log(`       ~0.0017 STT per finalization while armed. DISARM AFTER THE TAKE.`);
  } else if (subNow !== 0n) {
    console.log(`
already armed: subscription ${subNow}`);
  } else {
    console.log(`
NOT ARMED — beat 3 will not fire. Re-run with ARM=1 to subscribe.`);
  }

  console.log(`\nready. ${placed} mandates will settle together when this market resolves.\n`);
}

// Arming spends on every finalization, so Ctrl-C must disarm rather than walk
// away from it. A crashed run once left one armed across 400 invocations.
installUnwind();
main()
  .then(() => process.exit(0))
  .catch(async (e) => { console.error(e); await unwindPersistently(); process.exit(1); });
