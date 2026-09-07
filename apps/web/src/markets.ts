/**
 * Market discovery, in its own module so screens can retry it.
 *
 * It lived in app.ts, which meant the retry button had to be wired at module
 * load — before the screen that renders it exists — so the control was dead.
 * Importing app.ts from a screen would be circular; this is the seam.
 */
import { state, set, type Market } from "./state.js";
import { errName } from "./chain.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../../../packages/leash-ec/src/discover.js";

export async function reloadMarkets(): Promise<void> {
  set({ marketsState: "loading", marketsError: "" });
  try {
    const c = ecClient();
    const found = await discoverMarkets(c, { windows: 10 });
    const r = await tradableMarketsDetailed(c, found, { headroomSec: 120n, limit: 6, maxChecks: 16 });

    if (r.live.length === 0) {
      set({
        markets: [],
        marketsState: r.errors > 0 ? "failed" : "empty",
        marketsError: r.errors > 0
          ? `${r.errors} of ${r.checked} on-chain checks failed — this is the RPC, not an empty venue.`
          : "",
      });
      return;
    }

    const markets: Market[] = r.live.map((m) => ({
      marketId: m.marketId,
      pool: m.pool,
      asset: m.asset,
      expiry: m.expiry,
      label: m.asset + " · resolves in " + Math.max(0, Math.floor((Number(m.expiry) - Date.now() / 1000) / 60)) + "m",
    }));
    set({
      markets,
      allowed: new Set(markets.map((m) => m.marketId as string)),
      marketsState: "ok",
      marketsError: "",
      activeMarket: 0,
      notice: r.errors > 0 ? `${markets.length} markets live; ${r.errors} checks failed, so the list may be short.` : "",
    });
  } catch (e) {
    set({ markets: [], marketsState: "failed", marketsError: errName(e) || "market discovery failed" });
  }
}
