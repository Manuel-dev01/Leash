/**
 * PROBE B2 — does Leash need custody at all?
 *
 * Probe A killed in-path routing (`placeBinaryOrderFor` is contract-allowlisted).
 * The naive fallback is deposit-custody: the delegator funds MandateRegistry and
 * the registry trades as itself. That reintroduces exactly the thing the pitch
 * claims to remove.
 *
 * The alternative tested here: the registry holds NOTHING at rest and pulls
 * collateral just-in-time, inside the same transaction that places the order.
 *
 *   delegator approves ProbeRouter          <- principal never leaves their wallet
 *   DELEGATE calls placeFor(...)            <- the delegate, not the delegator
 *     |- transferFrom(delegator -> router)  just-in-time
 *     |- approve(pool) + placeBinaryOrder   placed as the ROUTER
 *
 * Three things must be true for custody to disappear:
 *   1. a CONTRACT can place a binary order at all
 *   2. the DELEGATE can trigger it while the delegator only ever signed an approve
 *   3. the router's resting balance afterwards is ZERO
 */
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, decodeErrorResult,
  formatUnits, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { EC, NETWORK, OrderKind, TOPICS, VENUE_ID_TESTNET } from "../packages/leash-ec/src/constants.js";

const errorsPath = resolve(process.cwd(), "node_modules/@somnia-chain/markets-sdk/dist/contractErrorsAbi.js");
const { contractErrorsAbi } = await import(pathToFileURL(errorsPath).href);

const RPC = process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
const WS = process.env.EC_WS_URL ?? "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
const ROUTER = (process.env.PROBE_ROUTER ?? "0x6033B3eBe3A76eE58C6E7B778628C5642c4ce58F") as Address;

const TICK = 1_000n, LOT = 1n, DECIMALS = 6;

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

const routerAbi = [
  { type: "function", name: "placeFor", stateMutability: "nonpayable",
    inputs: [
      { name: "delegator", type: "address" }, { name: "collateral", type: "address" },
      { name: "pool", type: "address" }, { name: "cost", type: "uint256" },
      { name: "o", type: "tuple", components: [
        { name: "kind", type: "uint8" }, { name: "price", type: "uint256" },
        { name: "quantity", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" },
        { name: "orderType", type: "uint8" }, { name: "selfMatchingOption", type: "uint8" },
      ]},
    ],
    outputs: [{ name: "success", type: "bool" }, { name: "id", type: "uint128" }] },
  { type: "function", name: "restingBalance", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

function explain(err: unknown): string {
  const seen = new Set<unknown>(); const stack: unknown[] = [err];
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

const toRaw = (h: number) => {
  const [i, f = ""] = h.toFixed(DECIMALS).split(".");
  return BigInt((i ?? "0") + f.padEnd(DECIMALS, "0"));
};

async function main() {
  const delegator = acct("FUND_KEY");
  const delegate = acct("DELEGATE_KEY");
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wDelegator = createWalletClient({ account: delegator, chain, transport: http(RPC) });
  const wDelegate = createWalletClient({ account: delegate, chain, transport: http(RPC) });

  console.log("\nPROBE B2 — just-in-time allowance, no custody");
  console.log(`  router    ${ROUTER}`);
  console.log(`  delegator ${delegator.address}  (only ever signs an approve)`);
  console.log(`  delegate  ${delegate.address}  (triggers the trade)\n`);

  // ---- market ------------------------------------------------------------
  const ex = new SomniaMarkets({ indexerUrl: INDEXER, chain, wsRpcUrl: WS, addresses: EC as never } as never) as never as {
    loadMarkets(f: boolean): Promise<Record<string, unknown>>;
    fetchOrderBook(s: string, d: number): Promise<{ bids: [number, number][]; asks: [number, number][] }>;
  };
  const all = Object.values(await ex.loadMarkets(true)) as Record<string, unknown>[];
  const mine = all.filter((m) => {
    const i = m.info as Record<string, unknown> | undefined;
    return i?.marketType === "BINARY" && i?.venueId === VENUE_ID_TESTNET;
  });
  let pool: Address | null = null, sym = "";
  for (const m of mine.slice(0, 25)) {
    const s = ((m.outcomes ?? []) as { symbol?: string }[])[0]?.symbol;
    if (!s) continue;
    try {
      const ob = await ex.fetchOrderBook(s, 3);
      const ask = ob.asks?.[0]?.[0];
      const p = (m.pool ?? (m.info as Record<string, unknown>)?.poolAddress) as Address | undefined;
      if (ask && ask > 0 && ask < 0.97 && p) { pool = p; sym = s; break; }
    } catch { /* next */ }
  }
  if (!pool) throw new Error("no market with a crossable ask");
  console.log(`  market ${sym}`);
  console.log(`  pool   ${pool}\n`);

  // ---- order params ------------------------------------------------------
  const price = (toRaw(0.99) / TICK) * TICK;
  const qty = (toRaw(1) / LOT) * LOT;
  const cost = (price * qty) / 1_000_000n;          // worst-case pull
  const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;

  // ---- delegator's ONLY action: an ERC-20 approve ------------------------
  const cur = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "allowance", args: [delegator.address, ROUTER] }) as bigint;
  if (cur < cost) {
    const h = await wDelegator.writeContract({ address: EC.collateral as Address, abi: erc20, functionName: "approve", args: [ROUTER, 10_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  [delegator] approved router for 10 tUSDC  ${NETWORK.explorer}/tx/${h}`);
  } else {
    console.log(`  [delegator] existing allowance ${formatUnits(cur, 6)} tUSDC`);
  }

  const dBefore = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  const rBefore = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "restingBalance", args: [EC.collateral as Address] }) as bigint;
  console.log(`  delegator tUSDC ${formatUnits(dBefore, 6)}   router resting ${formatUnits(rBefore, 6)}\n`);

  // ---- THE DELEGATE places, having never held collateral -----------------
  const order = { kind: OrderKind.BUY_YES, price, quantity: qty, expireTimestampNs: expireNs, orderType: 0, selfMatchingOption: 0 };
  console.log("  [guard 1] simulate as DELEGATE...");
  const sim = await pub.simulateContract({
    account: delegate, address: ROUTER, abi: routerAbi, functionName: "placeFor",
    args: [delegator.address, EC.collateral as Address, pool, cost, order] as never,
  });
  const [ok, simId] = sim.result as unknown as [boolean, bigint];
  console.log(`            success=${ok} id=${simId}`);
  if (!ok) { console.log("\n  ABORT — pool returned success=false"); process.exit(1); }

  const gas = await pub.estimateContractGas({
    account: delegate, address: ROUTER, abi: routerAbi, functionName: "placeFor",
    args: [delegator.address, EC.collateral as Address, pool, cost, order] as never,
  });
  const hash = await wDelegate.writeContract({
    address: ROUTER, abi: routerAbi, functionName: "placeFor",
    args: [delegator.address, EC.collateral as Address, pool, cost, order] as never, gas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  [mined]   status=${rcpt.status} logs=${rcpt.logs.length}`);
  console.log(`            ${NETWORK.explorer}/tx/${hash}`);

  let placed = 0, fills = 0;
  for (const l of rcpt.logs) {
    if (l.topics[0] === TOPICS.BinaryOrderPlaced) placed++;
    if (l.topics[0] === TOPICS.OrderFilled) fills++;
  }
  console.log(`  [guard 2] BinaryOrderPlaced=${placed}  OrderFilled=${fills}`);

  const dAfter = await pub.readContract({ address: EC.collateral as Address, abi: erc20, functionName: "balanceOf", args: [delegator.address] }) as bigint;
  const rAfter = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: "restingBalance", args: [EC.collateral as Address] }) as bigint;

  console.log(`\n  delegator tUSDC ${formatUnits(dBefore, 6)} -> ${formatUnits(dAfter, 6)}`);
  console.log(`  router resting  ${formatUnits(rBefore, 6)} -> ${formatUnits(rAfter, 6)}`);

  console.log("\n  VERDICT");
  console.log(`    contract can place binary orders : ${placed > 0 ? "YES" : "NO"}`);
  console.log(`    delegate triggered it            : YES (sender was ${delegate.address})`);
  console.log(`    order filled                     : ${fills > 0 ? "YES" : "no, rested"}`);
  console.log(`    router balance at rest           : ${formatUnits(rAfter, 6)} tUSDC`);
  console.log(rAfter === 0n
    ? "\n    => NO CUSTODY NEEDED. Principal never rests in our contract.\n"
    : `\n    => residual ${formatUnits(rAfter, 6)} tUSDC left in router — MandateRegistry must\n       sweep the unspent remainder back to the delegator in the same tx.\n`);
}

main().catch((e) => { console.error("\nPROBE B2 failed:", explain(e)); process.exit(1); });
