/**
 * What a binary market has actually traded at, read from chain.
 *
 * WHY THIS IS SO THIN. There is no order book to read. `getBookLevels` is a
 * spot signature and REVERTS on binary pools (see docs/sdk-feedback.md item 7,
 * where we ask the sponsor for a `getBinaryBookLevels`), and
 * `BinaryOrderPlaced(uint128,uint8)` carries an id and a side — no price. So
 * the only price that exists on chain for a binary market is `fillPrice` on
 * `OrderFilled`, and binary books are quote-only: 161 orders produced 1 fill in
 * a measured ~100s window.
 *
 * That makes "no fills recently" the NORMAL answer, and it is a true and useful
 * one. It is reported as such. Nothing here ever returns a placeholder, a last
 * known value, or a zero dressed as a price — the screen this feeds replaced a
 * hardcoded twelve-point sparkline, and putting a subtler invention in its place
 * would miss the entire point of removing it.
 */
import { parseAbiItem, type Address, type PublicClient } from "viem";
import { NETWORK } from "./constants.js";

/**
 * Scoped to ONE pool address on purpose. `OrderFilled` is emitted by spot and
 * perp pools too, and a chain-wide read of it is what produced this build's
 * retracted "233 fills" figure.
 */
const orderFilledAbi = parseAbiItem(
  "event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)",
);

export interface RecentFills {
  /** Fills found in the window, newest first. Empty is the common case. */
  fills: { price: bigint; quantity: bigint; block: bigint }[];
  /** Blocks actually searched, so the caller can say how far back it looked. */
  blocksSearched: number;
  /** True when the read itself failed — NOT the same as "no fills". */
  failed: boolean;
}

/**
 * Fills on one pool over the last window of blocks.
 *
 * Bounded at the RPC's 1000-block cap, which this repo documented and then
 * violated once. At ~0.1s per block that is roughly the last 100 seconds.
 *
 * Uses viem's `event` form deliberately: this RPC IGNORES the `topics`
 * parameter entirely (proven with the probe pattern — a request for a topic0
 * matching nothing returned three logs carrying a different topic0), and viem
 * re-filters client-side in strict mode. A raw eth_getLogs here would return
 * whatever else the pool emitted and decode it as fills.
 */
export async function recentFills(
  client: PublicClient,
  pool: Address,
  opts: { blocks?: number } = {},
): Promise<RecentFills> {
  const span = Math.min(opts.blocks ?? NETWORK.maxGetLogsBlockRange - 1,
                        NETWORK.maxGetLogsBlockRange - 1);
  try {
    const head = await client.getBlockNumber();
    const from = head > BigInt(span) ? head - BigInt(span) : 0n;
    const logs = await client.getLogs({
      address: pool, event: orderFilledAbi, fromBlock: from, toBlock: head,
    });
    const fills = logs
      .map((l) => ({
        price: (l.args as { fillPrice?: bigint }).fillPrice ?? 0n,
        quantity: (l.args as { quantityFilled?: bigint }).quantityFilled ?? 0n,
        block: l.blockNumber ?? 0n,
      }))
      // A fill decoded without a price is a decode problem, not a trade at zero.
      .filter((f) => f.price > 0n)
      .sort((a, b) => Number(b.block - a.block));
    return { fills, blocksSearched: span, failed: false };
  } catch {
    // Distinguished from "no fills" by the caller. Reporting a failed read as a
    // quiet market is the exact confusion `discover.ts` exists to prevent.
    return { fills: [], blocksSearched: span, failed: true };
  }
}
