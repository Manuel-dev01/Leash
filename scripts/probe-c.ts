/**
 * PROBE C — does the Deadhand job fit, and what happens when it breaks?
 *
 * Runs one phase per invocation so each measurement is clean:
 *
 *   PHASE=earlyexit  batch 0   — cost of being invoked for a finalization we
 *                                do not care about. Most of them are.
 *   PHASE=batch      batch N   — cost of representative enforcement work.
 *                                This is the number that sets the batch cap.
 *   PHASE=revert                — handler reverts inside the callback on
 *                                purpose. Does the subscription survive?
 *
 * Deliberately does NOT validate handler behaviour by simulation. A validator
 * invocation is not something eth_call can meaningfully reproduce, and derived
 * values have already diverged from reality twice on this project (the error
 * regex, and the simulated order id). Everything below is read from receipts
 * and from contract state.
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, formatEther, decodeEventLog,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EC, NETWORK, TOPICS } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const HANDLER = (process.env.PROBE_HANDLER ?? "0x7B7fECF3306Ae216272C1363Dc70201cFDE9b326") as Address;
const PHASE = process.env.PHASE ?? "batch";
const BATCH = BigInt(process.env.BATCH ?? 32);
const WINDOW_S = Number(process.env.WINDOW_S ?? 45);

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const abi = [
  { type: "function", name: "seed", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setBatchSize", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setRevertArmed", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { type: "function", name: "subscribeTo", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "unsubscribeNow", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "invocations", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "subscriptionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "payloadCaptured", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "firstTopicsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "firstTopics", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "firstData", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] },
  { type: "function", name: "firstEmitter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "Invoked", inputs: [
    { name: "seq", type: "uint256", indexed: true }, { name: "emitter", type: "address", indexed: false },
    { name: "topic1", type: "bytes32", indexed: false }, { name: "batch", type: "uint256", indexed: false },
    { name: "gasUsed", type: "uint256", indexed: false }, { name: "gasLeftAtEntry", type: "uint256", indexed: false }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const v = process.env.FUND_KEY;
  if (!v) throw new Error("FUND_KEY missing");
  const owner = privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const w = createWalletClient({ account: owner, chain, transport: http(RPC) });

  const send = async (fn: string, args: unknown[] = []) => {
    const h = await w.writeContract({ address: HANDLER, abi, functionName: fn as never, args: args as never });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`${fn} reverted`);
    return h;
  };
  const read = async (fn: string, args: unknown[] = []) =>
    pub.readContract({ address: HANDLER, abi, functionName: fn as never, args: args as never });

  console.log(`\nPROBE C — phase="${PHASE}"  handler ${HANDLER}`);
  console.log(`  balance ${formatEther(await pub.getBalance({ address: HANDLER }))} STT\n`);

  if (process.env.SEED) {
    await send("seed", [BigInt(process.env.SEED)]);
    console.log(`  seeded ${process.env.SEED} mandate slots (non-zero, so the batch`);
    console.log(`  measures warm SSTOREs — seeding from zero would overstate ~4x)`);
  }

  // ---- configure ---------------------------------------------------------
  if (PHASE === "revert") {
    await send("setRevertArmed", [true]);
    console.log("  revertArmed = true (handler will revert inside the callback)");
  } else {
    await send("setRevertArmed", [false]);
    const n = PHASE === "earlyexit" ? 0n : BATCH;
    await send("setBatchSize", [n]);
    console.log(`  batchSize = ${n}`);
  }

  const before = { inv: await read("invocations") as bigint, bal: await pub.getBalance({ address: HANDLER }) };
  const fromBlock = await pub.getBlockNumber();

  // ---- subscribe ---------------------------------------------------------
  // gasLimit deliberately generous: we are MEASURING, not capping. Capping at
  // 400k and then concluding "it fits in 400k" would be circular.
  const GAS_LIMIT = 3_000_000n;
  const MAX_FEE = 7_000_000_000n; // must be >= priorityFee(0) + 6 gwei minimum
  await send("subscribeTo", [EC.binaryModule as Address, TOPICS.MarketFinalized, GAS_LIMIT, MAX_FEE]);
  const subId = await read("subscriptionId") as bigint;
  console.log(`  subscribed id=${subId}  gasLimit=${GAS_LIMIT} maxFee=${MAX_FEE}`);
  console.log(`  listening ${WINDOW_S}s...`);

  await sleep(WINDOW_S * 1000);

  // A revert rolls back `invocations++` too, so the signature of "the callback
  // ran and reverted" is: balance DROPPED (gas is still consumed) while the
  // counter did NOT move. Then disarm WITHOUT unsubscribing and watch a second
  // window — if invocations resume on the same subscription, a reverting
  // handler is survivable. If they never resume, one malformed mandate kills
  // the whole Deadhand layer and every batch operation needs try/catch.
  let midInv = 0n, midBal = 0n, resumed = 0n;
  if (PHASE === "revert") {
    midInv = await read("invocations") as bigint;
    midBal = await pub.getBalance({ address: HANDLER });
    console.log(`  after armed window: invocations=${midInv} balance=${formatEther(midBal)} STT`);
    console.log(`  disarming (NOT unsubscribing) and listening ${WINDOW_S}s more...`);
    await send("setRevertArmed", [false]);
    await send("setBatchSize", [1n]);
    await sleep(WINDOW_S * 1000);
    resumed = (await read("invocations") as bigint) - midInv;
  }

  // ---- unsubscribe promptly ---------------------------------------------
  // Finalizations fire every ~5-25s. Leaving this armed burns the budget.
  try { await send("unsubscribeNow"); console.log("  unsubscribed"); }
  catch (e) { console.log(`  unsubscribe FAILED: ${(e as Error).message.split(String.fromCharCode(10))[0]}`); }

  // ---- results -----------------------------------------------------------
  const after = { inv: await read("invocations") as bigint, bal: await pub.getBalance({ address: HANDLER }) };
  const fired = after.inv - before.inv;
  const spent = before.bal - after.bal;

  console.log(`\n  invocations : ${before.inv} -> ${after.inv}  (+${fired})`);
  console.log(`  balance     : ${formatEther(before.bal)} -> ${formatEther(after.bal)} STT  (spent ${formatEther(spent)})`);
  if (fired > 0n) console.log(`  cost each   : ~${formatEther(spent / fired)} STT`);

  // Window the scan. The RPC caps eth_getLogs at 1000 blocks (~100s at 0.1s
  // blocks) — a limit this project documented in constants.ts and which this
  // very script then violated by spanning two 50s windows. Recorded, not
  // quietly patched: a documented constraint you do not enforce in code is a
  // constraint you will break.
  const head = await pub.getBlockNumber();
  const SPAN = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const logs: { data: Hex; topics: readonly Hex[]; transactionHash: Hex | null }[] = [];
  for (let hi = head; hi > fromBlock; hi -= SPAN + 1n) {
    const lo = hi - SPAN > fromBlock ? hi - SPAN : fromBlock;
    const page = await pub.getLogs({ address: HANDLER, fromBlock: lo, toBlock: hi });
    logs.push(...(page as never));
    if (lo === fromBlock) break;
  }
  const invoked = logs.filter((l) => l.topics.length > 0);
  let gasSamples: bigint[] = [];
  for (const l of invoked) {
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics as never });
      if (d.eventName === "Invoked") {
        const a = d.args as unknown as { gasUsed: bigint; batch: bigint; topic1: string };
        gasSamples.push(a.gasUsed);
        if (gasSamples.length <= 3) console.log(`  Invoked: batch=${a.batch} gasUsed=${a.gasUsed} marketId=${a.topic1.slice(0, 18)}... tx=${l.transactionHash}`);
      }
    } catch { /* other event */ }
  }
  if (gasSamples.length) {
    const min = gasSamples.reduce((a, b) => (a < b ? a : b));
    const max = gasSamples.reduce((a, b) => (a > b ? a : b));
    const avg = gasSamples.reduce((a, b) => a + b, 0n) / BigInt(gasSamples.length);
    console.log(`\n  GAS over ${gasSamples.length} invocations: min ${min}  avg ${avg}  max ${max}`);
    if (PHASE === "batch" && BATCH > 0n) console.log(`  per mandate: ~${avg / BATCH} gas`);
  }

  // ---- payload shape -----------------------------------------------------
  if (await read("payloadCaptured")) {
    const n = await read("firstTopicsLength") as bigint;
    console.log(`\n  PAYLOAD  emitter=${await read("firstEmitter")}  topics=${n}`);
    for (let i = 0n; i < n; i++) console.log(`    topic[${i}] ${await read("firstTopics", [i])}`);
    const d = await read("firstData") as string;
    console.log(`    data (${(d.length - 2) / 2} bytes) ${d}`);
  }

  if (PHASE === "revert") {
    console.log(`\n  REVERT PHASE VERDICT`);
    console.log(`    invocations recorded while armed: ${fired}`);
    console.log(`    (state increments BEFORE the revert, so a nonzero count with`);
    console.log(`     no Invoked events means the callback ran and rolled back)`);
    console.log(`    subscription id after window: ${await read("subscriptionId")}`);
  }
  console.log();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
