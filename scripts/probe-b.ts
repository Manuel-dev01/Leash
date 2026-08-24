/**
 * PROBE B — place a real Event Contract order that FILLS, through the guard
 * `ec-core` does not have.
 *
 * `ec-core`'s assertTxOk only checks `receipt.status === "reverted"`. It does
 * not simulate, and it does not assert a placement log. But placeBinaryOrder
 * returns `(bool success, uint128 id)` and a `false` mines happily with
 * status = 1 — the silent rejection in CLAUDE.md §4.1 r7. So this path:
 *
 *   quantize in integer space
 *   -> eth_call simulate, ABORT if success == false
 *   -> broadcast at the SAME gas limit as the simulation
 *   -> assert BinaryOrderPlaced / OrderPlaced in the receipt
 *   -> read the id from the RECEIPT, never from the simulation
 *
 * Crossing: we price well through the touch rather than at it. EC gotcha 7 says
 * a taker is charged the FILL price, not the price it offered, so an aggressive
 * limit costs no more than the resting ask — it just guarantees we cross.
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, decodeErrorResult,
  decodeEventLog, formatUnits, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { SomniaMarkets, binaryPoolWriteAbi, orderBookEventsAbi } from "@somnia-chain/markets-sdk";
import { EC, NETWORK, OrderKind, TOPICS, VENUE_ID_TESTNET } from "../packages/leash-ec/src/constants.js";

const errorsPath = resolve(process.cwd(), "node_modules/@somnia-chain/markets-sdk/dist/contractErrorsAbi.js");
const { contractErrorsAbi } = await import(pathToFileURL(errorsPath).href);

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const INDEXER = process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const WS = process.env.EC_WS_URL ?? "wss://api.infra.testnet.somnia.network/ws";

/** Binary tick/lot are NOT on-chain readable; ec-core takes them from config. */
const TICK = 1_000n;
const LOT = 1n;
const DECIMALS = 6;

const chain = {
  id: NETWORK.chainId,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
} as const;

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing from .env`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

function explain(err: unknown): string {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const e = stack.pop();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const k of ["data", "raw"]) {
      const v = o[k];
      const d = typeof v === "string" ? v : (v as Record<string, string> | undefined)?.data;
      if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
        try {
          const r = decodeErrorResult({ abi: contractErrorsAbi, data: d as Hex });
          return `${r.errorName}${r.args?.length ? `(${r.args.map(String).join(", ")})` : ""}`;
        } catch { return `undecoded revert ${d.slice(0, 10)}`; }
      }
    }
    for (const k of ["cause", "error", "details"]) if (o[k] && typeof o[k] === "object") stack.push(o[k]);
  }
  const o = err as { shortMessage?: string; message?: string };
  return (o.shortMessage ?? o.message ?? "unknown").split(String.fromCharCode(10))[0] ?? "unknown";
}

const toRaw = (human: number) => {
  const [i, f = ""] = human.toFixed(DECIMALS).split(".");
  return BigInt((i ?? "0") + f.padEnd(DECIMALS, "0"));
};
const alignPrice = (p: bigint) => (p / TICK) * TICK;
const alignQty = (q: bigint) => (q / LOT) * LOT;

async function main() {
  const fund = acct("FUND_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wallet = createWalletClient({ account: fund, chain, transport: http(RPC) });

  console.log(`\nPROBE B — real Event Contract order`);
  console.log(`  rpc    ${RPC}`);
  console.log(`  trader ${fund.address}\n`);

  // ---- collateral --------------------------------------------------------
  let bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [fund.address] }) as bigint;
  if (bal < 10_000_000n) {
    const h = await wallet.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "faucet", args: [1_000_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [fund.address] }) as bigint;
  }
  console.log(`  tUSDC  ${formatUnits(bal, 6)}\n`);

  // ---- find a market with a crossable YES ask ----------------------------
  const ex = new SomniaMarkets({ indexerUrl: INDEXER, chain, wsRpcUrl: WS, addresses: EC as never } as never) as never as {
    loadMarkets(f: boolean): Promise<Record<string, unknown>>;
    fetchOrderBook(sym: string, depth: number): Promise<{ bids: [number, number][]; asks: [number, number][] }>;
  };
  const all = Object.values(await ex.loadMarkets(true)) as Record<string, unknown>[];
  const mine = all.filter((m) => {
    const info = m.info as Record<string, unknown> | undefined;
    return info?.marketType === "BINARY" && info?.venueId === VENUE_ID_TESTNET;
  });
  console.log(`  ${all.length} markets loaded, ${mine.length} binary on our venue`);

  let chosen: { m: Record<string, unknown>; sym: string; ask: number; pool: Address } | null = null;
  for (const m of mine.slice(0, 25)) {
    const outs = (m.outcomes ?? []) as { symbol?: string }[];
    const sym = outs[0]?.symbol;
    if (!sym) continue;
    try {
      const ob = await ex.fetchOrderBook(sym, 3);
      const ask = ob.asks?.[0]?.[0];
      const info = m.info as Record<string, unknown>;
      const pool = (m.pool ?? info?.poolAddress) as Address | undefined;
      if (ask && ask > 0 && ask < 0.97 && pool) { chosen = { m, sym, ask, pool }; break; }
    } catch { /* book unavailable, try next */ }
  }
  if (!chosen) throw new Error("no market with a crossable YES ask found");

  const { sym, ask, pool } = chosen;
  console.log(`  market ${sym}`);
  console.log(`  pool   ${pool}`);
  console.log(`  best YES ask ${ask}\n`);

  // ---- build the order ---------------------------------------------------
  // Price THROUGH the touch. We are charged the resting price, so an aggressive
  // limit buys certainty of crossing at no extra cost.
  // The indexer book LAGS the chain (EC gotcha 9), so "ask + a few ticks" is
  // priced against a quote that may already be gone — which is exactly what
  // happened on the first run: bid 0.545 into a 0.515 ask and it rested.
  // Because a taker is charged the FILL price and not the price it offered
  // (EC gotcha 7), bidding to the top of the range costs nothing extra and
  // removes the stale-book failure mode entirely. Cost is bounded by qty.
  const limit = Number(process.env.LIMIT ?? 0.99);
  const priceRaw = alignPrice(toRaw(limit));
  const qtyRaw = alignQty(toRaw(Number(process.env.QTY ?? 1)));
  const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;
  const args = [OrderKind.BUY_YES, priceRaw, qtyRaw, expireNs, 0, 0,
    "0x0000000000000000000000000000000000000000" as Address, 0n, 0n] as const;

  console.log(`  limit  ${limit} -> raw ${priceRaw} (tick-aligned: ${priceRaw % TICK === 0n})`);
  console.log(`  qty    raw ${qtyRaw}`);

  // ---- cancel a stale resting order, reclaiming its escrow ---------------
  const stale = process.env.CANCEL_ID;
  if (stale) {
    try {
      const h = await wallet.writeContract({ address: pool, abi: binaryPoolWriteAbi, functionName: "cancelOrder", args: [BigInt(stale)] });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      console.log(`  cancelled ${stale} status=${r.status}  ${NETWORK.explorer}/tx/${h}`);
    } catch (e) { console.log(`  cancel of ${stale} failed: ${explain(e)}`); }
  }

  // ---- approve -----------------------------------------------------------
  const allowance = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [fund.address, pool] }) as bigint;
  if (allowance < bal) {
    const h = await wallet.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [pool, bal] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  approved pool for ${formatUnits(bal, 6)} tUSDC`);
  }

  // ---- GUARD STEP 1: simulate -------------------------------------------
  console.log("\n  [guard 1] eth_call simulate...");
  const sim = await pub.simulateContract({
    account: fund, address: pool, abi: binaryPoolWriteAbi,
    functionName: "placeBinaryOrder", args: args as never,
  });
  const [success, simId] = sim.result as unknown as [boolean, bigint];
  console.log(`            success=${success} id=${simId}`);
  if (!success) {
    console.log("\n  ABORT — simulation returned success=false. Broadcasting would");
    console.log("  have mined a status=1 transaction that traded nothing.");
    process.exit(1);
  }
  // Broadcast at the SAME gas limit we simulated at — a sim at a higher limit lies.
  const gas = await pub.estimateContractGas({
    account: fund, address: pool, abi: binaryPoolWriteAbi,
    functionName: "placeBinaryOrder", args: args as never,
  });
  console.log(`            gas ${gas}`);

  // ---- broadcast ---------------------------------------------------------
  console.log("  [send ] broadcasting...");
  const hash = await wallet.writeContract({
    address: pool, abi: binaryPoolWriteAbi, functionName: "placeBinaryOrder",
    args: args as never, gas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  [mined] status=${rcpt.status} logs=${rcpt.logs.length}`);
  console.log(`          ${NETWORK.explorer}/tx/${hash}`);

  // ---- GUARD STEP 2: assert a placement log ------------------------------
  console.log("\n  [guard 2] asserting placement log in receipt...");
  if (rcpt.logs.length === 0) {
    console.log("  SILENT REJECTION — mined with status=1 and ZERO logs. Nothing rested.");
    process.exit(1);
  }
  let placedId: bigint | null = null;
  let fills = 0;
  let filledQty = 0n;
  for (const log of rcpt.logs) {
    if (log.topics[0] === TOPICS.BinaryOrderPlaced) {
      placedId = BigInt(log.topics[1] ?? "0x0");
    }
    if (log.topics[0] === TOPICS.OrderFilled) {
      fills++;
      try {
        const d = decodeEventLog({ abi: orderBookEventsAbi, data: log.data, topics: log.topics as never });
        const a = d.args as unknown as Record<string, bigint>;
        filledQty += a.quantityFilled ?? 0n;
      } catch { /* shape drift */ }
    }
  }
  if (placedId === null) {
    console.log("  NO BinaryOrderPlaced LOG — the order was rejected despite status=1.");
    process.exit(1);
  }
  console.log(`            BinaryOrderPlaced id=${placedId}  (read from RECEIPT, not simulation)`);
  console.log(`            OrderFilled events: ${fills}  filled qty raw ${filledQty}`);

  const after = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [fund.address] }) as bigint;
  console.log(`\n  tUSDC before ${formatUnits(bal, 6)} -> after ${formatUnits(after, 6)}  (spent ${formatUnits(bal - after, 6)})`);
  console.log(fills > 0 ? "\n  RESULT: FILLED\n" : "\n  RESULT: placed and RESTING (no cross)\n");
}

main().catch((e) => { console.error("\nPROBE B failed:", explain(e)); process.exit(1); });
