/**
 * STAGE 5 — the twenty runs.
 *
 * Runs the full three-beat flow end to end, repeatedly, at whatever hours it is
 * left running, and records every outcome to `.measurements/rehearsals.json`.
 *
 * It is a HUNT, not a demo. The specific quarry named in the roadmap is
 * `status = 1` with nothing traded and no order resting — a transaction that
 * mines, reports success, and did nothing. `ec-core` has no guard against it on
 * the binary path, and it is the failure most likely to happen on stage while
 * looking like everything worked.
 *
 * The three beats, each asserted against the chain rather than assumed:
 *
 *   BEAT 1  can't take     the delegate broadcasts revoke() on the delegator's
 *                          own mandate. It must MINE and REVERT — status 0 on a
 *                          real transaction, our own NotDelegator check, not an
 *                          incidental failure. Simulation is not enough here:
 *                          the demo claims an explorer link, so the rehearsal
 *                          has to produce one.
 *   BEAT 2  can trade      the same key places an Event Contract order that
 *                          FILLS. Asserted by BinaryOrderPlaced in the receipt
 *                          plus an OrderFilled whose takerOrderId matches the id
 *                          READ FROM THE RECEIPT — never the simulated id, which
 *                          differs and looks entirely plausible.
 *   BEAT 3  can't overreach a second mandate is seeded to expire BEFORE the
 *                          market resolves, and left holding a resting order.
 *                          When validators invoke the handler they must settle
 *                          it, revoke it, and sweep its escrow to the DELEGATOR.
 *
 * Beat 3's breach is the clock, not the budget, and that is forced by the
 * design rather than chosen: `maxCumulativeExposure` is enforced at placement,
 * so `usedExposure` can never exceed it by the normal path. The reachable
 * breach is `block.timestamp >= m.expiry` at settlement time — a delegate whose
 * order outlives the mandate that authorised it.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, formatEther, formatUnits,
  parseAbi, encodeFunctionData, decodeEventLog, decodeErrorResult, keccak256, toHex,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installUnwind, emergencyUnsubscribe, stillArmed, unwindPersistently } from "./unwind.js";

/**
 * The revert NAME, decoded from raw return data.
 *
 * Taking `message.split("
")[0]` yields 'reverted with the following
 * signature:' and stops exactly before the selector — the one part that says
 * what happened. A failure report that omits the reason is how run 16 arrived
 * as "placeForDelegator reverted" with no way to tell Expired from
 * MarketNotAllowed.
 */
function why(e: unknown, abi: readonly unknown[]): string {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try { return decodeErrorResult({ abi: abi as never, data: d as Hex }).errorName; }
      catch { return `undecoded ${d.slice(0, 10)}`; }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return ((e as Error).message ?? String(e)).split(String.fromCharCode(10))[0] ?? "unknown";
}
import { EC, NETWORK, OrderKind, TOPICS } from "../packages/leash-ec/src/constants.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../packages/leash-ec/src/discover.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const RUNS = Number(process.env.RUNS ?? 20);
const SUB_GAS_LIMIT = BigInt(process.env.SUB_GAS_LIMIT ?? 8_000_000);
const LOG = ".measurements/rehearsals.json";
/**
 * How long the doomed mandate lives. Long enough to survive setup on a slow
 * run, short enough to be expired by the time the market resolves — which is
 * what makes the validator revoke it.
 */
const DOOMED_TTL_S = Number(process.env.DOOMED_TTL_S ?? 140);

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
  "function revoke(uint256)",
  "function pendingSettlement(bytes32) view returns (uint256)",
  "function nextMandateId() view returns (uint256)",
  "function holdsNoFunds() view returns (bool)",
  "function unattributed() view returns (uint256)",
  "function mandates(uint256) view returns (address delegator, address delegate, uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint128 usedExposure, uint64 expiry, bool revoked, bool exists)",
  "event MandateRevoked(uint256 indexed mandateId, address indexed by, string reason)",
  "event PayoutSwept(uint256 indexed mandateId, address indexed to, uint256 amount, bytes32 marketId)",
  "event OrderPlacedFor(uint256 indexed mandateId, bytes32 indexed marketId, address indexed pool, uint128 orderId, uint128 reserved, uint128 usedExposure)",
]);

const hndAbi = parseAbi([
  "function subscribeTo(address,bytes32,uint64,uint64) returns (uint256)",
  "function unsubscribeNow()",
  "function batchCap() view returns (uint256)",
  "function invocations() view returns (uint256)",
  "function marketsSettled() view returns (uint256)",
  "function seen(bytes32) view returns (uint32)",
  "function subscriptionId() view returns (uint256)",
  "event Deadhand(bytes32 indexed marketId, address indexed pool, uint256 processed, uint256 failed, bool drained, uint256 gasUsed)",
]);

/** BinaryOrderPlaced / OrderFilled, resolved by topic0 rather than by name. */
const BINARY_ORDER_PLACED = TOPICS.BinaryOrderPlaced as Hex;
const ORDER_FILLED = TOPICS.OrderFilled as Hex;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => h.slice(0, 12) + "…";

interface Run {
  n: number;
  at: string;
  marketId: string;
  ok: boolean;
  beats: { one: string | null; two: string | null; three: string | null };
  failure: string | null;
  detail: string;
  filled: boolean;
  rested: boolean;
  revokedByDeadhand: boolean;
  sweptToDelegator: string | null;
  handlerGas: string | null;
}

function append(r: Run) {
  mkdirSync(".measurements", { recursive: true });
  const all: Run[] = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
  all.push(r);
  writeFileSync(LOG, JSON.stringify(all, null, 2));
}

const pub = createPublicClient({ chain, transport: http(RPC) });

// ---- one rehearsal --------------------------------------------------------

async function oneRun(n: number): Promise<Run> {
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const wD = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wG = createWalletClient({ account: delegate, chain, transport: http(RPC) });

  const run: Run = {
    n, at: new Date().toISOString(), marketId: "", ok: false,
    beats: { one: null, two: null, three: null },
    failure: null, detail: "", filled: false, rested: false,
    revokedByDeadhand: false, sweptToDelegator: null, handlerGas: null,
  };

  // ---- market ------------------------------------------------------------
  // Setup is ~6 transactions at ~3.5s. The venue runs 60s / 300s / 3600s
  // windows in BTC and ETH, so the 300s series is the one that gives a full
  // three-beat cycle in minutes rather than an hour. Needs enough ttl left for
  // setup plus a margin, or we subscribe after the market has already resolved.
  const disc = ecClient(RPC);
  const found = await discoverMarkets(disc, { windows: 12 });
  const r = await tradableMarketsDetailed(disc, found, { headroomSec: 60n, limit: 8, maxChecks: 20 });
  if (r.live.length === 0) {
    run.failure = r.errors > 0 ? "rpc-degraded" : "no-tradable-market";
    run.detail = `${r.live.length} live, ${r.checked} checked, ${r.errors} errors`;
    return run;
  }
  const now = Math.floor(Date.now() / 1000);
  const SETUP_S = 60;
  const candidates = r.live
    .map((m) => ({ m, ttl: Number(m.expiry) - now }))
    .filter((x) => x.ttl > SETUP_S + 90 && x.ttl < 1800)
    .sort((a, b) => a.ttl - b.ttl);

  // REFUSE A MARKET THAT ALREADY CARRIES RESERVATIONS.
  //
  // A crashed run leaves its reservations OPEN, and revoking the mandate does
  // not close them — only `settleOne` does, which needs the market resolved.
  // So an unresolved market that has inherited reservations cannot be drained
  // at all; it can only be avoided.
  //
  // This is a demo risk, not a measurement curiosity. It already happened: a
  // dead run left 20 open, the next run on the same market found 40 pending
  // against a cap of 32, and the batch was clipped. On rehearsal night the same
  // mechanism turns "twelve mandates settle together" into a partial settle on
  // camera — and the gap between 12 seeded and a cap of 15 is three stale
  // reservations wide.
  let usable: { m: typeof r.live[number]; ttl: number } | undefined;
  const skipped: string[] = [];
  for (const c of candidates) {
    const pend = await pub.readContract({
      address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [c.m.marketId],
    }) as bigint;
    if (pend === 0n) { usable = c; break; }
    skipped.push(`${short(c.m.marketId)}:${pend}`);
  }
  if (!usable) {
    run.failure = candidates.length === 0 ? "no-window" : "all-markets-carry-stale-reservations";
    run.detail = candidates.length === 0
      ? `ttls: ${r.live.map((m) => Number(m.expiry) - now).join(",")} — none in ${SETUP_S + 90}..1800s`
      : `every usable market already has open reservations: ${skipped.join(", ")}`;
    return run;
  }
  if (skipped.length) console.log(`  skipped ${skipped.length} market(s) carrying stale reservations: ${skipped.join(", ")}`);
  const mk = usable.m;
  run.marketId = mk.marketId;
  console.log(`\n[run ${n}] ${mk.asset} ttl=${usable.ttl}s market=${short(mk.marketId)} pool=${short(mk.pool)}`);

  // ---- collateral --------------------------------------------------------
  const bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  if (bal < 20_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "faucet", args: [1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const allow = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, REGISTRY] }) as bigint;
  if (allow < 50_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [REGISTRY, 500_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }

  // ---- two mandates: one that survives, one that outlives its clock -------
  //
  // The doomed mandate must still be LIVE when its order is placed and EXPIRED
  // when the market resolves. 75s was too tight: beat 1 and beat 2 each cost a
  // broadcast and a receipt, and on a slow run the mandate expired before its
  // own order could be placed — reverting Expired and failing a run for a
  // reason that has nothing to do with the product.
  const marketEnd = Number(mk.expiry);
  const ids: bigint[] = [];
  for (const expiry of [BigInt(marketEnd + 3600), BigInt(now + DOOMED_TTL_S)]) {
    const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
    const h = await wD.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "createMandate",
      args: [delegate.address, 5_000_000n, 10_000_000n, expiry, [mk.marketId]] as never,
    });
    await pub.waitForTransactionReceipt({ hash: h });
    ids.push(next);
  }
  const [live, doomed] = ids as [bigint, bigint];
  console.log(`  mandates ${live} (survives) / ${doomed} (expires before resolution)`);

  // ---- BEAT 1: the delegate cannot take ----------------------------------
  //
  // BROADCAST, not simulate. writeContract estimates gas first and would throw
  // before anything reached the chain, so this builds the calldata and sends it
  // with an explicit gas limit. The demo claims an explorer link; producing one
  // is the whole point.
  try {
    const data = encodeFunctionData({ abi: regAbi, functionName: "revoke", args: [live] });
    const h = await wG.sendTransaction({ to: REGISTRY, data, gas: 120_000n });
    const rec = await pub.waitForTransactionReceipt({ hash: h });
    run.beats.one = h;
    if (rec.status !== "reverted") {
      run.failure = "beat1-did-not-revert";
      run.detail = `the delegate REVOKED the delegator's mandate — authorization is broken (${h})`;
      return run;
    }
    console.log(`  beat 1  reverted on chain  ${NETWORK.explorer}/tx/${h}`);
  } catch (e) {
    run.failure = "beat1-broadcast-failed";
    run.detail = (e as Error).message.split(String.fromCharCode(10))[0] ?? "";
    return run;
  }

  // ---- BEAT 2: a real order that fills ------------------------------------
  //
  // Priced to the top of the range. A taker is charged the FILL price, not the
  // price it offered, so aggression is free and it removes the stale-book
  // failure mode that leaves an order resting instead of filled.
  const expireNs = (mk.expiry - 5n) * 1_000_000_000n;
  let orderId: bigint | null = null;
  try {
    const h = await wG.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "placeForDelegator",
      args: [live, mk.marketId, mk.pool, OrderKind.BUY_YES, 990_000n, 2_000_000n, expireNs] as never,
    });
    const rec = await pub.waitForTransactionReceipt({ hash: h });
    run.beats.two = h;
    if (rec.status !== "success") {
      run.failure = "beat2-reverted";
      run.detail = `placeForDelegator reverted (${h})`;
      return run;
    }
    // THE QUARRY. A mined transaction with no placement log is a silent
    // rejection: status = 1, nothing traded, nothing resting.
    const placed = rec.logs.filter((l) => l.topics[0]?.toLowerCase() === BINARY_ORDER_PLACED.toLowerCase());
    if (placed.length === 0) {
      run.failure = "SILENT-REJECTION";
      run.detail = `status=1 with no BinaryOrderPlaced log — nothing traded, nothing resting (${h})`;
      return run;
    }
    // The id from the RECEIPT, and it is INDEXED — topics[1], not data.
    // `data` carries only the uint8 kind, so reading the id from data yields 0,
    // matches no fill, and reports "never fills" on every run while looking
    // entirely reasonable. Same shape as OrderFilled's indexed args decoding to
    // zeros. Verified against a real receipt before this line was written.
    for (const l of rec.logs) {
      if (l.topics[0]?.toLowerCase() !== BINARY_ORDER_PLACED.toLowerCase()) continue;
      if (l.topics[1]) orderId = BigInt(l.topics[1]);
    }
    run.rested = true;
    // OrderFilled's first two args are INDEXED. Attribute by matching
    // takerOrderId to the receipt's id: a transaction carries the counterparty's
    // side too, so summing every OrderFilled over-reports.
    for (const l of rec.logs) {
      if (l.topics[0]?.toLowerCase() !== ORDER_FILLED.toLowerCase()) continue;
      if (orderId !== null && l.topics[1] && BigInt(l.topics[1]) === orderId) run.filled = true;
    }
    console.log(`  beat 2  ${run.filled ? "FILLED" : "rested (no fill this block)"}  orderId=${orderId ?? "?"}  ${NETWORK.explorer}/tx/${h}`);
  } catch (e) {
    run.failure = "beat2-threw";
    run.detail = why(e, regAbi);
    return run;
  }

  // A resting order on the doomed mandate, so it holds exposure at resolution.
  try {
    const h = await wG.writeContract({
      address: REGISTRY, abi: regAbi, functionName: "placeForDelegator",
      args: [doomed, mk.marketId, mk.pool, OrderKind.BUY_YES, 20_000n, 1_000_000n, expireNs] as never,
    });
    await pub.waitForTransactionReceipt({ hash: h });
  } catch (e) {
    run.failure = "seed-doomed-failed";
    run.detail = `${why(e, regAbi)} — the doomed mandate expires ${DOOMED_TTL_S}s after creation, and the run has to place its order before that`;
    return run;
  }

  // ASSERT THE SETUP, rather than discovering it in the result. We placed
  // exactly two orders on this market and started from zero pending, so pending
  // must be exactly two. Anything else means state arrived from somewhere we
  // did not put it, and every number this run produces is about a batch we did
  // not construct.
  const pendNow = await pub.readContract({
    address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId],
  }) as bigint;
  if (pendNow !== 2n) {
    run.failure = "unexpected-pending";
    run.detail = `expected 2 open reservations after seeding, found ${pendNow}`;
    return run;
  }

  // ---- BEAT 3: validators settle, revoke, and sweep -----------------------
  const invBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const setBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
  const fromBlock = await pub.getBlockNumber();
  await (async () => {
    const h = await wD.writeContract({
      address: HANDLER, abi: hndAbi, functionName: "subscribeTo",
      args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, SUB_GAS_LIMIT, 7_000_000_000n] as never,
    });
    await pub.waitForTransactionReceipt({ hash: h });
  })();

  const deadline = Date.now() + (usable.ttl + 420) * 1000;
  let settled = false;
  while (Date.now() < deadline) {
    await sleep(12_000);
    const s = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
    const pend = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId] }) as bigint;
    if (s > setBefore && pend === 0n) { settled = true; break; }
  }

  try {
    const h = await wD.writeContract({ address: HANDLER, abi: hndAbi, functionName: "unsubscribeNow" });
    await pub.waitForTransactionReceipt({ hash: h });
  } catch { await emergencyUnsubscribe(); }
  if (await stillArmed()) {
    run.failure = "still-armed";
    run.detail = "the subscription survived the run — it spends on every finalization";
    return run;
  }

  const seen = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "seen", args: [mk.marketId] }) as number;
  const invAfter = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;

  if (!settled) {
    // H1, and the instrumentation is what makes these different answers rather
    // than the same silence.
    run.failure = seen === 0 ? "H1a-never-delivered" : "H1b-delivered-not-settled";
    run.detail = `seen[market]=${seen}, ${invAfter - invBefore} invocations in the window`;
    return run;
  }

  // Read what the handler and registry actually emitted, not what we hoped.
  //
  // SCOPED AND WINDOWED, both mandatory. This line previously had neither
  // `address` nor a window, which meant a CHAIN-WIDE scan across every block
  // since the subscription — thousands of them for a fifteen-minute market.
  // The RPC rejects any range over 1000 blocks outright, so every run would
  // have thrown here; and a chain-wide 1000-block scan returns 13-16 MB, past
  // viem's 10 MB response cap, so widening the window is not the fix either.
  //
  // No topic filter, deliberately: this RPC ignores them (see doctor.ts), and
  // there are only two addresses to read. Decoding does the filtering.
  const head2 = await pub.getBlockNumber();
  const SPAN = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const logs: { address: Address; data: Hex; topics: readonly Hex[]; transactionHash: Hex | null }[] = [];
  for (const addr of [HANDLER, REGISTRY]) {
    for (let hi = head2; hi > fromBlock; hi -= SPAN + 1n) {
      const lo = hi - SPAN > fromBlock ? hi - SPAN : fromBlock;
      const page = await pub.getLogs({ address: addr, fromBlock: lo, toBlock: hi });
      logs.push(...(page as unknown as typeof logs));
      if (lo === fromBlock) break;
    }
  }
  for (const l of logs) {
    if (l.address.toLowerCase() === HANDLER.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: hndAbi, data: l.data, topics: l.topics as never });
        if (d.eventName === "Deadhand") {
          const a = d.args as unknown as { marketId: Hex; gasUsed: bigint; processed: bigint };
          if (a.marketId.toLowerCase() === mk.marketId.toLowerCase()) {
            run.beats.three = l.transactionHash;
            run.handlerGas = a.gasUsed.toString();
          }
        }
      } catch { /* other handler event */ }
    }
    if (l.address.toLowerCase() === REGISTRY.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: regAbi, data: l.data, topics: l.topics as never });
        if (d.eventName === "MandateRevoked") {
          const a = d.args as unknown as { mandateId: bigint; reason: string };
          if (a.mandateId === doomed && a.reason === "deadhand") run.revokedByDeadhand = true;
        }
        if (d.eventName === "PayoutSwept") {
          const a = d.args as unknown as { mandateId: bigint; to: Address; amount: bigint };
          if (a.mandateId === doomed) run.sweptToDelegator = `${formatUnits(a.amount, 6)} -> ${a.to}`;
        }
      } catch { /* other registry event */ }
    }
  }

  const m = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "mandates", args: [doomed] }) as readonly unknown[];
  if (!(m[6] as boolean)) {
    run.failure = "beat3-no-revocation";
    run.detail = `mandate ${doomed} settled but is not revoked`;
    return run;
  }
  const clean = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "holdsNoFunds" }) as boolean;
  const stray = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "unattributed" }) as bigint;
  if (!clean || stray !== 0n) {
    run.failure = "custody-claim-false";
    run.detail = `holdsNoFunds=${clean} unattributed=${formatUnits(stray, 6)}`;
    return run;
  }

  console.log(`  beat 3  settled, mandate ${doomed} revoked=${run.revokedByDeadhand}, swept ${run.sweptToDelegator ?? "nothing"}`);
  run.ok = true;
  run.detail = `seen=${seen}, ${invAfter - invBefore} invocations, handler gas ${run.handlerGas}`;
  return run;
}

// ---- the hunt -------------------------------------------------------------

async function main() {
  if (!REGISTRY || !HANDLER) throw new Error("MANDATE_REGISTRY / DEADHAND_HANDLER not set");
  const delegate = acct("DELEGATE_KEY");

  // Budget, checked BEFORE the first run rather than discovered on the
  // fifteenth. ~0.028 STT per order, three orders a run.
  const need = BigInt(RUNS) * 100_000_000_000_000_000n / 1000n * 900n;
  const have = await pub.getBalance({ address: delegate.address });
  console.log(`REHEARSAL — ${RUNS} runs`);
  console.log(`  delegate ${delegate.address} holds ${formatEther(have)} STT`);
  if (have < need) {
    throw new Error(`delegate holds ${formatEther(have)} STT, needs ~${formatEther(need)} for ${RUNS} runs. Fund it now, not on run fifteen.`);
  }
  console.log(`  handler  ${HANDLER} holds ${formatEther(await pub.getBalance({ address: HANDLER }))} STT (32 floor)\n`);

  const results: Run[] = [];
  for (let i = 1; i <= RUNS; i++) {
    let run: Run;
    try {
      run = await oneRun(i);
    } catch (e) {
      run = {
        n: i, at: new Date().toISOString(), marketId: "", ok: false,
        beats: { one: null, two: null, three: null },
        failure: "threw", detail: (e as Error).message.split(String.fromCharCode(10))[0] ?? "",
        filled: false, rested: false, revokedByDeadhand: false, sweptToDelegator: null, handlerGas: null,
      };
      await emergencyUnsubscribe();
    }
    append(run);
    results.push(run);
    console.log(`  [run ${i}] ${run.ok ? "PASS" : "FAIL: " + run.failure}  ${run.detail}`);

    const pass = results.filter((x) => x.ok).length;
    console.log(`  --- ${pass}/${results.length} passing so far ---`);
    if (!run.ok && (run.failure === "no-window" || run.failure === "no-tradable-market")) {
      // The venue runs its short series on a ~5 minute cycle, so a miss is a
      // wait rather than a failure of ours. Recorded either way.
      await sleep(60_000);
    }
  }

  // ---- the report --------------------------------------------------------
  const pass = results.filter((r) => r.ok);
  const byFailure = new Map<string, number>();
  for (const r of results) if (!r.ok) byFailure.set(r.failure ?? "?", (byFailure.get(r.failure ?? "?") ?? 0) + 1);
  console.log(`\n=== ${pass.length}/${results.length} full three-beat runs passed ===`);
  console.log(`  filled on beat 2:      ${results.filter((r) => r.filled).length}`);
  console.log(`  revoked by deadhand:   ${results.filter((r) => r.revokedByDeadhand).length}`);
  console.log(`  swept to delegator:    ${results.filter((r) => r.sweptToDelegator).length}`);
  if (byFailure.size) {
    console.log(`  failures:`);
    for (const [k, v] of [...byFailure].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)}x ${k}`);
  }
  const silent = results.filter((r) => r.failure === "SILENT-REJECTION").length;
  console.log(`\n  SILENT REJECTIONS (status=1, nothing traded, nothing resting): ${silent}`);
  console.log(`  full log: ${LOG}\n`);
}

installUnwind();
main()
  .then(async () => {
    if (await stillArmed()) { console.error("EXITING NON-ZERO: subscription still armed"); await emergencyUnsubscribe(); process.exit(1); }
    process.exit(0);
  })
  .catch(async (e) => { console.error(e); await unwindPersistently(); process.exit(1); });
