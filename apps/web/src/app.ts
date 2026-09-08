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
  erc20Abi, COLLATERAL, addrUrl, fmt, errName, restoreAccount, watchWallet,
} from "./chain.js";
import { findMandate } from "./resume.js";
import {
  setupScreen, bindSetup, limitsScreen, bindLimits, reviewScreen, bindReview,
  issueScreen, bindIssue, manageScreen, bindManage, monitorData, paintResumeOffer,
  type MonitorData,
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

/**
 * Resume once per account, whenever we learn who they are.
 *
 * boot() covers the already-authorized case, but someone who reloads and THEN
 * presses connect learns their account after boot has finished. Without this
 * they sit on step 1 with a delegation they cannot reach — the original bug,
 * one click later.
 */
let resumedFor: string | null = null;
subscribe(() => {
  const a = state.account;
  if (!a || state.mandateId || resumedFor === a.toLowerCase()) return;
  resumedFor = a.toLowerCase();
  void resumeMandate(false);
});

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
/** Counts polls, so the allowed-market re-read can run at a lower rate. */
let allowedTick = 0;
/** Forces the next poll to re-read the allowed set. */
export function invalidateAllowed(): void { allowedTick = 0; state.allowedKnown = false; }
let generation = 0;
async function refreshMandate(force = false) {
  // `force` is for identity changes: a poll already in flight is reading on
  // behalf of the PREVIOUS account, so waiting for it is waiting for an answer
  // to the wrong question.
  if ((inFlight && !force) || !state.mandateId) return;
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
    // The allowed set changes only when the delegator calls setMarkets, but this
    // re-read it for EVERY live market on EVERY 8-second poll — around sixty
    // requests a minute times eight, against a public RPC. Chatty enough to be
    // a demo risk in its own right (build spec §10). Re-read every fifth poll,
    // and immediately whenever something in this tab could have changed it.
    const dueForAllowed = allowedTick % 5 === 0 || !state.allowedKnown;
    allowedTick++;
    if (fresh && state.markets.length > 0 && dueForAllowed) {
      const allowed = new Set<string>();
      let checked = 0;
      // In parallel. Sequentially this was one round trip per live market -
      // around sixty - so the allowed set landed tens of seconds after the
      // mandate figures it belongs with.
      const results = await Promise.all(state.markets.map(async (m) => {
        try {
          const ok = (await pub.readContract({
            address: REGISTRY as Address, abi: registryAbi, functionName: "allowedMarket",
            args: [state.mandateId!, m.marketId],
          })) as boolean;
          return { id: m.marketId as string, ok };
        } catch {
          return null; // counted by omission
        }
      }));
      for (const r of results) {
        if (!r) continue;
        checked++;
        if (r.ok) allowed.add(r.id);
      }
      if (gen !== generation) return;
      state.allowed = allowed;
      state.allowedKnown = checked === state.markets.length;

      // Land on something tradable. activeMarket defaults to 0, which is
      // whichever market the venue happened to create most recently and has no
      // relationship to this mandate - so the delegate's first order was
      // refused MarketNotAllowed by default.
      if (state.allowedKnown && allowed.size > 0) {
        const current = state.markets[state.activeMarket];
        if (!current || !allowed.has(current.marketId as string)) {
          const i = state.markets.findIndex((m) => allowed.has(m.marketId as string));
          if (i >= 0) state.activeMarket = i;
        }
      }
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

/**
 * Put the mandate in the URL once we know it.
 *
 * replaceState rather than pushState: this is the same place, described more
 * precisely. It should not cost the user a press of the back button, and it
 * makes the next reload instant rather than another backward scan.
 */
function stampUrl(id: bigint) {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get("m") === String(id)) return;
    u.searchParams.set("m", String(id));
    history.replaceState(null, "", u.toString());
  } catch { /* a URL we cannot rewrite is cosmetic, not fatal. */ }
}

/**
 * Reopen the delegation this account already has.
 *
 * Only when the URL did not name one: an explicit `?m=` is the user telling us
 * which mandate they mean, and must always win over anything we infer.
 */
async function resumeMandate(navigate: boolean) {
  if (state.mandateId || state.mandateParamError || !state.account) return;
  const found = await findMandate(state.account, state.role);
  if (!found) return;
  if (!navigate) {
    // Deliberately NOT set(): a re-render here replaces the screen while the
    // user is mid-click. Write the field and paint the one node that changed.
    state.resumeOffer = found;
    paintResumeOffer();
    return;
  }
  stampUrl(found);
  set({
    mandateId: found,
    resumeOffer: null,
    screen: state.role === "delegate" ? "trade" : "manage",
  });
  await refreshMandate();
}

/** Take up the offer. Bound where the offer renders. */
export async function openResume(): Promise<void> {
  const id = state.resumeOffer;
  if (!id) return;
  stampUrl(id);
  set({
    mandateId: id,
    resumeOffer: null,
    screen: state.role === "delegate" ? "trade" : "manage",
  });
  await refreshMandate();
}

/**
 * The wallet switched account (or chain) underneath the page.
 *
 * Re-derive everything that depended on WHO we are. The mandate id itself is
 * kept when the URL named it - a link identifies a mandate, not a person - but
 * anything read on that account's behalf is dropped and re-read, because
 * showing the previous account's answers under a new address is exactly the
 * kind of stale claim this app is not allowed to make.
 */
async function onWalletSwitch(next: Address | null) {
  if ((state.account ?? null) === next) return;
  state.account = next;
  state.resumeOffer = null;
  resumedFor = null;
  state.allowed = new Set();
  state.allowedKnown = false;
  state.chainAt = 0;
  monitor = null;
  try { state.onChain = await onRightChain(); } catch { state.onChain = false; }
  set({ error: "", notice: "", busy: false });
  if (state.mandateId) await refreshMandate(true);
  else if (next) await resumeMandate(state.role === "delegate");
  set({}); // repaint even if the read found nothing new to say
}

async function boot() {
  render();
  // FIRST, before any network await. This sat after reloadMarkets() and
  // refreshMandate(), so a single slow contract read left the app permanently
  // deaf to the user switching accounts - which is the whole bug it fixes.
  // Registering a listener must never be behind a request.
  watchWallet({
    accounts: (accts) => { void onWalletSwitch(accts[0] ?? null); },
    chain: () => {
      void (async () => {
        try { set({ onChain: await onRightChain() }); } catch { set({ onChain: false }); }
      })();
    },
  });
  try { state.onChain = await onRightChain(); } catch { /* no wallet yet */ }
  // Who we already have permission to see. Silent — never prompts.
  let restored: Address | null = null;
  try {
    restored = await restoreAccount();
    if (restored) state.account = restored;
  } catch { /* no wallet yet */ }
  render();
  void renderContext();
  await reloadMarkets();
  if (state.mandateId) await refreshMandate();
  // Only navigate for an account we already had when the page opened. boot()
  // awaits market discovery first, so by the time this line runs the user may
  // have pressed connect - and auto-opening their old delegation then throws
  // them out of the setup they just started. An account acquired by connecting
  // is handled by the subscriber below, which offers instead.
  else if (restored) void resumeMandate(true);
  setInterval(() => { if (state.mandateId) void refreshMandate(); }, 8000);
  setInterval(() => { void renderContext(); }, 30000);
}

void boot();
