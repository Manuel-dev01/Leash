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
  const url = rpcUrl ?? process.env.EC_RPC_URL ?? "https://api.infra.testnet.somnia.network";
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

  for (let i = 0; i < windows; i++) {
    const hi = head - BigInt(i) * BigInt(NETWORK.maxGetLogsBlockRange);
    if (hi <= span) break;
    const logs = await client.getLogs({
      address: EC.binaryModule as Address,
      fromBlock: hi - span,
      toBlock: hi,
      event: marketCreatedAbi[0],
    });
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
        });
      } catch { /* shape drift — skip rather than crash discovery */ }
    }
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
export async function tradableMarkets(
  client: PublicClient,
  markets: DiscoveredMarket[],
  opts: { headroomSec?: bigint; limit?: number } = {},
): Promise<DiscoveredMarket[]> {
  const headroom = opts.headroomSec ?? 60n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const limit = opts.limit ?? 8;
  const live: DiscoveredMarket[] = [];

  const candidates = markets
    .filter((m) => m.expiry > now + headroom && m.tradingStart <= now)
    .sort((a, b) => Number(b.expiry - a.expiry));

  for (const m of candidates) {
    if (live.length >= limit) break;
    try {
      const params = (await client.readContract({
        address: m.pool, abi: binaryPoolParamsAbi, functionName: "getBinaryPoolParams",
      })) as unknown as { market: Address; finalized: boolean };
      if (params.finalized) continue;
      if (params.market.toLowerCase() !== m.market.toLowerCase()) continue; // pool was recycled
      const [resolved, voided] = await Promise.all([
        client.readContract({ address: m.market, abi: binaryMarketReadAbi, functionName: "isResolved" }) as Promise<boolean>,
        client.readContract({ address: m.market, abi: binaryMarketReadAbi, functionName: "isVoided" }) as Promise<boolean>,
      ]);
      if (resolved || voided) continue;
      live.push(m);
    } catch { /* not readable — skip */ }
  }
  return live;
}
