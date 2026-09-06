/**
 * STAGE 3 — Deadhand against a real market resolution.
 *
 * Seeds SEVERAL mandates on one market on purpose. A single-mandate revocation
 * and a batch settling together are the same code and completely different in
 * the room: the batch is what makes "one subscription serves every delegation"
 * a thing seen rather than a thing claimed.
 *
 * TWO THINGS THIS SCRIPT REFUSES TO DO, both because it did them once:
 *
 *  1. It will not set `batchCap` from a single run. Gas per mandate from one
 *     batch is a fixed-cost artefact — the same handler "measured" 171,964 and
 *     then 106,422 gas per mandate against a true marginal of ~56,700. Points
 *     accumulate in `.measurements/deadhand-fit.json` and the cap is set only
 *     from a LINE fitted across at least two distinct batch sizes on identical
 *     bytecode. One point prints a refusal, not a number.
 *
 *  2. It will not exit 0 with a subscription still armed. A crashed poll loop
 *     once left one running and burned ~0.19 STT across 400 unattended
 *     invocations.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, formatEther, formatUnits,
  parseAbi, decodeEventLog, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installUnwind, emergencyUnsubscribe, stillArmed, unwindPersistently } from "./unwind.js";
import { poll } from "./retry.js";
import { capFrom, fit as fitLine, SHIP_GAS_LIMIT, WRAPPER_OVERHEAD, HEADROOM, type Point } from "./capfit.js";
import { EC, NETWORK, OrderKind, TOPICS } from "../packages/leash-ec/src/constants.js";
import { ecClient, discoverMarkets, tradableMarkets } from "../packages/leash-ec/src/discover.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const MANDATES = Number(process.env.MANDATES ?? 3);
const FIT_FILE = ".measurements/deadhand-fit.json";

/**
 * The gas the subscription is armed with, and the fraction of it we are willing
 * to plan a batch against. The gap is not timidity: a batch that fits on average
 * and reverts on a heavy one is worse than a smaller cap that never fails, and
 * an invocation that runs out of gas settles nothing at all.
 */
// 8M, NOT the 3M this used to arm, and the change is forced by measurement
// rather than chosen: a 12-mandate settle costs 3,301,786 gas in-body, so under
// a 3M subscription the demo's own headline batch runs out of gas and settles
// nothing. The chain charges on gas USED, not on `gasLimit` — confirmed again
// here, since raising the limit from 3M to 10M LOWERED the per-invocation cost
// — so the wider limit buys the batch and costs nothing when the callback exits
// early. 10M was accepted and invoked 100 times, so limits above 3M are live,
// not assumed.
//
// SHIP_GAS_LIMIT is what the cap is sized against; keep the two equal unless
// deliberately measuring with extra headroom.
const SUB_GAS_LIMIT = BigInt(process.env.SUB_GAS_LIMIT ?? SHIP_GAS_LIMIT);

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing`);
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
  "function settleFinalizedMarket(bytes32,uint256) returns (uint256,uint256,bool)",
  "function pendingSettlement(bytes32) view returns (uint256)",
  "function remainingExposure(uint256) view returns (uint256)",
  "function isActive(uint256) view returns (bool)",
  "function nextMandateId() view returns (uint256)",
  "function holdsNoFunds() view returns (bool)",
]);

const hndAbi = parseAbi([
  "function subscribeTo(address,bytes32,uint64,uint64) returns (uint256)",
  "function unsubscribeNow()",
  "function setBatchCap(uint256)",
  "function batchCap() view returns (uint256)",
  "function invocations() view returns (uint256)",
  "function marketsSettled() view returns (uint256)",
  "function skippedNoPending() view returns (uint256)",
  "function skippedShape() view returns (uint256)",
  "function seen(bytes32) view returns (uint32)",
  "function subscriptionId() view returns (uint256)",
  "function withdraw()",
  "event Deadhand(bytes32 indexed marketId, address indexed pool, uint256 processed, uint256 failed, bool drained, uint256 gasUsed)",
  "event DeadhandSaw(bytes32 indexed marketId)",
  "event DeadhandFailed(bytes32 indexed marketId, bytes reason)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the fit -------------------------------------------------------------

function loadPoints(codeHash: string): Point[] {
  if (!existsSync(FIT_FILE)) return [];
  const all = JSON.parse(readFileSync(FIT_FILE, "utf8")) as Point[];
  // Points from a different build describe a different function. Keeping them
  // is how a stale number survives into a published claim.
  return all.filter((p) => p.codeHash === codeHash);
}

function savePoint(p: Point): void {
  mkdirSync(".measurements", { recursive: true });
  const all: Point[] = existsSync(FIT_FILE) ? JSON.parse(readFileSync(FIT_FILE, "utf8")) : [];
  // One transaction is one measurement. A killed run wrote its point anyway,
  // after the process was believed dead, and the same n=32 settle ended up in
  // the file twice — harmless here because the duplicate was identical, but it
  // double-weights that point in the fit and would skew a later one.
  if (all.some((x) => x.tx === p.tx)) {
    console.log(`  point for ${p.tx.slice(0, 12)}… already recorded — not duplicating`);
    return;
  }
  all.push(p);
  writeFileSync(FIT_FILE, JSON.stringify(all, null, 2));
}

async function main() {
  if (!REGISTRY || !HANDLER) throw new Error("MANDATE_REGISTRY / DEADHAND_HANDLER not set in .env");
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const stranger = acct("STRANGER_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wD = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wG = createWalletClient({ account: delegate, chain, transport: http(RPC) });
  const wS = createWalletClient({ account: stranger, chain, transport: http(RPC) });

  // Every measurement below is tagged with this. A point measured on other
  // bytecode is a point about another program.
  const code = (await pub.getBytecode({ address: HANDLER })) ?? "0x";
  const codeHash = keccak256(code as Hex);

  console.log(`\nSTAGE 3 — Deadhand   (n = ${MANDATES})`);
  console.log(`  registry ${REGISTRY}`);
  console.log(`  handler  ${HANDLER}  ${formatEther(await pub.getBalance({ address: HANDLER }))} STT`);
  console.log(`  codehash ${codeHash}\n`);

  // ---- pick a market that will finalize SOON ------------------------------
  const disc = ecClient(RPC);
  const found = await discoverMarkets(disc, { windows: 30 });
  const live = await tradableMarkets(disc, found, { headroomSec: 70n, limit: 40 });
  const now = Math.floor(Date.now() / 1000);
  const withTtl = live.map((m) => ({ m, ttl: Number(m.expiry) - now })).sort((a, b) => a.ttl - b.ttl);
  console.log(`  ${found.length} created / ${live.length} tradable; ttls(s): ${withTtl.map((x) => x.ttl).join(", ")}`);
  // Seeding N mandates plus N orders is ~2 transactions each at ~3.5s, so pick a
  // market whose ttl comfortably exceeds that. Choosing the SOONEST market meant
  // subscribing after it had already resolved — finalization lands at expiry
  // +/-60s and can be up to 300s EARLY, so "soonest" is the wrong heuristic.
  const setupS = MANDATES * 7 + 30;
  const lo = setupS + 90;
  // Markets come in SERIES, not a continuum: observed ttls cluster at
  // 78 / 1878 / 12678 s, so a narrow band can fall entirely in a gap between
  // series and report "no market" on a perfectly healthy venue. Take the
  // soonest that clears setup, from a wide band.
  const soon = withTtl.filter((x) => x.ttl > lo && x.ttl < 3600)[0];
  if (!soon) throw new Error(`no market with ttl in ${lo}-3600s (setup needs ~${setupS}s; live: ${live.length}; ttls: ${withTtl.map((x) => x.ttl).join(",")})`);
  console.log(`  setup needs ~${setupS}s, so requiring ttl > ${lo}s`);
  const { m: mk, ttl } = soon;
  console.log(`  market ${mk.asset} ttl=${ttl}s  marketId=${mk.marketId}`);
  console.log(`  pool   ${mk.pool}\n`);

  // ---- collateral + allowance --------------------------------------------
  let bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  if (bal < 40_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "faucet", args: [1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const allow = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, REGISTRY] }) as bigint;
  if (allow < 100_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [REGISTRY, 500_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("  [delegator] approved registry");
  }

  // ---- seed SEVERAL mandates on the same market ---------------------------
  const expiry = BigInt(now + 3600);
  const ids: bigint[] = [];
  for (let i = 0; i < MANDATES; i++) {
    const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
    const h = await wD.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "createMandate",
      args: [delegate.address, 2_000_000n, 5_000_000n, expiry, [mk.marketId]] as never,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    ids.push(next);
  }
  console.log(`  [delegator] created ${ids.length} mandates: ${ids.join(", ")}`);

  // ---- delegate places one order per mandate ------------------------------
  // Priced low so they REST rather than fill: a resting order at finalization is
  // exactly the dead exposure the handler exists to release.
  const price = 20_000n;
  const qty = 1_000_000n;
  // Order expiry is CAPPED AT THE MARKET'S OWN EXPIRY — exceeding it reverts
  // OrderExpiryBeyondMarket (0xd3dea628). Sit just inside it so the order is
  // still open when the market resolves.
  const expireNs = (mk.expiry - 2n) * 1_000_000_000n;
  for (const id of ids) {
    const h = await wG.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "placeForDelegator",
      args: [id, mk.marketId, mk.pool, OrderKind.BUY_YES, price, qty, expireNs] as never,
    });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  [delegate] mandate ${id} order placed  status=${r.status}`);
  }
  const pending = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId] }) as bigint;
  console.log(`  pending settlement on this market: ${pending}`);
  if (pending < BigInt(MANDATES)) {
    console.log(`  WARNING: only ${pending} of ${MANDATES} reservations are open — the batch measured will be smaller than n`);
  }
  console.log("");

  // ---- subscribe ----------------------------------------------------------
  const balBefore = await pub.getBalance({ address: HANDLER });
  const invBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const skipBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "skippedNoPending" }) as bigint;
  const settledBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
  const fromBlock = await pub.getBlockNumber();
  const capNow = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" }) as bigint;
  if (capNow < BigInt(MANDATES)) {
    throw new Error(`batchCap ${capNow} < n ${MANDATES}: the cap would clip the batch and the measured point would be a point about the cap, not about the work`);
  }
  let h = await wD.writeContract({
    address: HANDLER, abi: hndAbi, functionName: "subscribeTo",
    args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, SUB_GAS_LIMIT, 7_000_000_000n] as never,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  const subId = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "subscriptionId" }) as bigint;

  // Finalization lands at expiry +/-60s and can be up to 300s EARLY, so do not
  // guess a duration: POLL until the handler settles, and stop as soon as it
  // does. A fixed window is a coin flip; this is a wait.
  const maxWaitS = Number(process.env.MAX_WAIT_S ?? 2400);
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitS * 1000;
  let settledNow = 0n;
  console.log(`  subscribed id=${subId}, polling until settle (max ${maxWaitS}s)...`);
  // A failed progress read is NOT a failed run. One eth_call timeout inside this
  // loop once killed a fifty-minute measurement and lost the point it had spent
  // twenty orders to get. `poll` returns null when it could not read, which is
  // deliberately distinguishable from reading a zero.
  while (Date.now() < deadline) {
    await sleep(15_000);
    const s = await poll(() => pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as Promise<bigint>, { label: "marketsSettled" });
    if (s === null) continue;
    settledNow = s;
    const pend = await poll(() => pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId] }) as Promise<bigint>, { label: "pendingSettlement" });
    if (pend === null) continue;
    // Break on OUR settle having happened, not on the market being drained.
    // When pending exceeds batchCap the handler settles a capped slice and
    // leaves the rest, so `pend == 0` never arrives and the loop runs to its
    // deadline reporting "no settle" for a run that settled perfectly well.
    // Stale reservations from a previous crashed run are enough to cause it.
    if (settledNow > settledBefore) {
      console.log(`  settled after ${Math.round((Date.now() - startedAt) / 1000)}s (pending left on market: ${pend})`);
      break;
    }
  }
  if (settledNow === 0n) console.log("  WARNING: hit the poll deadline with no settle");

  // Unsubscribing is not best-effort. Exiting 0 with a live subscription is the
  // failure that costs money while nobody is looking.
  try {
    const u = await wD.writeContract({ address: HANDLER, abi: hndAbi, functionName: "unsubscribeNow" });
    await pub.waitForTransactionReceipt({ hash: u });
    console.log("  unsubscribed");
  } catch (e) {
    console.error("  unsubscribe FAILED, retrying via unwind:", (e as Error).message.split(String.fromCharCode(10))[0]);
    await unwindPersistently();
  }
  if (await stillArmed()) {
    throw new Error(`SUBSCRIPTION STILL ARMED on ${HANDLER} — cancel it by hand NOW; it spends on every finalization`);
  }

  // ---- H1: was OUR market delivered at all? -------------------------------
  //
  // `invocations` cannot answer this — it counts every delivery on the venue.
  // `seen[marketId]` counts deliveries of THIS market, recorded before the
  // handler decides anything, which is what makes the two hypotheses different
  // numbers instead of the same silence.
  const seenOurs = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "seen", args: [mk.marketId] }) as number;
  const invAfter = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const skipAfter = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "skippedNoPending" }) as bigint;
  const shapeSkips = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "skippedShape" }) as bigint;
  const balAfter = await pub.getBalance({ address: HANDLER });

  console.log(`\n  invocations ${invBefore} -> ${invAfter}  (+${invAfter - invBefore})`);
  console.log(`  skippedNoPending +${skipAfter - skipBefore}   skippedShape total ${shapeSkips}`);
  console.log(`  STT spent   ${formatEther(balBefore - balAfter)}`);
  console.log(`  seen[our marketId] = ${seenOurs}`);
  if (seenOurs === 0) {
    console.log(`  H1a — our market's MarketFinalized NEVER REACHED the handler.`);
    console.log(`        The subscription delivered ${invAfter - invBefore} other events, so delivery works;`);
    console.log(`        the gap is this market. Investigate emitter/topic0 vs the finalizing contract.`);
  } else if (settledNow === 0n) {
    console.log(`  H1b — DELIVERED ${seenOurs}x and not settled. The handler saw it and decided no.`);
    console.log(`        pendingSettlement was 0 at callback time: a marketId keying mismatch.`);
  } else {
    console.log(`  delivered ${seenOurs}x and settled — neither H1a nor H1b on this run.`);
  }

  // ---- logs ---------------------------------------------------------------
  const head = await pub.getBlockNumber();
  const SPAN = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const logs: { data: Hex; topics: readonly Hex[]; transactionHash: Hex | null }[] = [];
  for (let hi = head; hi > fromBlock; hi -= SPAN + 1n) {
    const lo2 = hi - SPAN > fromBlock ? hi - SPAN : fromBlock;
    const page = await pub.getLogs({ address: HANDLER, fromBlock: lo2, toBlock: hi });
    logs.push(...(page as unknown as typeof logs));
    if (lo2 === fromBlock) break;
  }

  let ourSettle: { processed: bigint; drained: boolean; gasUsed: bigint; tx: Hex | null } | null = null;
  let decodeFailures = 0;
  const deadhandTopic0 = keccak256(toHex("Deadhand(bytes32,address,uint256,uint256,bool,uint256)"));
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: hndAbi, data: l.data, topics: l.topics as never });
      if (d.eventName === "Deadhand") {
        const a = d.args as unknown as { marketId: Hex; processed: bigint; failed: bigint; drained: boolean; gasUsed: bigint };
        console.log(`  Deadhand: market ${a.marketId.slice(0, 14)}... processed=${a.processed} failed=${a.failed} drained=${a.drained} gas=${a.gasUsed}`);
        console.log(`            ${NETWORK.explorer}/tx/${l.transactionHash}`);
        if (a.marketId.toLowerCase() === mk.marketId.toLowerCase()) {
          ourSettle = { processed: a.processed, drained: a.drained, gasUsed: a.gasUsed, tx: l.transactionHash };
        }
      }
      if (d.eventName === "DeadhandFailed") console.log(`  DeadhandFailed on ${(d.args as never as {marketId:Hex}).marketId.slice(0,14)}...`);
    } catch (err) {
      // Not "some other event" by assumption: a Deadhand event that fails to
      // decode would otherwise surface as "our market did not settle", which is
      // a plausible verdict for what is actually a decode bug.
      if (l.topics[0] === deadhandTopic0) {
        console.log(`  WARN: a Deadhand log FAILED TO DECODE — ${(err as Error).message.split(String.fromCharCode(10))[0]}`);
        decodeFailures++;
      }
    }
  }
  if (decodeFailures > 0) console.log(`  ${decodeFailures} Deadhand log(s) did not decode — treat this run as unmeasured`);

  // ---- the measured point, and only a fitted cap --------------------------
  if (ourSettle && ourSettle.processed > 0n && decodeFailures === 0) {
    const point: Point = {
      n: Number(ourSettle.processed),
      gas: Number(ourSettle.gasUsed),
      marketId: mk.marketId,
      tx: ourSettle.tx ?? "",
      codeHash,
      at: new Date().toISOString(),
      subGasLimit: SUB_GAS_LIMIT.toString(),
      firstEver: settledBefore === 0n,
    };
    savePoint(point);
    console.log(`\n  POINT: ${point.gas} gas for ${point.n} mandates   ${NETWORK.explorer}/tx/${point.tx}`);

    const all = loadPoints(codeHash);
    console.log(`  points on this bytecode: ${all.map((p) => `n=${p.n}:${p.gas}${p.firstEver ? "(first)" : ""}`).join("  ")}`);

    // The cap comes from scripts/capfit.ts — the SAME module verify.ts asserts
    // against. They used to compute it separately, this one reserving an
    // underived "5/6 of the limit" and verify using the measured wrapper
    // overhead, so the on-chain value depended on which ran last. It drifted on
    // chain within an hour of the assertion being written.
    const f = capFrom(all);
    if (!f) {
      console.log(`  ONE BATCH SIZE IS NOT A LINE. ${all.length} point(s) at ${new Set(all.map((p) => p.n)).size} distinct n.`);
      console.log(`  batchCap left at ${await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" })}, UNBACKED.`);
      console.log(`  Re-run with a different MANDATES= to fit fixed vs marginal cost.`);
    } else {
      console.log(`  FIT over ${f.usedPoints} points${f.excludedFirstEver ? " (first-ever settle excluded)" : ""}:`);
      console.log(`    fixed ~${Math.round(f.fixed).toLocaleString()} + marginal ~${Math.round(f.marginal).toLocaleString()} gas/mandate in-body`);
      console.log(`    +${WRAPPER_OVERHEAD.toLocaleString()} measured wrapper, against a ${SHIP_GAS_LIMIT.toLocaleString()} gasLimit`);
      console.log(`  binds at ~${f.binds} mandates; shipping ${f.cap} at ${HEADROOM * 100}% (a full batch charges ~${f.charges.toLocaleString()})`);
      if (f.cap < 1) throw new Error(`fit produced a cap of ${f.cap}: at ${Math.round(f.marginal)} gas/mandate nothing fits. Raise the gasLimit or cut per-mandate work — do not ship a cap that cannot run.`);
      const setTx = await wD.writeContract({ address: HANDLER, abi: hndAbi, functionName: "setBatchCap", args: [BigInt(f.cap)] as never });
      await pub.waitForTransactionReceipt({ hash: setTx });
      console.log(`  batchCap = ${await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" })}, from a fitted line`);
    }
  } else {
    console.log("\n  no usable measurement this run — see the H1 verdict above for why");
  }

  // ---- state after --------------------------------------------------------
  console.log("");
  for (const id of ids) {
    const rem = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "remainingExposure", args: [id] }) as bigint;
    const act = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "isActive", args: [id] }) as boolean;
    console.log(`  mandate ${id}: remaining ${formatUnits(rem, 6)} tUSDC, active=${act}`);
  }
  console.log(`  registry holdsNoFunds() = ${await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "holdsNoFunds" })}`);
  console.log(`  pending on market now   = ${await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId] })}`);

  // ---- DELETE-TEST --------------------------------------------------------
  console.log("\n  [delete-test] settling from the STRANGER key, handler not involved");
  const st = await wS.writeContract({ address: REGISTRY, abi: regAbi, functionName: "settleFinalizedMarket", args: [mk.marketId, 32n] as never });
  const sr = await pub.waitForTransactionReceipt({ hash: st });
  console.log(`                status=${sr.status}  ${NETWORK.explorer}/tx/${st}`);
  console.log(`                Layer 1 settles with no handler in the path.\n`);
}

// This script arms a subscription, so it must be able to disarm one.
installUnwind();
main()
  .then(async () => {
    // Belt and braces: the success path already unsubscribes and throws if it
    // could not, but exiting 0 while armed is the one outcome worth two checks.
    if (await stillArmed()) { console.error("EXITING NON-ZERO: subscription still armed"); process.exit(1); }
    process.exit(0);
  })
  .catch(async (e) => { console.error(e); await unwindPersistently(); process.exit(1); });
