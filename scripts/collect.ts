/**
 * Collect the money and pay the delegator — both legs, from a STRANGER key.
 *
 * Settlement releases exposure and books a refund, but the venue does not push
 * the collateral back on its own. Two more calls are needed, and the point of
 * this script is that BOTH ARE PERMISSIONLESS:
 *
 *   1. `cancelExpiredOrders(ids)` on the pool  — the venue returns escrow for
 *      orders that outlived their market, sending it to the order's owner,
 *      which is the registry.
 *   2. `sweepRefunds(mandateId)` on the registry — the registry pays the
 *      DELEGATOR the amount booked against that mandate.
 *
 * It runs as the stranger on purpose. If a party with no relationship to the
 * mandate can complete the payout, the delegator does not depend on the
 * delegate, on us, or on anyone being online — which is the whole argument.
 *
 * ⚠️ ORDERING MATTERS, because of a known flaw. `_sweep` keeps only
 * `totalOwed`, not `totalOwed + totalRefundClaim`, so collateral sitting in the
 * registry as one mandate's refund claim can be swept to a DIFFERENT delegator
 * by their next order. Leg 2 therefore follows leg 1 immediately, in the same
 * run, rather than being left for later. See `knownLimitations` in claims.json.
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, parseAbi, formatUnits,
  decodeEventLog, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { binaryPoolWriteAbi } from "@somnia-chain/markets-sdk";
import { EC, NETWORK } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "") as Address;
/** How far back to look for our own placements. 1000-block pages. */
const WINDOWS = Number(process.env.WINDOWS ?? 20);

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const pub = createPublicClient({ chain, transport: http(RPC) });

const regAbi = parseAbi([
  "function sweepRefunds(uint256)",
  "function nextMandateId() view returns (uint256)",
  "function refundClaim(uint256) view returns (uint256)",
  "function totalRefundClaim() view returns (uint256)",
  "function mandates(uint256) view returns (address delegator, address delegate, uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint128 usedExposure, uint64 expiry, bool revoked, bool exists)",
  "event OrderPlacedFor(uint256 indexed mandateId, bytes32 indexed marketId, address indexed pool, uint128 orderId, uint128 reserved, uint128 usedExposure)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const bal = (a: Address) =>
  pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

async function main() {
  if (!REGISTRY) throw new Error("MANDATE_REGISTRY not set");
  const key = process.env.STRANGER_KEY;
  if (!key) throw new Error("STRANGER_KEY missing — this runs as a stranger by design");
  const stranger = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  const w = createWalletClient({ account: stranger, chain, transport: http(RPC) });

  console.log(`\nCOLLECT — as ${stranger.address} (no relationship to any mandate)`);
  console.log(`  registry ${REGISTRY}`);
  console.log(`  outstanding refund claims: ${formatUnits(await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "totalRefundClaim" }) as bigint, 6)} tUSDC\n`);

  // ---- find our own placements -------------------------------------------
  // Scoped to the registry and windowed to the 1000-block cap. No topic
  // filter: this RPC ignores them, so decoding does the filtering.
  const head = await pub.getBlockNumber();
  const SPAN = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const byPool = new Map<Address, bigint[]>();
  const mandateIds = new Set<bigint>();
  for (let i = 0; i < WINDOWS; i++) {
    const hi = head - BigInt(i) * (SPAN + 1n);
    if (hi <= SPAN) break;
    const page = await pub.getLogs({ address: REGISTRY, fromBlock: hi - SPAN, toBlock: hi });
    for (const l of page) {
      try {
        const d = decodeEventLog({ abi: regAbi, data: l.data, topics: l.topics as never });
        if (d.eventName !== "OrderPlacedFor") continue;
        const a = d.args as unknown as { mandateId: bigint; pool: Address; orderId: bigint };
        const list = byPool.get(a.pool) ?? [];
        if (!list.includes(a.orderId)) list.push(a.orderId);
        byPool.set(a.pool, list);
        mandateIds.add(a.mandateId);
      } catch { /* another registry event */ }
    }
  }
  console.log(`  found ${[...byPool.values()].reduce((n, v) => n + v.length, 0)} order(s) across ${byPool.size} pool(s), ${mandateIds.size} mandate(s)`);

  // ---- leg 1: make the venue give the collateral back ---------------------
  const before = await bal(REGISTRY);
  let cancelled = 0, cancelFailed = 0;
  for (const [pool, ids] of byPool) {
    try {
      // Simulate first: a pool with nothing expired reverts, and that is a
      // normal outcome rather than a failure worth a transaction.
      await pub.simulateContract({
        account: stranger.address, address: pool, abi: binaryPoolWriteAbi,
        functionName: "cancelExpiredOrders", args: [ids] as never,
      });
      const h = await w.writeContract({
        address: pool, abi: binaryPoolWriteAbi, functionName: "cancelExpiredOrders", args: [ids] as never,
      });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      console.log(`  cancelExpiredOrders on ${pool.slice(0, 12)}… (${ids.length} ids) status=${r.status}`);
      if (r.status === "success") cancelled += ids.length;
    } catch (e) {
      cancelFailed++;
      console.log(`  ${pool.slice(0, 12)}…: nothing to cancel — ${(e as Error).message.split(String.fromCharCode(10))[0]?.slice(0, 80)}`);
    }
  }
  const afterCancel = await bal(REGISTRY);
  console.log(`\n  registry collateral ${formatUnits(before, 6)} -> ${formatUnits(afterCancel, 6)} (+${formatUnits(afterCancel - before, 6)})`);

  // ---- leg 2: pay the delegators, immediately -----------------------------
  //
  // Enumerated by mandate id, NOT from the logs above. A log scan only reaches
  // back as far as its window, so mandates whose orders were placed earlier
  // keep an unpaid claim forever while the collateral sits in the registry —
  // where the _sweep flaw can hand it to a different delegator. Claims are
  // cheap to read and there are not many mandates; read them all.
  const next = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "nextMandateId" }) as bigint;
  for (let i = 1n; i < next; i++) mandateIds.add(i);

  let paid = 0n, swept = 0;
  for (const id of [...mandateIds].sort((a, b) => (a < b ? -1 : 1))) {
    const claim = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "refundClaim", args: [id] }) as bigint;
    if (claim === 0n) continue;
    const m = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "mandates", args: [id] }) as readonly unknown[];
    const to = m[0] as Address;
    const dBefore = await bal(to);
    try {
      const h = await w.writeContract({ address: REGISTRY, abi: regAbi, functionName: "sweepRefunds", args: [id] as never });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      const delta = (await bal(to)) - dBefore;
      paid += delta;
      if (delta > 0n) swept++;
      console.log(`  sweepRefunds(${id}) status=${r.status}  delegator ${to.slice(0, 10)}… +${formatUnits(delta, 6)} tUSDC`);
      if (delta > 0n) console.log(`     ${NETWORK.explorer}/tx/${h}`);
    } catch (e) {
      console.log(`  sweepRefunds(${id}) FAILED: ${(e as Error).message.split(String.fromCharCode(10))[0]}`);
    }
  }

  const left = await pub.readContract({ address: REGISTRY, abi: regAbi, functionName: "totalRefundClaim" }) as bigint;
  console.log(`\n  ${swept} mandate(s) paid, ${formatUnits(paid, 6)} tUSDC to delegators, by a party who never traded`);
  console.log(`  refund claims still outstanding: ${formatUnits(left, 6)} tUSDC`);
  console.log(`  registry balance now: ${formatUnits(await bal(REGISTRY), 6)} tUSDC`);
  if (cancelFailed) console.log(`  (${cancelFailed} pool(s) had nothing expired to cancel)`);
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
