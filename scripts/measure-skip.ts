/**
 * Measure the skip path in ISOLATION.
 *
 * Two inferred figures disagreed by 4x (78k gas vs 339k), because both were
 * derived from a balance delta over a MIXED window — skips plus a settle plus
 * cold-slot writes on a fresh handler. Dividing a mixed total by a count is not
 * a measurement of either component.
 *
 * This subscribes a handler that has NO mandates at all, so every invocation
 * takes the skip path and nothing else. Balance delta / invocations is then the
 * skip cost, with no mixture to attribute.
 *
 * The first invocation on a fresh handler writes a cold `invocations` slot and
 * is reported separately for the same reason.
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, formatEther, parseAbi, parseAbiItem,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installUnwind, emergencyUnsubscribe, stillArmed, unwindPersistently } from "./unwind.js";
import { EC, NETWORK, TOPICS } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const WINDOW_S = Number(process.env.WINDOW_S ?? 150);
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? 8_000_000);

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const hndAbi = parseAbi([
  "function subscribeTo(address,bytes32,uint64,uint64) returns (uint256)",
  "function unsubscribeNow()",
  "function invocations() view returns (uint256)",
  "function marketsSettled() view returns (uint256)",
  "function subscriptionId() view returns (uint256)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!HANDLER) throw new Error("DEADHAND_HANDLER not set");
  const v = process.env.FUND_KEY;
  if (!v) throw new Error("FUND_KEY missing");
  const owner = privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });

  console.log(`\nSKIP-PATH MEASUREMENT (isolated)`);
  console.log(`  handler ${HANDLER}`);

  const inv0 = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const set0 = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
  const bal0 = await pub.getBalance({ address: HANDLER });
  console.log(`  before: invocations=${inv0} settled=${set0} balance=${formatEther(bal0)} STT`);

  const h = await w.writeContract({
    address: HANDLER, abi: hndAbi, functionName: "subscribeTo",
    // Defaults to the gasLimit the demo arms with, so the figure describes the
    // system we ship. Overridable because whether this number MOVES with the
    // limit is itself the question: "the chain charges on gas used, not on
    // gasLimit" is load-bearing for the whole one-subscription argument, and it
    // is settled by running this twice with one variable changed.
    args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, GAS_LIMIT, 7_000_000_000n] as never,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  subscribed at gasLimit ${GAS_LIMIT}, listening ${WINDOW_S}s with ZERO mandates...`);

  await sleep(WINDOW_S * 1000);

  const u = await w.writeContract({ address: HANDLER, abi: hndAbi, functionName: "unsubscribeNow" });
  await pub.waitForTransactionReceipt({ hash: u });

  const inv1 = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "invocations" }) as bigint;
  const set1 = await pub.readContract({ address: HANDLER, abi: hndAbi, functionName: "marketsSettled" }) as bigint;
  const bal1 = await pub.getBalance({ address: HANDLER });

  const fired = inv1 - inv0;
  const settled = set1 - set0;
  const spent = bal0 - bal1;

  console.log(`\n  after:  invocations=${inv1} settled=${set1} balance=${formatEther(bal1)} STT`);
  console.log(`  fired ${fired}, of which settles ${settled}`);
  if (settled > 0n) {
    console.log("  WARNING: a settle occurred — this window was NOT pure. Discard and rerun.");
  }
  if (fired === 0n) {
    console.log("  no invocations — nothing measured. Rerun with a longer window.");
    return;
  }
  const per = Number(spent) / Number(fired);
  const GWEI = 6.8e9;

  /**
   * Capture the receipts WHILE the window is still readable.
   *
   * The figure above is a balance delta, which is the right way to measure it —
   * but `verify.ts` re-checks the claim against real receipts, and this RPC
   * serves only 1000 blocks (~100 seconds). By the time anyone goes looking the
   * invocations have scrolled out of reach, and the evidence has to be
   * re-measured rather than re-read. Collect it here, at the one moment it
   * exists.
   */
  const evidence: string[] = [];
  try {
    const head = await pub.getBlockNumber();
    const from = head > 999n ? head - 999n : 0n;
    // viem's `event` form re-filters client-side. This RPC IGNORES the topics
    // parameter, so a raw eth_getLogs here would return unrelated events.
    const saw = await pub.getLogs({
      address: HANDLER, event: parseAbiItem("event DeadhandSaw(bytes32 marketId)"),
      fromBlock: from, toBlock: head,
    });
    const done = await pub.getLogs({
      address: HANDLER,
      event: parseAbiItem(
        "event Deadhand(bytes32 marketId, address handler, uint256 processed, uint256 failed, bool drained, uint256 gas)",
      ),
      fromBlock: from, toBlock: head,
    });
    const settledTx = new Set(done.map((l) => l.transactionHash));
    for (const l of saw) {
      if (!l.transactionHash || settledTx.has(l.transactionHash)) continue;
      if (!evidence.includes(l.transactionHash)) evidence.push(l.transactionHash);
      if (evidence.length >= 5) break;
    }
  } catch {
    // Non-fatal: the measurement stands on the balance delta either way.
  }

  console.log(`\n  spent ${formatEther(spent)} STT over ${fired} pure skips`);
  console.log(`  => ${(per / 1e18).toFixed(8)} STT each  ~= ${Math.round(per / GWEI).toLocaleString()} gas`);
  console.log(`  armed cost at 1 finalization/10s: ${((per / 1e18) * 8640).toFixed(2)} STT/day`);
  if (evidence.length > 0) {
    console.log(`\n  receipts — put these in claims.json skip-cost provenance.evidence:`);
    for (const h of evidence) console.log(`    "${h}",`);
  } else {
    console.log(`\n  NO RECEIPTS CAPTURED — the 1000-block window scrolled past first.`);
  }
  console.log(`\n  (gas figure assumes a 6.8 gwei effective price; the STT number is`);
  console.log(`   the measured one and does not depend on that assumption)\n`);
}

// This script arms a subscription, so it must be able to disarm one.
installUnwind();
main()
  .then(async () => {
    // A mined unsubscribe is not a cancelled subscription; read it back.
    if (await stillArmed()) { console.error("EXITING NON-ZERO: subscription still armed"); await emergencyUnsubscribe(); process.exit(1); }
    process.exit(0);
  })
  .catch(async (e) => { console.error(e); await unwindPersistently(); process.exit(1); });
