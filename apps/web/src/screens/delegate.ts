/**
 * Delegate screens: place_order, market_detail, open_positions.
 *
 * This is the surface that appears on camera repeatedly, so the bar is: see the
 * envelope, tap a side, get a tx hash. The limits sit ABOVE the ticket
 * permanently — the delegate cannot look at a market without seeing what they
 * are working inside.
 *
 * The chart on market_detail ships under an explicit override of the read-only
 * mirror rule. It is decorative and labelled as such; the allowed line and the
 * mandate figures beside it are read from the contract.
 */
import {
  pub, wallet, connect, addNetwork, onRightChain, registryAbi, REGISTRY,
  txUrl, fmt, errName,
} from "../chain.js";
import { state, set, staleness } from "../state.js";
import { err } from "./delegator.js";
import type { MonitorData } from "./delegator.js";
import type { Address, Hex } from "viem";

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));

/** UP is BUY_YES (0), DOWN is BUY_NO (2). `price` is always the YES-side price. */
const KIND = { up: 0, down: 2 } as const;

/**
 * The refusal a delegate actually sees, in the words that tell them what to do
 * next. Naming the specific limit is what separates a judge finishing the flow
 * from a judge closing the tab.
 */
function refusal(name: string): string {
  if (name === "ExceedsCumulative") return "refused — this would spend past the total budget.";
  if (name === "StakeExceedsPerTrade") return "refused — bigger than the per-order cap.";
  if (name === "MarketNotAllowed") return "refused — this market is not on the mandate.";
  if (name === "Revoked") return "the delegator ended this delegation.";
  if (name === "Expired") return "this delegation has expired.";
  if (name === "NotDelegate") return "this mandate is not for your wallet.";
  return name;
}

/**
 * The mandate envelope, or an honest account of why there isn't one.
 *
 * `reading the mandate…` used to sit here permanently for any delegate who
 * arrived without a link, because the read is gated on having a mandate id and
 * therefore never ran. It was the app's primary demo screen saying it was busy
 * while nothing was happening.
 */
function envelope(d: MonitorData | null): string {
  if (state.mandateParamError) {
    return '<div class="sep"><span role="alert" style="font-size:12px;color:var(--accent);overflow-wrap:anywhere">' +
      esc(state.mandateParamError) + "</span></div>";
  }
  if (!state.mandateId) {
    return [
      '<div class="sep" style="display:flex;flex-direction:column;gap:8px">',
      '<span style="font-size:13px">no mandate on this link.</span>',
      '<span class="hint">a delegate is invited. ask the delegator for their link — it ends in <code>?role=delegate&amp;m=…</code> and they can copy it or show you a code from their issue screen.</span>',
      "</div>",
    ].join("");
  }
  if (!d) {
    return '<div class="sep"><span class="hint">reading mandate #' + String(state.mandateId) + " from the contract…</span></div>";
  }
  const cap = d.m[3];
  const used = d.m[4];
  const perTrade = d.m[2];
  const expiry = d.m[5];
  const revoked = d.m[6];
  const live = !revoked && BigInt(Math.floor(Date.now() / 1000)) < expiry;
  const pct = cap === 0n ? 0 : Number((d.remaining * 100n) / cap);
  // A budget figure that quietly stopped updating is worse than no figure: the
  // delegate reads headroom that may already be spent.
  const f = staleness();
  return [
    '<div style="display:flex;flex-direction:column;gap:8px">',
    '<div class="rowline"><span style="font-size:12px;color:var(--dimmer)">you may still spend</span>',
    '<span style="font-size:22px;letter-spacing:-0.03em;color:' + (live ? "var(--ink)" : "var(--accent)") + '">' +
      fmt(d.remaining) + "</span></div>",
    '<div class="meter"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>',
    '<span class="hint">' + fmt(used) + " of " + fmt(cap) + " used · max " + fmt(perTrade) +
      " per order · " + (live ? "live" : revoked ? "revoked" : "expired") + "</span>",
    f.stale
      ? '<span class="hint" style="color:var(--accent)">chain not answering — this envelope is ' +
        (f.known ? f.ageS + "s old" : "unread") + ". the contract still enforces it; this screen may be behind.</span>"
      : "",
    "</div>",
  ].join("");
}

/** Markets the delegate can act on, with the same four honest outcomes. */
function marketPicker(): string {
  if (state.marketsState === "loading") return '<span class="hint">reading live markets from chain…</span>';
  if (state.marketsState === "failed") {
    return '<span role="alert" style="font-size:12px;color:var(--accent);overflow-wrap:anywhere">' +
      esc(state.marketsError || "market discovery failed.") + "</span>";
  }
  if (state.marketsState === "empty") {
    return '<span class="hint">no market is open right now — the venue runs six at a time and there are gaps between windows.</span>';
  }
  return state.markets
    .map((mk, i) => {
      const on = i === state.activeMarket;
      return [
        '<button data-pick="' + i + '" class="mk" aria-pressed="' + on + '">',
        '<span style="line-height:1.5;min-width:0;overflow-wrap:anywhere;flex:1 1 auto">' + esc(mk.label) + "</span>",
        '<span style="font-size:11px;flex:0 0 auto;color:' + (on ? "var(--accent)" : "var(--dimmer)") + '">' + (on ? "trading" : "pick") + "</span>",
        "</button>",
      ].join("");
    })
    .join("");
}

// ---- 01 place order ------------------------------------------------------

export function tradeScreen(d: MonitorData | null): string {
  const mk = state.markets[state.activeMarket];
  const sideBtn = (k: "up" | "down", label: string, color: string) =>
    '<button data-side="' + k + '" class="side btn" aria-pressed="' + (state.side === k) + '" style="background:' +
    (state.side === k ? color : "none") + ";color:" + (state.side === k ? "#0f0f0f" : "var(--dim)") +
    ";border:1px solid " + (state.side === k ? color : "var(--rule2)") + '">' + label +
    (state.side === k ? " ✓" : "") + "</button>";

  return [
    '<div class="screen">',
    // No step number. The delegate has ONE screen, and "01 /" implied an 02
    // they would never reach — the same numbered-nav tic that was cut from the
    // delegator flow.
    '<span class="eyebrow">place an order</span>',
    envelope(d),
    // The delegate's role has no connect screen — their nav is only the three
    // trading screens — so without this the wallet could ONLY be connected from
    // the delegator tab. A delegate arriving by link hit "connect your wallet"
    // with no button anywhere that did it.
    !state.account
      ? '<div class="sep" style="display:flex;flex-direction:column;gap:7px">' +
        '<span class="eyebrow" style="letter-spacing:0.12em">your wallet</span>' +
        '<button id="t-connect" class="btn"' + (state.busy ? " disabled" : "") + ">" +
        (state.busy ? "waiting for your wallet…" : "connect wallet") + "</button>" +
        '<span class="hint">you sign your own orders. the delegator never sees your key, and you never see theirs.</span>' +
        "</div>"
      : '<div class="sep rowline"><span style="font-size:12px;color:var(--dimmer)">trading as</span>' +
        '<span style="font-size:12.5px">' + state.account.slice(0, 6) + "…" + state.account.slice(-4) + "</span></div>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:9px;min-width:0">',
    '<span class="eyebrow" style="letter-spacing:0.12em">market</span>',
    '<div style="display:flex;flex-direction:column;gap:5px;min-width:0">' + marketPicker() + "</div>",
    "</div>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px">',
    '<span class="eyebrow" style="letter-spacing:0.12em" id="side-label">side</span>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" role="group" aria-labelledby="side-label">',
    sideBtn("up", "UP", "#2ea043"),
    sideBtn("down", "DOWN", "var(--accent)"),
    "</div></div>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px;min-width:0">',
    '<div class="rowline"><label for="t-size" style="font-size:13px">size</label>',
    '<span id="t-size-out" style="font-size:19px;letter-spacing:-0.03em">' + state.size + "</span></div>",
    '<input id="t-size" type="range" min="1" max="200" step="1" value="' + state.size +
      '" style="width:100%" aria-valuetext="' + state.size + ' units" aria-describedby="t-size-note" />',
    '<span class="hint" id="t-size-note">checked against the per-order cap before anything is pulled.</span>',
    "</div>",
    err(),
    '<button id="t-place" class="btn accent"' + (state.busy || !mk || !state.mandateId || !state.account ? " disabled" : "") + ">" +
      (state.busy ? "placing…" : "place order") + "</button>",
    marketDetail(),
    ordersDetail(d),
    "</div>",
  ].join("");
}

export function bindTrade(): void {
  document.getElementById("t-connect")?.addEventListener("click", async () => {
    set({ busy: true, error: "" });
    try {
      const a = await connect();
      if (!(await onRightChain())) await addNetwork();
      set({ account: a, onChain: await onRightChain(), busy: false, error: "" });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });
  document.querySelectorAll<HTMLButtonElement>(".side").forEach((b) => {
    b.addEventListener("click", () => set({ side: b.dataset.side as "up" | "down", error: "" }));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) => {
    b.addEventListener("click", () => set({ activeMarket: Number(b.dataset.pick), error: "" }));
  });

  // Updates the readout node, not the whole screen — a set() here destroyed the
  // range input mid-drag.
  const sz = document.getElementById("t-size") as HTMLInputElement | null;
  const out = document.getElementById("t-size-out");
  sz?.addEventListener("input", () => {
    state.size = Number(sz.value);
    if (out) out.textContent = sz.value;
    sz.setAttribute("aria-valuetext", `${sz.value} units`);
    // Clear a stale refusal directly: the user adjusting size is answering it,
    // and leaving "bigger than the per-order cap" on screen contradicts them.
    if (state.error) {
      state.error = "";
      document.querySelectorAll('[role="alert"]').forEach((n) => { n.textContent = ""; });
    }
  });

  document.getElementById("t-place")?.addEventListener("click", async () => {
    const mk = state.markets[state.activeMarket];
    if (!state.mandateId) { set({ error: "open the delegator's link first — it carries the mandate id" }); return; }
    if (!mk) { set({ error: "no market selected" }); return; }
    if (!state.account) { set({ error: "connect your wallet to place an order" }); return; }
    set({ busy: true, error: "" });
    const label = document.getElementById("t-place");
    try {
      if (!(await onRightChainSafe())) await ensureNetwork();

      // Price to the top of the range. A taker is charged the FILL price, not
      // the price it offered, so aggression costs nothing and removes the
      // stale-book failure mode that leaves an order resting instead of filled.
      const price = 990_000n;
      const qty = BigInt(state.size) * 1_000_000n;
      // Order expiry is capped at the market's own expiry; exceeding it reverts
      // OrderExpiryBeyondMarket.
      const expireNs = (mk.expiry - 5n) * 1_000_000_000n;
      const args = [state.mandateId, mk.marketId as Hex, mk.pool, KIND[state.side], price, qty, expireNs] as const;

      // Simulate first: placeBinaryOrder returns (success, id) and a false does
      // NOT revert, so a mined transaction can be a silent rejection.
      if (label) label.textContent = "checking against your limits…";
      await pub.simulateContract({
        account: state.account, address: REGISTRY as Address, abi: registryAbi,
        functionName: "placeForDelegator", args: args as never,
      });

      if (label) label.textContent = "sign in your wallet…";
      const hash = await wallet(state.account).writeContract({
        address: REGISTRY as Address, abi: registryAbi,
        functionName: "placeForDelegator", args: args as never,
      });
      state.log.unshift({
        html: state.side.toUpperCase() + ' sent · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      if (label) label.textContent = "waiting for confirmation…";
      const r = await pub.waitForTransactionReceipt({ hash });
      state.log.unshift({
        html: state.side.toUpperCase() + " <b>" + (r.status === "success" ? "placed" : "reverted") +
          '</b> · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: refusal(errName(e)) });
    }
  });
}

// Imported lazily to keep the wallet plumbing in one place.
async function onRightChainSafe(): Promise<boolean> {
  const { onRightChain } = await import("../chain.js");
  try { return await onRightChain(); } catch { return false; }
}
async function ensureNetwork(): Promise<void> {
  const { addNetwork } = await import("../chain.js");
  await addNetwork();
}

// ---- in-page detail ------------------------------------------------------
//
// Market detail and open positions were separate numbered screens, so a
// delegate had to navigate away from the ticket to see what they were about to
// trade and then navigate back. They are disclosures on the one screen now.

/**
 * Decorative price line, shipped under an explicit override of the
 * read-only-mirror rule. Labelled as indicative so nothing here can be mistaken
 * for a mandate figure.
 */
function spark(): string {
  const pr = [118, 110, 124, 96, 88, 104, 72, 78, 60, 66, 48, 40];
  const pts = pr.map((y, i) => (i * 320) / (pr.length - 1) + "," + y).join(" ");
  return [
    '<svg viewBox="0 0 320 130" preserveAspectRatio="none" style="width:100%;height:96px;display:block" aria-hidden="true">',
    '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.5" />',
    "</svg>",
  ].join("");
}

export function marketDetail(): string {
  const mk = state.markets[state.activeMarket];
  if (!mk) return "";
  const secs = Number(mk.expiry) - Math.floor(Date.now() / 1000);
  // Before the mandate has been checked on chain, `state.allowed` is the DRAFT
  // set, which would print "allowed" for a market the mandate excludes.
  const allowed = state.allowedKnown ? state.allowed.has(mk.marketId) : null;
  return [
    '<details class="disclose"><summary>about this market</summary>',
    '<div style="display:flex;flex-direction:column;gap:10px;padding-top:12px">',
    spark(),
    '<span class="hint">indicative price line — not a mandate figure and not read from chain.</span>',
    '<div class="rowline" style="padding:8px 0;border-top:1px solid var(--rule)"><span style="font-size:12px;color:var(--dimmer)">resolves</span><span style="font-size:12.5px">' +
      (secs > 0 ? Math.floor(secs / 60) + "m" : "resolved") + "</span></div>",
    '<div class="rowline" style="padding:8px 0;border-top:1px solid var(--rule)"><span style="font-size:12px;color:var(--dimmer)">on their allowed list</span><span style="font-size:12.5px;color:' +
      (allowed === true ? "var(--ink)" : allowed === false ? "var(--accent)" : "var(--dimmer)") + '">' +
      (allowed === true ? "allowed" : allowed === false ? "not allowed" : "not checked yet") + "</span></div>",
    "</div></details>",
  ].join("");
}

export function ordersDetail(d: MonitorData | null): string {
  const delegator = d ? d.m[0] : null;
  return [
    '<details class="disclose"><summary>your orders</summary>',
    '<div style="display:flex;flex-direction:column;gap:10px;padding-top:12px">',
    '<p class="body" style="margin:0">you place these. they are not yours. every payout settles to' +
      (delegator ? " " + delegator.slice(0, 6) + "…" + delegator.slice(-4) : " the delegator") +
      ", and the registry keeps nothing that is not owed to a named party.</p>",
    state.log.length === 0
      ? '<span class="hint">nothing placed from this browser yet.</span>'
      : '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' +
        state.log.map((l) => '<div style="padding:7px 0;border-top:1px solid var(--rule)">' + l.html + "</div>").join("") +
        "</div>",
    "</div></details>",
  ].join("");
}
