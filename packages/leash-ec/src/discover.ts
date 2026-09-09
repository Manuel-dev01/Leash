/**
 * Chain-only market discovery. No indexer.
 *
 * Written because the indexer went down mid-Stage-2 (`EAI_AGAIN
 * dev.smk.somnia.host`, then HTTP 000 on a 16s timeout) while the RPC stayed
 * healthy. Every market-discovery path in the SDK goes through that indexer, so
 * an outage during the demo would mean no markets, no order, no beats 2 or 3.
 *
 * This is also what the venue's own guidance says to do: EC gotcha 9 —
 * "indexer rows lag the chain by seconds ... treat the chain as the source of
 * truth for anything you act on." We were already required to read fills from
 * chain (§4.2 r12). Discovery is the same argument.
 *
 * `BinaryMarketsModule.MarketCreated` carries marketId, market and pool in
 * INDEXED topics, so one topic-filtered `eth_getLogs` on a single address gives
 * everything needed to trade — no third party in the path.
 */
import {
  createPublicClient, http, decodeEventLog, parseAbi, keccak256, toHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import { EC, NETWORK } from "./constants.js";

/**
 * Verified against live logs on 2026-08-25: topic0
 * 0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd.
 * The same topic appears inside real finalization transactions, which is the
 * cross-check that the field list below is the deployed one.
 */
export const MARKET_CREATED_TOPIC0 =
  "0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd" as const;

export const marketCreatedAbi = parseAbi([
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 oracleQuestionId, uint32 operatorId, bytes32 venueId, address creator, address collateral, uint256 yesId, uint256 noId, uint64 nonce, uint8 outcomeSlotCount, uint8 marketType, uint64 tradingStart, uint64 expiry, uint8 voidPolicy, string asset, uint256 strike, string question, bytes context)",
]);

const binaryMarketReadAbi = parseAbi([
  "function isResolved() view returns (bool)",
  "function isVoided() view returns (bool)",
]);

const binaryPoolParamsAbi = parseAbi([
  "function getBinaryPoolParams() view returns ((address collateralToken, address market, address outcomeToken, uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking, address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k, uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k, address settlement, uint64 marketNonce, bool finalized))",
]);

export interface DiscoveredMarket {
  marketId: Hex;
  market: Address;
  pool: Address;
  venueId: Hex;
  collateral: Address;
  asset: string;
  strike: bigint;
  tradingStart: bigint;
  expiry: bigint;
  nonce: bigint;
  /**
   * The venue's own words for what this market resolves on, e.g.
   * "Pricefeed test: will BTC/USDC's price be at or above 79011.95 at unix
   * time 1788947700?".
   *
   * These four were decoded out of every MarketCreated log and then dropped on
   * the floor. They are the only human-readable description of a market that
   * exists anywhere on chain, and the app was showing an invented sparkline
   * instead of them.
   */
  question: string;
  marketType: number;
  voidPolicy: number;
  outcomeSlotCount: number;
}

/**
 * The pool's own parameters, as `getBinaryPoolParams()` returns them.
 *
 * `tradableMarketsDetailed` has always fetched this to check `finalized` and
 * the recycled-pool case, and thrown the rest away. Fees are real market terms
 * a delegate is agreeing to; they cost nothing extra to keep.
 */
export interface PoolParams {
  collateralToken: Address;
  outcomeToken: Address;
  oneCollateral: bigint;
  feeRecipient: Address;
  makerFeeBpsTimes1k: bigint;
  takerFeeBpsTimes1k: bigint;
  settlementFeeBpsTimes1k: bigint;
  settlement: Address;
  marketNonce: bigint;
  finalized: boolean;
}

/**
 * Derive-and-assert, per §0 rule 4. viem filters by a topic0 it computes from
 * the ABI above; that must equal the constant verified against live logs. If a
 * future signature change makes them disagree, this throws at import instead of
 * quietly returning zero markets — which would look exactly like "the venue is
 * quiet tonight" during a demo.
 */
const _derived = keccak256(toHex(
  "MarketCreated(bytes32,address,address,uint256,uint32,bytes32,address,address,uint256,uint256,uint64,uint8,uint8,uint64,uint64,uint8,string,uint256,string,bytes)",
));
if (_derived !== MARKET_CREATED_TOPIC0) {
  throw new Error(
    `MarketCreated topic0 mismatch: pinned ${MARKET_CREATED_TOPIC0}, derived ${_derived}. ` +
      "The event signature changed. Re-read it from a live receipt before trusting discovery.",
  );
}

export function ecClient(rpcUrl?: string): PublicClient {
  // This module is shared by the Node scripts AND the browser bundle, so it must
  // not assume `process` exists. A bare `process.env` here crashes the app.
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const url = rpcUrl ?? g.process?.env?.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
  return createPublicClient({ transport: http(url) }) as PublicClient;
}

/**
 * Scan backwards for markets created on `venueId`.
 *
 * Windowed at 999 blocks because the RPC rejects anything above 1000 — a limit
 * this repo documented and then violated once already, so it is enforced in
 * code here rather than trusted to memory.
 */
export async function discoverMarkets(
  client: PublicClient,
  opts: { venueId?: Hex; windows?: number; now?: bigint } = {},
): Promise<DiscoveredMarket[]> {
  const windows = opts.windows ?? 12;
  const span = BigInt(NETWORK.maxGetLogsBlockRange - 1);
  const head = await client.getBlockNumber();
  const out: DiscoveredMarket[] = [];
  const seen = new Set<string>();
  let decodeFailures = 0;
  let fetchFailures = 0;

  // The windows are INDEPENDENT, so they go out together. Serially, ten
  // 1000-block queries against a slow public RPC kept the app on "reading live
  // markets from chain…" for tens of seconds before anything was clickable.
  // Ordering is restored afterwards so results stay deterministic.
  const ranges: { lo: bigint; hi: bigint }[] = [];
  for (let i = 0; i < windows; i++) {
    const hi = head - BigInt(i) * BigInt(NETWORK.maxGetLogsBlockRange);
    if (hi <= span) break;
    ranges.push({ lo: hi - span, hi });
  }
  const pages = await Promise.all(
    ranges.map((r) =>
      client.getLogs({
        address: EC.binaryModule as Address,
        fromBlock: r.lo,
        toBlock: r.hi,
        event: marketCreatedAbi[0],
      }).catch(() => {
        // One failed window must not lose the other nine — but a FETCH failure
        // is not a DECODE failure, and reporting it as one would diagnose an
        // RPC outage as an event-shape change.
        fetchFailures++;
        return [] as Awaited<ReturnType<typeof client.getLogs>>;
      }),
    ),
  );
  for (const logs of pages) {
    for (const l of logs) {
      try {
        const d = decodeEventLog({ abi: marketCreatedAbi, data: l.data, topics: l.topics as never });
        const a = d.args as unknown as DiscoveredMarket;
        if (opts.venueId && a.venueId.toLowerCase() !== opts.venueId.toLowerCase()) continue;
        if (seen.has(a.marketId)) continue;
        seen.add(a.marketId);
        out.push({
          marketId: a.marketId, market: a.market, pool: a.pool, venueId: a.venueId,
          collateral: a.collateral, asset: a.asset, strike: a.strike,
          tradingStart: a.tradingStart, expiry: a.expiry, nonce: a.nonce,
          question: a.question ?? "", marketType: Number(a.marketType ?? 0),
          voidPolicy: Number(a.voidPolicy ?? 0),
          outcomeSlotCount: Number(a.outcomeSlotCount ?? 0),
        });
      } catch {
        // Counted, not hidden. If MarketCreated's shape drifts, discovery would
        // otherwise just return fewer markets and look like a quiet venue.
        decodeFailures++;
      }
    }
  }
  if (fetchFailures > 0 && out.length === 0) {
    throw new Error(
      `discoverMarkets: ${fetchFailures} of ${ranges.length} log windows failed to fetch and nothing ` +
        "was found. This is the RPC — do not report it as an empty venue.",
    );
  }
  if (decodeFailures > 0 && out.length === 0) {
    throw new Error(
      `discoverMarkets: ${decodeFailures} MarketCreated logs matched the pinned ` +
        "topic0 but none decoded. The event shape changed — do not report this as an empty venue.",
    );
  }
  return out;
}

/**
 * Filter to markets that will actually accept an order, verified on-chain.
 *
 * Three independent checks, because each catches a different failure:
 *   - expiry in the future, with headroom (a window can close between our
 *     snapshot and our inclusion — EC gotcha 8)
 *   - the market is neither resolved nor voided
 *   - the POOL still points at THIS market and is not finalized. Pools are
 *     recycled, so a pool that served our market a minute ago may now be
 *     serving a different one; comparing `params.market` is what catches it.
 */
export interface TradableResult {
  live: DiscoveredMarket[];
  checked: number;
  errors: number;
  /**
   * The pool params read during the tradability check, keyed by marketId.
   *
   * Returned rather than discarded: the read already happened, and asking the
   * chain a second time for something we just had would be the sort of extra
   * traffic that made an earlier build hang a browser context on teardown.
   */
  params: Record<string, PoolParams>;
}

/**
 * Filter to markets that will actually accept an order, verified on-chain.
 *
 * Three independent checks, because each catches a different failure:
 *   - expiry in the future, with headroom (a window can close between our
 *     snapshot and our inclusion — EC gotcha 8)
 *   - the market is neither resolved nor voided
 *   - the POOL still points at THIS market and is not finalized. Pools are
 *     recycled, so a pool that served our market a minute ago may now be
 *     serving a different one; comparing `params.market` is what catches it.
 *
 * BOUNDED, and it REPORTS ITS FAILURES. An earlier version walked every
 * candidate (126 markets x 3 reads) and swallowed errors in a bare catch, so
 * RPC rate-limiting came back as "0 tradable" — indistinguishable from a quiet
 * venue, and it cost a Stage 3 run to diagnose. Callers get the error count so a
 * degraded RPC cannot masquerade as an empty market list.
 */
export async function tradableMarketsDetailed(
  client: PublicClient,
  markets: DiscoveredMarket[],
  opts: { headroomSec?: bigint; limit?: number; maxChecks?: number } = {},
): Promise<TradableResult> {
  const headroom = opts.headroomSec ?? 60n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const limit = opts.limit ?? 8;
  const maxChecks = opts.maxChecks ?? 24;
  const live: DiscoveredMarket[] = [];
  const params: Record<string, PoolParams> = {};
  let checked = 0;
  let errors = 0;

  const candidates = markets
    .filter((m) => m.expiry > now + headroom && m.tradingStart <= now)
    .sort((a, b) => Number(a.expiry - b.expiry)); // soonest first: most useful for a demo

  /** One candidate, three reads. Returns null when it is not tradable. */
  const inspect = async (m: DiscoveredMarket): Promise<DiscoveredMarket | null> => {
    const p = (await client.readContract({
      address: m.pool, abi: binaryPoolParamsAbi, functionName: "getBinaryPoolParams",
    })) as unknown as PoolParams & { market: Address };
    if (p.finalized) return null;
    if (p.market.toLowerCase() !== m.market.toLowerCase()) return null; // pool was recycled
    // Kept only once the pool is confirmed to still serve THIS market, so a
    // recycled pool's terms can never be shown against the wrong market.
    params[m.marketId] = p;
    const [resolved, voided] = await Promise.all([
      client.readContract({ address: m.market, abi: binaryMarketReadAbi, functionName: "isResolved" }) as Promise<boolean>,
      client.readContract({ address: m.market, abi: binaryMarketReadAbi, functionName: "isVoided" }) as Promise<boolean>,
    ]);
    return resolved || voided ? null : m;
  };

  // Checked in BATCHES rather than one at a time. Serially this was up to three
  // round-trips per candidate, all of them blocking the first usable render;
  // the batch keeps the same bounds (`limit`, `maxChecks`) and the same error
  // accounting, and preserves soonest-first ordering within each batch.
  const BATCH = 6;
  for (let i = 0; i < candidates.length && live.length < limit && checked < maxChecks; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    checked += slice.length;
    const settled = await Promise.all(
      slice.map((m) => inspect(m).catch(() => { errors++; return null; })),
    );
    for (const m of settled) {
      if (m && live.length < limit) live.push(m);
    }
  }
  return { live, checked, errors, params };
}

/** Convenience wrapper. Throws if every check errored — that is an RPC problem, not an empty venue. */
export async function tradableMarkets(
  client: PublicClient,
  markets: DiscoveredMarket[],
  opts: { headroomSec?: bigint; limit?: number; maxChecks?: number } = {},
): Promise<DiscoveredMarket[]> {
  const r = await tradableMarketsDetailed(client, markets, opts);
  if (r.live.length === 0 && r.errors > 0 && r.errors === r.checked) {
    throw new Error(
      `tradableMarkets: all ${r.checked} on-chain checks failed. This is an RPC ` +
        "problem, not an empty venue — do not report it as 'no markets'.",
    );
  }
  return r.live;
}
