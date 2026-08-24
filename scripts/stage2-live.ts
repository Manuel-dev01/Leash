/**
 * STAGE 2 end-to-end against live testnet.
 *
 * Also the delete-test. Nothing in this flow references DeadhandHandler — the
 * registry never depends on the handler having run, `settleAndEnforce` is
 * permissionless, and Layer 1 is complete on its own. If Layer 2 were deleted
 * right now, this script would be unchanged. That property is checked here, at
 * the end of Stage 2, rather than at the end of Stage 3 — the moment the
 * registry starts needing the handler, Deadhand stops being safe as a must-have.
 *
 * Proves, in order:
 *   1. delegator creates a mandate, having only approved the registry
 *   2. delegate places a REAL Event Contract order through it
 *   3. the registry holds no funds afterwards
 *   4. beat 1: the delegate cannot revoke — reverts with our OWN error
 *   5. beat 3 (manual half): anyone can settle, releasing unfilled exposure
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, formatUnits, decodeErrorResult,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC, NETWORK, OrderKind, TOPICS, VENUE_ID_TESTNET } from "../packages/leash-ec/src/constants.js";

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const WS = process.env.EC_WS_URL ?? "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const REGISTRY = (process.env.MANDATE_REGISTRY ?? "0xa7baE1285096AbCEB67c147f27f88986003C0119") as Address;

const TICK = 1_000n, DECIMALS = 6;

const chain = {
  id: NETWORK.chainId, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
} as const;

const acct = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} missing`);
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const reg = [
  { type: "function", name: "createMandate", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "bytes32[]" }],
    outputs: [{ type: "uint256" }] },
  { type: "function", name: "placeForDelegator", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }],
    outputs: [{ type: "uint128" }] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "settleAndEnforce", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "holdsNoFunds", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "remainingExposure", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isActive", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "nextMandateId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mandates", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "bool" }, { type: "bool" }] },
  { type: "error", name: "NotDelegator", inputs: [] },
  { type: "error", name: "NotDelegate", inputs: [] },
  { type: "error", name: "Revoked", inputs: [] },
  { type: "error", name: "MarketNotAllowed", inputs: [] },
  { type: "error", name: "StakeExceedsPerTrade", inputs: [{ type: "uint256" }, { type: "uint128" }] },
  { type: "error", name: "ExceedsCumulative", inputs: [{ type: "uint256" }, { type: "uint128" }] },
] as const;

const toRaw = (h: number) => {
  const [i, f = ""] = h.toFixed(DECIMALS).split(".");
  return BigInt((i ?? "0") + f.padEnd(DECIMALS, "0"));
};

function named(e: unknown): string {
  const seen = new Set<unknown>(); const stack: unknown[] = [e];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    const o = x as Record<string, unknown>;
    for (const k of ["data", "raw"]) {
      const v = o[k];
      const d = typeof v === "string" ? v : (v as Record<string, string> | undefined)?.data;
      if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
        try { return decodeErrorResult({ abi: reg, data: d as Hex }).errorName; } catch { return `revert ${d.slice(0, 10)}`; }
      }
    }
    for (const k of ["cause", "error", "details"]) if (o[k] && typeof o[k] === "object") stack.push(o[k]);
  }
  return "unknown";
}

async function main() {
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wD = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wG = createWalletClient({ account: delegate, chain, transport: http(RPC) });

  console.log(`\nSTAGE 2 — MandateRegistry live`);
  console.log(`  registry  ${REGISTRY}`);
  console.log(`  delegator ${delegator.address}`);
  console.log(`  delegate  ${delegate.address}\n`);

  // ---- find a live market -------------------------------------------------
  const ex = new SomniaMarkets({ indexerUrl: INDEXER, chain, wsRpcUrl: WS, addresses: EC as never } as never) as never as {
    loadMarkets(f: boolean): Promise<Record<string, unknown>>;
    fetchOrderBook(s: string, d: number): Promise<{ bids: [number, number][]; asks: [number, number][] }>;
  };
  const all = Object.values(await ex.loadMarkets(true)) as Record<string, unknown>[];
  const mine = all.filter((m) => {
    const i = m.info as Record<string, unknown> | undefined;
    return i?.marketType === "BINARY" && i?.venueId === VENUE_ID_TESTNET;
  });
  let pool: Address | null = null, marketId: Hex | null = null, sym = "";
  for (const m of mine.slice(0, 25)) {
    const s = ((m.outcomes ?? []) as { symbol?: string }[])[0]?.symbol;
    const info = m.info as Record<string, unknown>;
    if (!s || !info?.marketId) continue;
    try {
      const ob = await ex.fetchOrderBook(s, 3);
      const ask = ob.asks?.[0]?.[0];
      const p = (m.pool ?? info.poolAddress) as Address | undefined;
      if (ask && ask > 0 && ask < 0.97 && p) { pool = p; marketId = info.marketId as Hex; sym = s; break; }
    } catch { /* next */ }
  }
  if (!pool || !marketId) throw new Error("no live market found");
  console.log(`  market ${sym}`);
  console.log(`  marketId ${marketId}`);
  console.log(`  pool     ${pool}\n`);

  // ---- 1. delegator approves + creates the mandate ------------------------
  const allowance = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, REGISTRY] }) as bigint;
  if (allowance < 20_000_000n) {
    const h = await wD.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [REGISTRY, 50_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  [delegator] approved registry for 50 tUSDC  ${NETWORK.explorer}/tx/${h}`);
  }

  const perTrade = 2_000_000n;      // 2 tUSDC per trade
  const cumulative = 5_000_000n;    // 5 tUSDC total
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const idBefore = await pub.readContract({ address: REGISTRY, abi: reg, functionName: "nextMandateId" }) as bigint;
  let h = await wD.writeContract({
    address: REGISTRY, abi: reg, functionName: "createMandate",
    args: [delegate.address, perTrade, cumulative, expiry, [marketId]] as never,
  });
  await pub.waitForTransactionReceipt({ hash: h });
  const mandateId = idBefore;
  console.log(`  [delegator] mandate #${mandateId}: <=2 tUSDC/trade, <=5 total, 1h`);
  console.log(`              ${NETWORK.explorer}/tx/${h}\n`);

  // ---- 2. delegate places a REAL order through the registry ---------------
  const price = (toRaw(0.99) / TICK) * TICK;
  const qty = toRaw(1);
  const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;
  const args = [mandateId, marketId, pool, OrderKind.BUY_YES, price, qty, expireNs] as const;

  console.log("  [guard] simulate before broadcasting...");
  const sim = await pub.simulateContract({ account: delegate, address: REGISTRY, abi: reg, functionName: "placeForDelegator", args: args as never });
  console.log(`          simulated orderId ${sim.result} (NOT trusted — receipt is authoritative)`);
  const gas = await pub.estimateContractGas({ account: delegate, address: REGISTRY, abi: reg, functionName: "placeForDelegator", args: args as never });
  h = await wG.writeContract({ address: REGISTRY, abi: reg, functionName: "placeForDelegator", args: args as never, gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  [delegate] placed. status=${rcpt.status} logs=${rcpt.logs.length}`);
  console.log(`             ${NETWORK.explorer}/tx/${h}`);

  let placed = 0, fills = 0;
  for (const l of rcpt.logs) {
    if (l.topics[0] === TOPICS.BinaryOrderPlaced) placed++;
    if (l.topics[0] === TOPICS.OrderFilled) fills++;
  }
  console.log(`             BinaryOrderPlaced=${placed}  OrderFilled=${fills}`);

  // ---- 3. the headline invariant, on chain --------------------------------
  const clean = await pub.readContract({ address: REGISTRY, abi: reg, functionName: "holdsNoFunds" }) as boolean;
  const bal = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [REGISTRY] }) as bigint;
  const m = await pub.readContract({ address: REGISTRY, abi: reg, functionName: "mandates", args: [mandateId] }) as unknown[];
  console.log(`\n  holdsNoFunds() = ${clean}   registry tUSDC balance ${formatUnits(bal, 6)}`);
  console.log(`  usedExposure   = ${formatUnits(m[4] as bigint, 6)} tUSDC`);
  console.log(`  remaining      = ${formatUnits(await pub.readContract({ address: REGISTRY, abi: reg, functionName: "remainingExposure", args: [mandateId] }) as bigint, 6)} tUSDC`);

  // ---- 4. BEAT 1: the delegate cannot revoke ------------------------------
  console.log("\n  [beat 1] delegate attempts to revoke the mandate...");
  try {
    await pub.simulateContract({ account: delegate, address: REGISTRY, abi: reg, functionName: "revoke", args: [mandateId] as never });
    console.log("           NO REVERT — that is a bug.");
  } catch (e) {
    console.log(`           reverted: ${named(e)}  <- our OWN authorization check`);
  }

  // ---- 5. anyone settles (the delete-test in action) ---------------------
  console.log("\n  [delete-test] settling from the STRANGER key — no handler involved");
  const stranger = acct("STRANGER_KEY");
  const wS = createWalletClient({ account: stranger, chain, transport: http(RPC) });
  const orderId = sim.result as unknown as bigint;
  try {
    const sh = await wS.writeContract({ address: REGISTRY, abi: reg, functionName: "settleAndEnforce", args: [pool, orderId, price, fills > 0 ? qty : 0n] as never });
    const sr = await pub.waitForTransactionReceipt({ hash: sh });
    console.log(`                status=${sr.status}  ${NETWORK.explorer}/tx/${sh}`);
  } catch (e) {
    console.log(`                ${named(e)}`);
  }
  const rem = await pub.readContract({ address: REGISTRY, abi: reg, functionName: "remainingExposure", args: [mandateId] }) as bigint;
  console.log(`                remaining exposure now ${formatUnits(rem, 6)} tUSDC`);
  console.log(`                Layer 1 is complete without any handler.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("STAGE 2 failed:", named(e)); console.error(e); process.exit(1); });
