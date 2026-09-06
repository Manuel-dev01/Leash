/**
 * GO / NO-GO for a take. Read-only, fast, and it answers one question:
 * should you press record right now?
 *
 * Stage 5 measured why this is needed. Three runs in twenty failed with
 * `no-window`, and on one of them the short market series was ENTIRELY ABSENT —
 * the only live markets had ttls of 3,049s and 13,849s. That is not a timing
 * mistake anyone can avoid by being careful; the market the demo needs simply
 * does not always exist. Finding that out after setting up is the expensive
 * order to find it out in.
 *
 * Nothing here writes. Run it as often as you like while waiting for a window.
 */
import "dotenv/config";
import {
  createPublicClient, http, parseAbi, formatEther, formatUnits, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC, NETWORK } from "../packages/leash-ec/src/constants.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../packages/leash-ec/src/discover.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;

/**
 * Setup before the market must resolve: demo-reset seeds, the operator does
 * beats 1 and 2 on camera, and only then does the window need to close. The
 * lower bound is generous on purpose — starting a take into a market that
 * resolves mid-sentence is worse than waiting five minutes for the next one.
 */
const MIN_TTL = Number(process.env.MIN_TTL ?? 200);
const MAX_TTL = Number(process.env.MAX_TTL ?? 900);

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

const regAbi = parseAbi([
  "function pendingSettlement(bytes32) view returns (uint256)",
  "function holdsNoFunds() view returns (bool)",
  "function unattributed() view returns (uint256)",
  "function totalRefundClaim() view returns (uint256)",
]);
const hndAbi = parseAbi([
  "function subscriptionId() view returns (uint256)",
  "function batchCap() view returns (uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const OK = "  GO  ";
const NO = " WAIT ";
const BAD = " STOP ";

async function main() {
  const problems: string[] = [];
  const waits: string[] = [];
  console.log(`\nREADY? — ${new Date().toISOString()}`);

  // ---- the market, which is the thing we do not control -------------------
  const c = ecClient(RPC);
  const found = await discoverMarkets(c, { windows: 12 });
  const r = await tradableMarketsDetailed(c, found, { headroomSec: 60n, limit: 8, maxChecks: 20 });
  const now = Math.floor(Date.now() / 1000);
  const live = r.live.map((m) => ({ m, ttl: Number(m.expiry) - now })).sort((a, b) => a.ttl - b.ttl);

  if (r.live.length === 0 && r.errors > 0) {
    problems.push(`RPC degraded: ${r.errors} of ${r.checked} checks failed. This is not an empty venue.`);
  }
  console.log(`\n  markets open for trading: ${live.length}`);
  for (const x of live) {
    const win = Number(x.m.expiry - x.m.tradingStart);
    console.log(`    ${x.m.asset.padEnd(4)} ttl ${String(x.ttl).padStart(6)}s   ${win}s series   ${x.m.pool.slice(0, 12)}…`);
  }

  const usable = live.filter((x) => x.ttl >= MIN_TTL && x.ttl <= MAX_TTL);
  const shortSeries = live.filter((x) => Number(x.m.expiry - x.m.tradingStart) <= 300);
  let chosen: typeof usable[number] | undefined;

  if (usable.length === 0) {
    if (shortSeries.length === 0) {
      waits.push(
        `NO SHORT-SERIES MARKET EXISTS right now. This happened on 1 of 20 rehearsal runs. ` +
        `It is the venue's behaviour, not a fault — wait for the next 300s window rather than setting up.`,
      );
    } else {
      const soonest = shortSeries[0]!;
      const next = soonest.ttl > 0 ? soonest.ttl : 0;
      waits.push(
        `the short market is at ttl ${soonest.ttl}s, below the ${MIN_TTL}s a take needs. ` +
        `The 300s series recycles about every 5 minutes — the next usable window opens in roughly ${next}s.`,
      );
    }
  } else {
    chosen = usable[0]!;
    // A market carrying reservations from an earlier take clips the batch and
    // shows a PARTIAL settle on camera.
    const pend = await pub.readContract({
      address: REGISTRY, abi: regAbi, functionName: "pendingSettlement", args: [chosen.m.marketId],
    }) as bigint;
    if (pend !== 0n) {
      waits.push(`the usable market already carries ${pend} open reservation(s) from an earlier run — demo-reset will refuse it, and rightly`);
      chosen = undefined;
    } else {
      console.log(`\n  candidate: ${chosen.m.asset} ttl ${chosen.ttl}s, pending 0, market ${chosen.m.marketId.slice(0, 18)}…`);
    }
  }

  // ---- our own state, which we do control ---------------------------------
  const sub = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "subscriptionId" }) as bigint;
  const cap = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "batchCap" }) as bigint;
  const hBal = await pub.getBalance({ address: HANDLER });
  const clean = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "holdsNoFunds" }) as boolean;
  const stray = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "unattributed" }) as bigint;
  const claims = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "totalRefundClaim" }) as bigint;
  const held = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [REGISTRY] }) as bigint;

  console.log(`\n  handler   subscription ${sub === 0n ? "DISARMED" : sub} · batchCap ${cap} · ${formatEther(hBal)} STT`);
  console.log(`  registry  holdsNoFunds=${clean} · unattributed ${formatUnits(stray, 6)} · claims ${formatUnits(claims, 6)} · held ${formatUnits(held, 6)} tUSDC`);

  if (!clean || stray !== 0n) problems.push(`the no-custody claim is FALSE right now: holdsNoFunds=${clean}, unattributed=${formatUnits(stray, 6)}`);
  // 32 STT is a balance FLOOR checked at subscribe, not a deposit.
  if (hBal < 32_500_000_000_000_000_000n) problems.push(`handler holds ${formatEther(hBal)} STT — below the 32 STT floor plus a margin, so subscribe() will revert InsufficientBalance`);
  if (claims > held) {
    // NOT a blocker, and NOT "run collect.ts". Most of this backlog is phantom:
    // the _sweep defect returns collateral to whichever delegator places next
    // WITHOUT decrementing refundClaim, so the claim stays booked against money
    // that has already left. sweepRefunds pays from balance, so it can never
    // clear them. Telling the operator to run a command that cannot work is the
    // same class of lie as a status line that prints without checking.
    console.log(`
  NOTE  ${formatUnits(claims - held, 6)} tUSDC of refund claims are outstanding and most are PHANTOM —`);
    console.log(`        booked against collateral that _sweep already returned without decrementing them.`);
    console.log(`        collect.ts cannot clear these; the contract fix can. Fine to record with this showing:`);
    console.log(`        it is a defect our own instrumentation found and diagnosed.`);
  }

  for (const [name, floor] of [["FUND_KEY", 5n], ["DELEGATE_KEY", 1n], ["STRANGER_KEY", 5n]] as const) {
    const v = process.env[name];
    if (!v) { problems.push(`${name} missing`); continue; }
    const a = privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`);
    const b = await pub.getBalance({ address: a.address });
    const need = floor * 100_000_000_000_000_000n; // floor tenths of an STT
    if (b < need) problems.push(`${name} holds ${formatEther(b)} STT, under the ${formatEther(need)} a take needs`);
  }

  // ---- the verdict, computed --------------------------------------------
  console.log("");
  for (const p of problems) console.log(`${BAD} ${p}`);
  for (const w of waits) console.log(`${NO} ${w}`);
  if (problems.length === 0 && waits.length === 0 && chosen) {
    console.log(`${OK} record now. ${chosen.m.asset}, ttl ${chosen.ttl}s — beats 1 and 2 immediately, beat 3 fires when it resolves.`);
    console.log(`\n  next: npx tsx scripts/demo-reset.ts   (seeds, refuses a dirty market)`);
    console.log(`        then arm the subscription, then record.\n`);
    process.exit(0);
  }
  if (problems.length === 0) {
    console.log(`\n  Nothing is broken — the venue is not ready. Re-run this in a minute.\n`);
    process.exit(2);
  }
  console.log(`\n  Fix the STOP items before recording.\n`);
  process.exit(1);
}

main().catch((e) => { console.error("\nready crashed:", e); process.exit(1); });
