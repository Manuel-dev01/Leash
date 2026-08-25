/**
 * STAGE 3 — Deadhand against a real market resolution.
 *
 * Seeds SEVERAL mandates on one market on purpose. A single-mandate revocation
 * and a batch settling together are the same code and completely different in
 * the room: the batch is what makes "one subscription serves every delegation"
 * a thing seen rather than a thing claimed.
 *
 * Measures rather than assumes. The 32-mandate cap came from a probe handler
 * doing representative writes; the real path decodes, walks a cursor, revokes
 * and sweeps. Whatever this reports is the cap.
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, formatEther, formatUnits,
  parseAbi, decodeEventLog, keccak256, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC, NETWORK, OrderKind, TOPICS } from "../packages/leash-ec/src/constants.js";
import { ecClient, discoverMarkets, tradableMarkets } from "../packages/leash-ec/src/discover.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const MANDATES = Number(process.env.MANDATES ?? 3);

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
  "function subscriptionId() view returns (uint256)",
  "function withdraw()",
  "event Deadhand(bytes32 indexed marketId, address indexed pool, uint256 processed, uint256 failed, bool drained, uint256 gasUsed)",
  "event DeadhandSkipped(bytes32 indexed marketId, string reason)",
  "event DeadhandFailed(bytes32 indexed marketId, bytes reason)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!REGISTRY || !HANDLER) throw new Error("MANDATE_REGISTRY / DEADHAND_HANDLER not set in .env");
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const stranger = acct("STRANGER_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wD = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wG = createWalletClient({ account: delegate, chain, transport: http(RPC) });
  const wS = createWalletClient({ account: stranger, chain, transport: http(RPC) });

  console.log(`\nSTAGE 3 — Deadhand`);
  console.log(`  registry ${REGISTRY}`);
  console.log(`  handler  ${HANDLER}  ${formatEther(await pub.getBalance({ address: HANDLER }))} STT\n`);

  // ---- pick a market that will finalize SOON ------------------------------
  const disc = ecClient(RPC);
  const found = await discoverMarkets(disc, { windows: 30 });
  const live = await tradableMarkets(disc, found, { headroomSec: 70n, limit: 40 });
  const now = Math.floor(Date.now() / 1000);
  const withTtl = live.map((m) => ({ m, ttl: Number(m.expiry) - now })).sort((a, b) => a.ttl - b.ttl);
  console.log(`  ${found.length} created / ${live.length} tradable; ttls(s): ${withTtl.map((x) => x.ttl).join(", ")}`);
  const soon = withTtl.filter((x) => x.ttl > 75 && x.ttl < 900)[0];
  if (!soon) throw new Error(`no market finalizing in 75-900s (live: ${live.length})`);
  const { m: mk, ttl } = soon;
  console.log(`  market ${mk.asset} ttl=${ttl}s  marketId=${mk.marketId.slice(0, 18)}...`);
  console.log(`  pool   ${mk.pool}\n`);

  // ---- collateral + allowance --------------------------------------------
  let bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  if (bal < 20_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "faucet", args: [1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const allow = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, REGISTRY] }) as bigint;
  if (allow < 50_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [REGISTRY, 200_000_000n] });
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
  // still open when the market resolves, which is exactly the dead exposure the
  // Deadhand exists to release.
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
  console.log(`  pending settlement on this market: ${pending}\n`);

  // ---- subscribe ----------------------------------------------------------
  const balBefore = await pub.getBalance({ address: HANDLER });
  const invBefore = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const fromBlock = await pub.getBlockNumber();
  let h = await wD.writeContract({
    address: HANDLER, abi: hndAbi, functionName: "subscribeTo",
    args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, 3_000_000n, 7_000_000_000n] as never,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  const subId = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
  // FINALIZATION LAGS MARKET EXPIRY BY AN UNPREDICTABLE AMOUNT.
  //
  // Measured: a market with ttl 263s had still not finalized 503s later. Three
  // consecutive runs reported "did not settle" for this reason alone, which
  // reads exactly like a broken handler — the earlier runs that DID settle were
  // lucky, not correct.
  //
  // So do not guess a duration: POLL until the handler actually settles, and
  // stop as soon as it does. A fixed window is a coin flip; this is a wait.
  const deadline = Date.now() + Number(process.env.MAX_WAIT_S ?? 900) * 1000;
  let settledNow = 0n;
  console.log(`  subscribed id=${subId}, polling until settle (max ${Math.round((deadline - Date.now()) / 1000)}s)...`);
  while (Date.now() < deadline) {
    await sleep(15_000);
    settledNow = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
    const pend = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [mk.marketId] }) as bigint;
    if (settledNow > 0n && pend === 0n) { console.log(`  settled after ${Math.round((Date.now() - (deadline - Number(process.env.MAX_WAIT_S ?? 900) * 1000)) / 1000)}s`); break; }
  }
  if (settledNow === 0n) console.log("  WARNING: hit the poll deadline with no settle");

  try { const u = await wD.writeContract({ address: HANDLER, abi: hndAbi, functionName: "unsubscribeNow" }); await pub.waitForTransactionReceipt({ hash: u }); console.log("  unsubscribed"); }
  catch { console.log("  unsubscribe failed"); }

  // ---- results ------------------------------------------------------------
  const invAfter = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const balAfter = await pub.getBalance({ address: HANDLER });
  console.log(`\n  invocations ${invBefore} -> ${invAfter}  (+${invAfter - invBefore})`);
  console.log(`  STT spent   ${formatEther(balBefore - balAfter)}`);

  const head = await pub.getBlockNumber();
  const SPAN = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const logs: { data: Hex; topics: readonly Hex[]; transactionHash: Hex | null }[] = [];
  for (let hi = head; hi > fromBlock; hi -= SPAN + 1n) {
    const lo = hi - SPAN > fromBlock ? hi - SPAN : fromBlock;
    const page = await pub.getLogs({ address: HANDLER, fromBlock: lo, toBlock: hi });
    logs.push(...(page as unknown as typeof logs));
    if (lo === fromBlock) break;
  }

  let ourSettle: { processed: bigint; drained: boolean; gasUsed: bigint; tx: Hex | null } | null = null;
  let skipped = 0;
  let decodeFailures = 0;
  const deadhandTopic0 = keccak256(toHex(
    "Deadhand(bytes32,address,uint256,uint256,bool,uint256)",
  ));
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
      if (d.eventName === "DeadhandSkipped") skipped++;
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
  // Derived, not counted from events: the hot path deliberately emits nothing,
  // so `skipped` from DeadhandSkipped is now always 0 and would be a zero in a
  // log that looks like a measurement.
  const settles = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
  const derivedSkips = (invAfter - invBefore) - settles;
  console.log(`  skipped (derived: invocations - marketsSettled): ${derivedSkips}`);
  if (skipped > 0) console.log(`  (${skipped} shape-skips also emitted)`);

  // ---- the measured cap ---------------------------------------------------
  if (ourSettle && ourSettle.processed > 0n) {
    const per = ourSettle.gasUsed / ourSettle.processed;
    console.log(`\n  MEASURED: ${ourSettle.gasUsed} gas for ${ourSettle.processed} mandates = ~${per} gas each`);
    const cap = per > 0n ? (2_500_000n / per) : 32n;
    console.log(`  a 2.5M working budget therefore holds ~${cap} mandates`);
    const setTx = await wD.writeContract({ address: HANDLER, abi: hndAbi, functionName: "setBatchCap", args: [cap] as never });
    await pub.waitForTransactionReceipt({ hash: setTx });
    console.log(`  batchCap set to ${await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" })} from measurement, not inherited`);
  } else {
    console.log("\n  our market did not settle in the window — see above for why");
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

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
