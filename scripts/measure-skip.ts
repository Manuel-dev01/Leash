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
  createPublicClient, createWalletClient, http, formatEther, parseAbi,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { installUnwind, emergencyUnsubscribe, stillArmed } from "./unwind.js";
import { EC, NETWORK, TOPICS } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const HANDLER = (process.env.DEADHAND_HANDLER ?? "") as Address;
const WINDOW_S = Number(process.env.WINDOW_S ?? 150);

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
    args: [EC.binaryModule as Address, TOPICS.MarketFinalized as Hex, 3_000_000n, 7_000_000_000n] as never,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  subscribed, listening ${WINDOW_S}s with ZERO mandates...`);

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
  console.log(`\n  spent ${formatEther(spent)} STT over ${fired} pure skips`);
  console.log(`  => ${(per / 1e18).toFixed(8)} STT each  ~= ${Math.round(per / GWEI).toLocaleString()} gas`);
  console.log(`  armed cost at 1 finalization/10s: ${((per / 1e18) * 8640).toFixed(2)} STT/day`);
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
  .catch(async (e) => { console.error(e); await emergencyUnsubscribe(); process.exit(1); });
