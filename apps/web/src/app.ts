/**
 * App shell: rail, 380px frame, screen dispatch.
 *
 * Markets come from CHAIN, never from the indexer. The indexer went down
 * mid-build and every SDK discovery path goes through it, so an outage during
 * the demo would mean no markets and no order. `discoverMarkets` reads
 * MarketCreated straight from the module singleton instead.
 */
import { state, set, subscribe, NAV, WHY, type Role, type Screen, type Market } from "./state.js";
import {
  addNetwork, onRightChain, connect, REGISTRY, pub, registryAbi,
} from "./chain.js";
import {
  connectScreen, bindConnect, pickScreen, bindPick, limitsScreen, bindLimits,
  reviewScreen, bindReview, monitorScreen, monitorData, bindMonitor,
  revokeScreen, bindRevoke, type MonitorData,
} from "./screens/delegator.js";
import {
  tradeScreen, bindTrade, marketScreen, bindMarket, positionsScreen,
} from "./screens/delegate.js";
import { ecClient, discoverMarkets, tradableMarketsDetailed } from "../../../packages/leash-ec/src/discover.js";
import type { Address } from "viem";
import "./design.css";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let monitor: MonitorData | null = null;

// ---- boot params ---------------------------------------------------------

const q = new URLSearchParams(location.search);
const roleParam = q.get("role");
if (roleParam === "delegate") {
  state.role = "delegate";
  state.screen = "trade";
}
const mParam = q.get("m");
if (mParam) state.mandateId = BigInt(mParam);

// ---- render --------------------------------------------------------------

function renderRail() {
  $("tab-delegator").className = state.role === "delegator" ? "on" : "";
  $("tab-delegate").className = state.role === "delegate" ? "on" : "";
  $("nav").innerHTML = NAV[state.role]
    .map(([n, label, screen]) =>
      '<button class="navrow' + (state.screen === screen ? " on" : "") + '" data-go="' + screen + '">' +
      '<span class="n">' + n + "</span><span>" + label + "</span></button>")
    .join("");
  $("nav").querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => {
    b.addEventListener("click", () => set({ screen: b.dataset.go as Screen, error: "" }));
  });
  $("why").textContent = WHY[state.screen] ?? "";
  $("netline").textContent = state.onChain ? "chain 50312 · ready" : "chain 50312";
  $("chip").textContent = state.onChain ? "network ready" : "add somnia 50312";
  $("chip").className = "chip" + (state.onChain ? " on" : "");
}

function renderScreen() {
  const s = state.screen;
  const html =
    s === "connect" ? connectScreen()
    : s === "pick" ? pickScreen()
    : s === "limits" ? limitsScreen()
    : s === "review" ? reviewScreen()
    : s === "monitor" ? monitorScreen(monitor)
    : s === "revoke" ? revokeScreen()
    : s === "trade" ? tradeScreen(monitor)
    : s === "market" ? marketScreen(monitor)
    : positionsScreen(monitor);
  $("screen").innerHTML = html;

  if (s === "connect") bindConnect();
  else if (s === "pick") bindPick();
  else if (s === "limits") bindLimits();
  else if (s === "review") bindReview();
  else if (s === "monitor") bindMonitor();
  else if (s === "revoke") bindRevoke();
  else if (s === "trade") bindTrade();
  else if (s === "market") bindMarket();
}

function render() {
  renderRail();
  renderScreen();
}
subscribe(render);

// ---- chain-side loading --------------------------------------------------

/**
 * Live markets, from chain. Bounded and error-reporting: a degraded RPC must
 * never come back as "no markets", which reads identically to a quiet venue.
 */
async function loadMarkets() {
  try {
    const c = ecClient();
    const found = await discoverMarkets(c, { windows: 10 });
    const r = await tradableMarketsDetailed(c, found, { headroomSec: 120n, limit: 4, maxChecks: 16 });
    if (r.live.length === 0 && r.errors > 0) {
      set({ error: "rpc degraded (" + r.errors + " failed checks) — not an empty venue" });
      return;
    }
    const markets: Market[] = r.live.map((m) => ({
      marketId: m.marketId,
      pool: m.pool,
      asset: m.asset,
      expiry: m.expiry,
      label: m.asset + " · resolves in " + Math.max(0, Math.floor((Number(m.expiry) - Date.now() / 1000) / 60)) + "m",
    }));
    // Default the draft to everything found, so the delegator edits rather than
    // starts from nothing. This is a DRAFT, not a fact about any mandate:
    // `allowedKnown` stays false until refreshMandate checks it on chain.
    const allowed = new Set(markets.map((m) => m.marketId as string));
    if (r.errors > 0) {
      set({ markets, allowed, error: `${r.live.length} markets live, ${r.errors} checks failed — the list may be short` });
      return;
    }
    set({ markets, allowed });
  } catch (e) {
    set({ error: (e as Error).message.split("\n")[0] ?? "market discovery failed" });
  }
}

/**
 * If a mandate is open, re-read it. This is what makes the limits real.
 *
 * A failed poll leaves the last good read on screen — blanking the numbers on
 * one flaky RPC call would be worse — but it must NOT leave the screen implying
 * those numbers are current. `chainAt` only advances on a read that completed,
 * and the screens render their own age from it.
 */
async function refreshMandate() {
  try {
    const fresh = await monitorData();
    // A delegate arriving by link needs the mandate's own market list, not the
    // draft one, or the allowed/not-allowed line would be a guess. If any check
    // fails the whole set is unknown: half a set silently keeps the optimistic
    // draft, which would print "allowed" for a market the mandate excludes.
    if (fresh && state.markets.length > 0) {
      const allowed = new Set<string>();
      for (const m of state.markets) {
        const ok = (await pub.readContract({
          address: REGISTRY as Address, abi: registryAbi, functionName: "allowedMarket",
          args: [state.mandateId!, m.marketId],
        })) as boolean;
        if (ok) allowed.add(m.marketId as string);
      }
      state.allowed = allowed;
      state.allowedKnown = true;
    }
    monitor = fresh;
    set({ chainAt: Date.now() });
  } catch {
    // Nothing is asserted about the figures already on screen. They age, and
    // the screens say so.
    set({});
  }
}

// ---- wiring --------------------------------------------------------------

$("tab-delegator").addEventListener("click", () =>
  set({ role: "delegator" as Role, screen: "connect", error: "" }));
$("tab-delegate").addEventListener("click", () =>
  set({ role: "delegate" as Role, screen: "trade", error: "" }));
$("chip").addEventListener("click", async () => {
  try { await addNetwork(); set({ onChain: await onRightChain() }); }
  catch { /* wallet refused; the chip simply stays as it was */ }
});

async function boot() {
  render();
  try { state.onChain = await onRightChain(); } catch { /* no wallet yet */ }
  render();
  await loadMarkets();
  if (state.mandateId) await refreshMandate();
  setInterval(() => { if (state.mandateId) void refreshMandate(); }, 8000);
}

void boot();
