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
  pub, wallet, connect, addNetwork, onRightChain, registryAbi,
  REGISTRY, txUrl, fmt, errName,
} from "../chain.js";
import { state, set } from "../state.js";
import type { MonitorData } from "./delegator.js";
import type { Address, Hex } from "viem";

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
const err = () =>
  state.error ? '<span style="font-size:12px;color:var(--accent)">' + esc(state.error) + "</span>" : "";

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

function envelope(d: MonitorData | null): string {
  if (!d) return '<div class="sep"><span class="hint">reading the mandate…</span></div>';
  const cap = d.m[3];
  const used = d.m[4];
  const perTrade = d.m[2];
  const expiry = d.m[5];
  const revoked = d.m[6];
  const live = !revoked && BigInt(Math.floor(Date.now() / 1000)) < expiry;
  const pct = cap === 0n ? 0 : Number((d.remaining * 100n) / cap);
  return [
    '<div style="display:flex;flex-direction:column;gap:8px">',
    '<div class="rowline"><span style="font-size:12px;color:var(--dimmer)">you may still spend</span>',
    '<span style="font-size:22px;letter-spacing:-0.03em;color:' + (live ? "var(--ink)" : "var(--accent)") + '">' +
      fmt(d.remaining) + "</span></div>",
    '<div class="meter"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>',
    '<span class="hint">' + fmt(used) + " of " + fmt(cap) + " used · max " + fmt(perTrade) +
      " per order · " + (live ? "live" : revoked ? "revoked" : "expired") + "</span>",
    "</div>",
  ].join("");
}

// ---- 01 place order ------------------------------------------------------

export function tradeScreen(d: MonitorData | null): string {
  const mk = state.markets[state.activeMarket];
  const sideBtn = (k: "up" | "down", label: string, color: string) =>
    '<button data-side="' + k + '" class="side btn" style="background:' +
    (state.side === k ? color : "none") + ";color:" + (state.side === k ? "#0f0f0f" : "var(--dim)") +
    ";border:1px solid " + (state.side === k ? color : "var(--rule2)") + '">' + label + "</button>";

  return [
    '<div class="screen">',
    '<span class="eyebrow">01 / place_order</span>',
    envelope(d),
    '<div class="sep" style="display:flex;flex-direction:column;gap:9px">',
    '<span class="eyebrow" style="letter-spacing:0.12em">market</span>',
    '<span style="font-size:13px;line-height:1.5">' + (mk ? esc(mk.label) : "no market selected") + "</span>",
    mk ? '<button id="t-detail" class="btn ghost">market_detail &rarr;</button>' : "",
    "</div>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px">',
    '<span class="eyebrow" style="letter-spacing:0.12em">side</span>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">',
    sideBtn("up", "UP", "#2ea043"),
    sideBtn("down", "DOWN", "var(--accent)"),
    "</div></div>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px">',
    '<div class="rowline"><span style="font-size:13px">size</span><span style="font-size:19px;letter-spacing:-0.03em">' + state.size + "</span></div>",
    '<input id="t-size" type="range" min="1" max="200" step="1" value="' + state.size + '" style="width:100%" />',
    '<span class="hint">checked against the per-order cap before anything is pulled.</span>',
    "</div>",
    err(),
    '<button id="t-place" class="btn accent"' + (state.busy || !mk ? " disabled" : "") + ">" +
      (state.busy ? "placing…" : "place order") + "</button>",
    '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' +
      state.log.map((l) => '<div style="padding:6px 0;border-top:1px solid var(--rule)">' + l.html + "</div>").join("") +
      "</div>",
    "</div>",
  ].join("");
}

export function bindTrade(): void {
  document.querySelectorAll<HTMLButtonElement>(".side").forEach((b) => {
    b.addEventListener("click", () => set({ side: b.dataset.side as "up" | "down" }));
  });
  const sz = document.getElementById("t-size") as HTMLInputElement | null;
  sz?.addEventListener("input", () => set({ size: Number(sz.value) }));
  document.getElementById("t-detail")?.addEventListener("click", () => set({ screen: "market" }));

  document.getElementById("t-place")?.addEventListener("click", async () => {
    const mk = state.markets[state.activeMarket];
    if (!state.account || !mk || !state.mandateId) {
      set({ error: "connect, and open a mandate link first" });
      return;
    }
    set({ busy: true, error: "" });
    try {
      if (!(await onRightChain())) await addNetwork();

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
      await pub.simulateContract({
        account: state.account, address: REGISTRY as Address, abi: registryAbi,
        functionName: "placeForDelegator", args: args as never,
      });

      const hash = await wallet(state.account).writeContract({
        address: REGISTRY as Address, abi: registryAbi,
        functionName: "placeForDelegator", args: args as never,
      });
      state.log.unshift({
        html: state.side.toUpperCase() + ' sent · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      set({});
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

// ---- 02 market detail ----------------------------------------------------

/**
 * Decorative price line, shipped under the read-only-mirror override. It is
 * labelled as indicative so nothing here can be mistaken for a mandate figure.
 */
function spark(): string {
  const pr = [118, 110, 124, 96, 88, 104, 72, 78, 60, 66, 48, 40];
  const pts = pr.map((y, i) => (i * 320) / (pr.length - 1) + "," + y).join(" ");
  return [
    '<svg viewBox="0 0 320 130" preserveAspectRatio="none" style="width:100%;height:110px;display:block">',
    '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.5" />',
    "</svg>",
  ].join("");
}

export function marketScreen(d: MonitorData | null): string {
  const mk = state.markets[state.activeMarket];
  if (!mk) return '<div class="screen"><span class="eyebrow">02 / market_detail</span><p class="hint">no market selected.</p></div>';
  const secs = Number(mk.expiry) - Math.floor(Date.now() / 1000);
  const allowed = state.allowed.has(mk.marketId);
  return [
    '<div class="screen">',
    '<span class="eyebrow">02 / market_detail</span>',
    '<h2 style="margin:0;font-size:17px;line-height:1.35;font-weight:500;letter-spacing:-0.03em">' + esc(mk.label) + "</h2>",
    spark(),
    '<span class="hint">indicative price line — not a mandate figure and not read from chain.</span>',
    '<div style="display:flex;flex-direction:column">',
    '<div class="rowline" style="padding:8px 0;border-top:1px solid var(--rule)"><span style="font-size:12px;color:var(--dimmer)">resolves</span><span style="font-size:12.5px">' +
      (secs > 0 ? Math.floor(secs / 60) + "m" : "resolved") + "</span></div>",
    '<div class="rowline" style="padding:8px 0;border-top:1px solid var(--rule)"><span style="font-size:12px;color:var(--dimmer)">on_delegator_list</span><span style="font-size:12.5px;color:' +
      (allowed ? "var(--ink)" : "var(--accent)") + '">' + (allowed ? "allowed" : "not allowed") + "</span></div>",
    "</div>",
    envelope(d),
    '<button id="m-back" class="btn ghost">&larr; place_order</button>',
    "</div>",
  ].join("");
}

export function bindMarket(): void {
  document.getElementById("m-back")?.addEventListener("click", () => set({ screen: "trade" }));
}

// ---- 03 open positions ---------------------------------------------------

export function positionsScreen(d: MonitorData | null): string {
  const delegator = d ? d.m[0] : null;
  return [
    '<div class="screen">',
    '<span class="eyebrow">03 / open_positions</span>',
    '<h2 style="margin:0;font-size:18px;line-height:1.3;font-weight:500;letter-spacing:-0.04em">positions / settle to delegator</h2>',
    '<p class="body" style="margin:0">you place these. they are not yours. every payout settles to' +
      (delegator ? " " + delegator.slice(0, 6) + "…" + delegator.slice(-4) : " the delegator") +
      ", and the registry keeps nothing that is not owed to a named party.</p>",
    state.log.length === 0
      ? '<span class="hint">no orders placed from this browser yet.</span>'
      : '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' +
        state.log.map((l) => '<div style="padding:7px 0;border-top:1px solid var(--rule)">' + l.html + "</div>").join("") +
        "</div>",
    envelope(d),
    "</div>",
  ].join("");
}
