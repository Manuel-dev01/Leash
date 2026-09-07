/**
 * App shell: rail, screen dispatch, and the desktop context column.
 *
 * Markets come from CHAIN, never from the indexer. The indexer went down
 * mid-build and every SDK discovery path goes through it, so an outage during
 * the demo would mean no markets and no order. `discoverMarkets` reads
 * MarketCreated straight from the module singleton instead.
 */
import {
  state, set, go, subscribe, SETUP_STEPS, HOME, stepOf,
  type Role, type Screen,
} from "./state.js";
import {
  addNetwork, onRightChain, REGISTRY, HANDLER, pub, registryAbi, handlerAbi,
  erc20Abi, COLLATERAL, addrUrl, fmt, errName,
} from "./chain.js";
import {
  setupScreen, bindSetup, limitsScreen, bindLimits, reviewScreen, bindReview,
  issueScreen, bindIssue, manageScreen, bindManage, monitorData, type MonitorData,
} from "./screens/delegator.js";
import { tradeScreen, bindTrade } from "./screens/delegate.js";
import { reloadMarkets } from "./markets.js";
import type { Address } from "viem";
import "./design.css";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
let monitor: MonitorData | null = null;

// ---- boot params ---------------------------------------------------------

const q = new URLSearchParams(location.search);
if (q.get("role") === "delegate") {
  state.role = "delegate";
  state.screen = "trade";
}

/**
 * `?m=` is user-supplied and arrives by QR, chat message and hand-typing.
 *
 * A bare `BigInt(param)` here threw at module scope, which stopped the whole
 * script before `boot()` ran: the static shell still painted, so the app looked
 * loaded while every control was dead. Validate, and say what is wrong.
 */
const mParam = q.get("m");
if (mParam !== null) {
  if (/^\d+$/.test(mParam.trim())) {
    state.mandateId = BigInt(mParam.trim());
    // A link that carries a mandate should open ON that mandate. Landing on
    // step 1 of setup and asking someone to walk a wizard they have already
    // completed is how a returning delegator concludes nothing was saved.
    if (state.role === "delegator") state.screen = "manage";
  } else {
    state.mandateParamError =
      `the link carries an unreadable mandate id ("${mParam.slice(0, 24)}"). ask for the link again.`;
  }
}

// ---- render --------------------------------------------------------------

/**
 * Where you are, in one line.
 *
 * During setup this is a step counter and a bar; afterwards there is nothing to
 * count, so it becomes the name of the surface you are on. The seven-row nav
 * this replaces promised free navigation over steps that have hard dependencies
 * — you could open "issue" before a mandate existed and be told there was
 * nothing to hand over.
 */
function renderProgress() {
  const step = stepOf(state.screen);
  const el = $("progress");
  if (state.role === "delegate") { el.innerHTML = ""; return; }

  if (!step) {
    el.innerHTML =
      '<div class="progress-head"><span>your delegation</span>' +
      (state.mandateId ? "<span>#" + String(state.mandateId) + "</span>" : "") +
      "</div>";
    return;
  }
  const bars = SETUP_STEPS.map((_, i) =>
    '<i class="' + (i + 1 < step.index ? "done" : i + 1 === step.index ? "now" : "") + '"></i>').join("");
  const back = step.index > 1
    ? '<button class="backlink" id="p-back">&larr; back</button>'
    : "<span></span>";
  el.innerHTML =
    '<div class="progress-head">' + back +
    "<span>step " + step.index + " of " + step.total + " · " + step.label + "</span></div>" +
    '<div class="progress-bar">' + bars + "</div>";
  document.getElementById("p-back")?.addEventListener("click", () => {
    const prev = SETUP_STEPS[step.index - 2];
    if (prev) go(prev.screen);
  });
}

function renderChrome() {
  $("tab-delegator").className = state.role === "delegator" ? "on" : "";
  $("tab-delegate").className = state.role === "delegate" ? "on" : "";
  $("tab-delegator").setAttribute("aria-pressed", String(state.role === "delegator"));
  $("tab-delegate").setAttribute("aria-pressed", String(state.role === "delegate"));
  $("netline").textContent = state.onChain ? "chain 50312 · ready" : "chain 50312";
  $("chip").textContent = state.onChain ? "network ready" : "add somnia 50312";
  $("chip").className = "chip" + (state.onChain ? " on" : "");
  renderProgress();
}

function renderScreen() {
  const s = state.screen;
  const html =
    s === "setup" ? setupScreen()
    : s === "limits" ? limitsScreen()
    : s === "review" ? reviewScreen()
    : s === "issue" ? issueScreen()
    : s === "manage" ? manageScreen(monitor)
    : tradeScreen(monitor);
  $("screen").innerHTML = html;

  if (s === "setup") bindSetup();
  else if (s === "limits") bindLimits();
  else if (s === "review") bindReview();
  else if (s === "issue") bindIssue();
  else if (s === "manage") bindManage();
  else bindTrade();
}

function render() {
  renderChrome();
  renderScreen();
}
subscribe(render);

// ---- chain-side loading --------------------------------------------------

/**
 * Live markets, from chain.
 *
 * Sets an explicit outcome rather than leaving an empty array behind: a
 * degraded RPC, a quiet venue and a request in flight are three different
 * things and the user is told which one they are looking at.
 */
/**
 * Re-read the mandate.
 *
 * Guarded and generation-stamped. Without the guard, a poll slower than the
 * interval started another one on top; without the generation counter a
 * straggler could land after a newer read and overwrite it. Both mattered
 * because the third thing they touch is `chainAt`, which is what the screens
 * use to tell the reader how old the figures are.
 */
let inFlight = false;
let generation = 0;
async function refreshMandate() {
  if (inFlight || !state.mandateId) return;
  inFlight = true;
  const gen = ++generation;
  // Stamped from when the read STARTED. Stamping completion let a response 40
  // seconds in flight report itself as zero seconds old, which is precisely the
  // claim the freshness line exists to avoid making.
  const startedAt = Date.now();
  try {
    const fresh = await monitorData();
    if (gen !== generation) return; // a newer read already landed

    // Checked per market so one failing read cannot discard the rest. The
    // whole set used to be abandoned — along with mandate figures that had
    // already arrived — because of a single unrelated boolean.
    if (fresh && state.markets.length > 0) {
      const allowed = new Set<string>();
      let checked = 0;
      for (const m of state.markets) {
        try {
          const ok = (await pub.readContract({
            address: REGISTRY as Address, abi: registryAbi, functionName: "allowedMarket",
            args: [state.mandateId!, m.marketId],
          })) as boolean;
          checked++;
          if (ok) allowed.add(m.marketId as string);
        } catch { /* counted by omission below */ }
      }
      if (gen !== generation) return;
      state.allowed = allowed;
      state.allowedKnown = checked === state.markets.length;
    }
    if (fresh) monitor = fresh;
    set({ chainAt: fresh ? startedAt : state.chainAt });
  } catch {
    // Deliberately no error banner: the figures already on screen stay, and the
    // screens render their own age from `chainAt`, which did not advance.
    set({});
  } finally {
    if (gen === generation) inFlight = false;
  }
}

// ---- the desktop context column ------------------------------------------

/**
 * Live registry state, shown beside the flow on wide screens.
 *
 * Strictly OUR contract's state and OUR events. No prices, no PnL, no market
 * analytics — that is the read-only-mirror pattern the project rules out, and
 * widening the layout is not a licence to widen the product.
 */
async function renderContext() {
  const el = document.getElementById("context");
  if (!el) return;
  const row = (k: string, v: string, accent = false) =>
    `<div class="ctxrow"><span>${k}</span><span${accent ? ' style="color:var(--accent)"' : ""}>${v}</span></div>`;
  try {
    const [clean, stray, held, cap, sub] = await Promise.all([
      pub.readContract({ address: REGISTRY as Address, abi: registryAbi, functionName: "holdsNoFunds" }) as Promise<boolean>,
      pub.readContract({ address: REGISTRY as Address, abi: registryAbi, functionName: "unattributed" }) as Promise<bigint>,
      pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [REGISTRY as Address] }) as Promise<bigint>,
      pub.readContract({ address: HANDLER as Address, abi: handlerAbi, functionName: "batchCap" }) as Promise<bigint>,
      pub.readContract({ address: HANDLER as Address, abi: handlerAbi, functionName: "subscriptionId" }) as Promise<bigint>,
    ]);
    el.innerHTML =
      '<span class="eyebrow">live from the deployed contracts</span>' +
      row("collateral_held", fmt(held) + " tUSDC") +
      row("unattributed", fmt(stray), stray !== 0n) +
      row("holds_no_funds", clean ? "true" : "FALSE", !clean) +
      row("batch_cap", String(cap)) +
      row("deadhand", sub === 0n ? "disarmed" : "armed #" + sub) +
      `<a class="ctxlink" href="${addrUrl(REGISTRY as Address)}" target="_blank" rel="noreferrer">registry ${REGISTRY.slice(0, 10)}… &rarr;</a>` +
      `<a class="ctxlink" href="${addrUrl(HANDLER as Address)}" target="_blank" rel="noreferrer">handler ${HANDLER.slice(0, 10)}… &rarr;</a>`;
  } catch {
    // Never a confident zero. An unreachable chain says so.
    el.innerHTML =
      '<span class="eyebrow">live from the deployed contracts</span>' +
      row("collateral_held", "—") +
      row("unattributed", "—") +
      row("holds_no_funds", "—") +
      '<span class="hint">chain unreachable — these are not zeros, they are unread.</span>';
  }
}

// ---- wiring --------------------------------------------------------------

$("tab-delegator").addEventListener("click", () => {
  state.role = "delegator" as Role;
  go(state.mandateId ? "manage" : HOME.delegator);
});
$("tab-delegate").addEventListener("click", () => {
  state.role = "delegate" as Role;
  go(HOME.delegate);
});
$("chip").addEventListener("click", async () => {
  try {
    await addNetwork();
    set({ onChain: await onRightChain(), error: "" });
  } catch (e) {
    // Used to be swallowed entirely, so tapping the header's only control did
    // nothing visible whatever went wrong.
    set({ error: errName(e) });
  }
});

async function boot() {
  render();
  try { state.onChain = await onRightChain(); } catch { /* no wallet yet */ }
  render();
  void renderContext();
  await reloadMarkets();
  if (state.mandateId) await refreshMandate();
  setInterval(() => { if (state.mandateId) void refreshMandate(); }, 8000);
  setInterval(() => { void renderContext(); }, 30000);
}

void boot();
