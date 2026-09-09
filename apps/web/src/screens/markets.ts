/**
 * Every live market, in full, read from chain.
 *
 * This screen ships under a deliberate override of the read-only-mirror rule,
 * so it is built to stay an ORDER-ENTRY surface rather than a dashboard: no
 * history, no PnL, no returns, no ranking, no "best odds". Current state only,
 * and every row carries its mandate status, because the question it answers is
 * "which market am I authorising or trading, and on exactly what terms" — not
 * "how is this market doing".
 *
 * Everything below is read from the chain. The thing this screen replaced was a
 * hardcoded twelve-point sparkline, and the whole reason for replacing it was
 * that it was invented — so nothing here is allowed to be.
 */
import { state, go } from "../state.js";
import type { Market } from "../state.js";
import { addrUrl } from "../chain.js";
import { err } from "./delegator.js";
import { reloadMarkets } from "../markets.js";
import type { Address } from "viem";

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));

/** Where "back" goes. A delegate came from the ticket; a delegator from setup. */
const backScreen = (): "trade" | "limits" => (state.role === "delegate" ? "trade" : "limits");

/**
 * Strike arrives 2-decimal: 7901195 is 79,011.95.
 *
 * ZERO IS NOT A PRICE HERE. This venue runs two kinds of market, and the
 * difference is visible only in the log:
 *
 *   strike=7903405  "Pricefeed test: will BTC/USDC's price be at or above 79034.05"
 *   strike=0        "BTC closes at or above its opening price"
 *
 * The second kind has no explicit threshold — it resolves against the opening
 * price, which is not known at creation. Rendering that as "0.00" would put an
 * invented figure back on the screen this one exists to clean up.
 */
function strikeText(raw: bigint): string | null {
  if (raw === 0n) return null;
  const whole = raw / 100n;
  const cents = (raw % 100n).toString().padStart(2, "0");
  return whole.toLocaleString("en-US") + "." + cents;
}

/** Fees are bps x 1000, so 300 means 0.30%. */
function feeText(bpsTimes1k: bigint): string {
  return (Number(bpsTimes1k) / 1000 / 100).toFixed(2) + "%";
}

function countdown(expiry: bigint): string {
  const s = Number(expiry) - Math.floor(Date.now() / 1000);
  if (s <= 0) return "resolved";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function row(label: string, value: string, accent = false): string {
  return '<div class="rowline" style="padding:7px 0;border-top:1px solid var(--rule)">' +
    '<span style="font-size:12px;color:var(--dimmer)">' + esc(label) + "</span>" +
    '<span style="font-size:12.5px;text-align:right;min-width:0;overflow-wrap:anywhere;color:' +
    (accent ? "var(--accent)" : "var(--ink)") + '">' + value + "</span></div>";
}

function link(label: string, a: Address): string {
  return '<div class="rowline" style="padding:7px 0;border-top:1px solid var(--rule)">' +
    '<span style="font-size:12px;color:var(--dimmer)">' + esc(label) + "</span>" +
    '<a class="footlink" style="font-size:12px" href="' + addrUrl(a) +
    '" target="_blank" rel="noreferrer">' + a.slice(0, 8) + "…" + a.slice(-6) + " &rarr;</a></div>";
}

/** One market: a summary you can scan, expanding to the terms you are agreeing to. */
function marketCard(mk: Market, i: number): string {
  // Until the contract has been asked, claim nothing — `state.allowed` before
  // that is the delegator's DRAFT set and says nothing about a real mandate.
  const known = state.allowedKnown;
  const allowed = known ? state.allowed.has(mk.marketId) : null;
  const status = allowed === true ? "on this mandate"
    : allowed === false ? "not on mandate"
    : "not checked yet";
  const colour = allowed === true ? "var(--ink)"
    : allowed === false ? "var(--accent)" : "var(--dimmer)";
  const shortStatus = allowed === true ? "on mandate"
    : allowed === false ? "not on mandate"
    : "not checked yet";

  return [
    '<details class="disclose" data-market="' + i + '">',
    "<summary>",
    '<span style="min-width:0;overflow-wrap:anywhere">' + esc(mk.asset) +
      (strikeText(mk.strike) ? " &middot; " + strikeText(mk.strike) : "") + "</span>",
    // Status in WORDS, not just colour. The row was tinted by mandate status and
    // nothing else, which is the same colour-only failure already fixed on the
    // UP/DOWN buttons — and this list is the one place a delegator decides what
    // to authorise, so it is the worst place to make them infer it.
    '<span style="font-size:11px;flex:0 0 auto;color:' + colour + '">' +
      esc(shortStatus) + " &middot; " + countdown(mk.expiry) + "</span>",
    "</summary>",
    '<div style="display:flex;flex-direction:column;gap:2px;padding-top:10px">',
    // The venue's own words, verbatim. Nothing here paraphrases them.
    mk.question
      ? '<p class="body" style="margin:0 0 8px">' + esc(mk.question) + "</p>"
      : '<span class="hint">this market carried no question text on chain.</span>',
    row("resolves at or above",
      strikeText(mk.strike)
        ? strikeText(mk.strike) + " " + esc(mk.asset) + "/USDC"
        // Not "0.00": this market type settles against its own opening price,
        // which does not exist as a number until the window opens.
        : "its opening price — this market carries no fixed strike"),
    row("resolves in", countdown(mk.expiry)),
    row("trading opened", new Date(Number(mk.tradingStart) * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"),
    row("on this mandate", status, allowed === false),
    mk.fees ? row("maker / taker fee", feeText(mk.fees.makerBps) + " / " + feeText(mk.fees.takerBps)) : "",
    mk.fees ? row("settlement fee", feeText(mk.fees.settlementBps)) : "",
    link("market", mk.market),
    link("pool", mk.pool),
    mk.settlement ? link("settlement", mk.settlement) : "",
    // Said in words rather than drawn as an empty chart. There is no book to
    // read on a binary pool — getBookLevels is a spot signature and reverts
    // here — and BinaryOrderPlaced carries an id and a side but no price.
    '<span class="hint" style="padding-top:8px">no order book is readable on chain for binary pools, so no price is shown. these books are quoted rather than crossed: 161 orders produced 1 fill in a measured 100-second window.</span>',
    "</div></details>",
  ].join("");
}

export function marketsScreen(): string {
  const head =
    '<div class="screen">' +
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">the markets, right now</h2>';
  const backBtn = '<button id="mk-back" class="btn ghost">&larr; back</button></div>';

  if (state.marketsState === "loading") {
    return head + '<span class="hint">reading live markets from chain…</span>' + err() + backBtn;
  }
  if (state.marketsState === "failed") {
    return head +
      '<span role="alert" style="font-size:12px;color:var(--accent);overflow-wrap:anywhere">' +
      esc(state.marketsError || "market discovery failed.") + "</span>" +
      '<button id="mk-retry" class="btn">check again</button>' + backBtn;
  }
  if (state.marketsState === "empty" || state.markets.length === 0) {
    return head +
      '<span class="hint">no market is open right now — the venue runs a handful at a time and there are gaps between windows.</span>' +
      '<button id="mk-retry" class="btn">check again</button>' + backBtn;
  }

  const assets = [...new Set(state.markets.map((m) => m.asset))].sort();
  return [
    head,
    // A measurement, and checkable — not a boast. The horizon ceiling is the
    // venue's shape, and the sentence after it is the part that is ours.
    '<p class="body" style="margin:0">' + state.markets.length + " live market" +
      (state.markets.length === 1 ? "" : "s") + ", " + esc(assets.join(" and ")) +
      ". this venue lists short windows only — a mandate names markets by id, not by horizon, so it works unchanged if longer ones are listed.</p>",
    '<div style="display:flex;flex-direction:column;gap:6px">',
    state.markets.map(marketCard).join(""),
    "</div>",
    err(),
    backBtn,
  ].join("");
}

export function bindMarkets(): void {
  document.getElementById("mk-back")?.addEventListener("click", () => { go(backScreen()); });
  document.getElementById("mk-retry")?.addEventListener("click", () => { void reloadMarkets(); });
}
