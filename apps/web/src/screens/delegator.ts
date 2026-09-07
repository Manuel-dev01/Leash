/**
 * Delegator screens: connect, pick, limits, review, issue, monitor, revoke.
 *
 * Every limit rendered here is READ FROM THE CONTRACT once a mandate exists.
 * The draft screens (02/03) show local state because the mandate does not exist
 * yet — but the moment it does, `monitor` reads the chain. That line is the one
 * the chart override does not get to cross: a chart may be decorative, nothing
 * that looks like a mandate limit may be.
 */
import {
  pub, wallet, connect, addNetwork, onRightChain, registryAbi, erc20Abi,
  REGISTRY, COLLATERAL, txUrl, fmt, errName,
} from "../chain.js";
import { state, set, go, staleness } from "../state.js";
import { qrSvg } from "../qr.js";
import { reloadMarkets } from "../markets.js";
import type { Address, Hex } from "viem";

const esc = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

/**
 * Failures and notices, rendered differently and BOTH announced.
 *
 * `overflow-wrap:anywhere` because the content is a chain error: it can carry
 * an unbroken hex blob with nowhere to wrap, and the frame would clip it into
 * something that reads like a complete sentence.
 */
export const err = () => {
  const parts: string[] = [];
  if (state.error) {
    parts.push(
      '<span role="alert" style="font-size:12px;color:var(--accent);overflow-wrap:anywhere;min-width:0">' +
      esc(state.error) + "</span>",
    );
  }
  if (state.notice) {
    parts.push(
      '<span role="status" style="font-size:12px;color:var(--dim);overflow-wrap:anywhere;min-width:0">' +
      esc(state.notice) + "</span>",
    );
  }
  return parts.join("");
};

const logHtml = () =>
  state.log
    .map((l) => '<div style="padding:6px 0;border-top:1px solid var(--rule)">' + l.html + "</div>")
    .join("");

// ---- step 1 · who trades -------------------------------------------------
//
// Connecting was its own numbered step, which made the first thing the product
// asked of you a piece of plumbing. It is a precondition, so it sits inline
// above the question that actually matters.

export function setupScreen(): string {
  const connected = !!state.account;
  return [
    '<div class="screen">',
    '<h2 style="margin:0;font-size:26px;line-height:1.2;font-weight:500;letter-spacing:-0.04em">let someone trade for you.<br />keep your money.</h2>',
    '<p class="body" style="margin:0">you approve an amount. you do not send it. it stays in this wallet until an order that satisfies your limits pulls exactly what it needs.</p>',

    connected
      ? '<div class="sep rowline"><span style="font-size:12px;color:var(--dimmer)">your wallet</span>' +
        '<span style="font-size:12.5px">' + short(state.account!) + "</span></div>"
      : '<div class="sep" style="display:flex;flex-direction:column;gap:7px">' +
        '<button id="d-connect" class="btn"' + (state.busy ? " disabled" : "") + ">" +
        (state.busy ? "waiting for your wallet…" : "connect wallet") + "</button>" +
        '<span class="hint">connecting adds the somnia network if your wallet does not have it yet.</span>' +
        "</div>",

    '<div class="sep" style="display:flex;flex-direction:column;gap:9px;min-width:0">',
    '<label class="eyebrow" for="d-addr" style="letter-spacing:0.12em">who is trading for you?</label>',
    '<input id="d-addr" class="field" value="' + esc(state.delegate) + '" placeholder="their wallet address, 0x…" spellcheck="false" autocomplete="off" />',
    '<span class="hint">they sign their own transactions from this address. they never see your key, and you never see theirs.</span>',
    "</div>",
    err(),
    '<button id="d-next" class="btn accent"' + (connected ? "" : " disabled") + ">" +
      (connected ? "set the limits &rarr;" : "connect first") + "</button>",
    "</div>",
  ].join("");
}

export function bindSetup(): void {
  document.getElementById("d-addnet")?.addEventListener("click", async () => {
    try {
      await addNetwork();
      set({ onChain: await onRightChain(), error: "" });
    } catch (e) { set({ error: errName(e) }); }
  });
  document.getElementById("d-connect")?.addEventListener("click", async () => {
    set({ busy: true, error: "" });
    try {
      const a = await connect();
      if (!(await onRightChain())) await addNetwork();
      set({ account: a, onChain: await onRightChain(), busy: false, error: "" });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });

  const input = document.getElementById("d-addr") as HTMLInputElement | null;
  const alert = document.querySelector<HTMLElement>('[role="alert"]');
  input?.addEventListener("input", () => {
    // Not set(): a re-render would replace the field mid-keystroke.
    state.delegate = input.value;
    state.error = "";
    if (alert) alert.textContent = "";
  });
  document.getElementById("d-next")?.addEventListener("click", () => {
    if (!state.account) { set({ error: "connect your wallet first" }); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(state.delegate.trim())) {
      set({ error: "that is not a 20-byte wallet address" });
      return;
    }
    set({ error: "", screen: "limits" });
  });
}

// ---- step 2 · the limits -----------------------------------------------------------

function slider(id: string, label: string, val: number, min: number, max: number, step: number, note: string, unit: string): string {
  return [
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px;min-width:0">',
    '<div class="rowline"><label for="' + id + '" style="font-size:13px">' + label + "</label>",
    '<span id="' + id + '-out" style="font-size:19px;letter-spacing:-0.03em">' + val + "</span></div>",
    '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val +
      '" style="width:100%" aria-describedby="' + id + '-note" aria-valuetext="' + val + " " + unit + '" />',
    '<span class="hint" id="' + id + '-note">' + note + "</span>",
    "</div>",
  ].join("");
}

/** The four discovery outcomes, each said out loud. */
function marketList(): string {
  if (state.marketsState === "loading") {
    return '<span class="hint">reading live markets from chain…</span>';
  }
  if (state.marketsState === "failed") {
    return [
      '<span role="alert" style="font-size:12px;color:var(--accent);overflow-wrap:anywhere">',
      esc(state.marketsError || "market discovery failed."),
      "</span>",
      '<button id="retry-markets" class="btn ghost" style="margin-top:8px">try again</button>',
    ].join("");
  }
  if (state.marketsState === "empty") {
    return [
      '<span class="hint">no market is open for trading right now. the venue runs six at a time — ',
      "two assets in a 60s, a 300s and a 3600s window — so there are gaps.</span>",
      '<button id="retry-markets" class="btn ghost" style="margin-top:8px">check again</button>',
    ].join("");
  }
  return state.markets
    .map((mk, i) => {
      const on = state.allowed.has(mk.marketId);
      return [
        '<button data-mk="' + i + '" class="mk" aria-pressed="' + on + '">',
        '<span style="line-height:1.5;min-width:0;overflow-wrap:anywhere;flex:1 1 auto">' + esc(mk.label) + "</span>",
        '<span style="font-size:11px;flex:0 0 auto;color:' + (on ? "var(--accent)" : "var(--dimmer)") + '">' + (on ? "on" : "off") + "</span>",
        "</button>",
      ].join("");
    })
    .join("");
}

export function limitsScreen(): string {
  return [
    '<div class="screen" style="gap:20px">',
    slider("s-budget", "total_budget", state.budget, 100, 2000, 50, "the most that can ever be pulled from your wallet, across the whole delegation.", "tUSDC"),
    slider("s-order", "max_per_order", state.maxOrder, 10, 200, 5, "caps one bad decision. checked before the pull, in the same transaction.", "tUSDC"),
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px;min-width:0">',
    '<div class="rowline"><span style="font-size:13px">allowed_markets</span>',
    '<span style="font-size:12px;color:var(--dimmer)">' + state.allowed.size + "/" + state.markets.length + "</span></div>",
    '<div style="display:flex;flex-direction:column;gap:5px;min-width:0">' + marketList() + "</div>",
    '<span class="hint">markets are read from chain, keyed by marketId. pools are recycled between windows, so a pool address would silently start governing a different market.</span>',
    "</div>",
    slider("s-days", "expires_in_days", state.days, 1, 30, 1, "the delegation dies on its own. no transaction required to end it.", "days"),
    err(),
    '<button id="d-review" class="btn">review &rarr;</button>',
    "</div>",
  ].join("");
}

export function bindLimits(): void {
  // Bound HERE, where the button exists. It was wired at module load in app.ts,
  // before the screen had ever rendered, so it silently did nothing — a dead
  // control on the one screen whose job is to recover from a failed read.
  document.getElementById("retry-markets")?.addEventListener("click", () => {
    void reloadMarkets();
  });

  /**
   * Updates the readout NODE rather than calling set().
   *
   * set() replaces the whole screen's innerHTML, which destroyed the range
   * input on every `input` event — the drag ended after one step and keyboard
   * stepping was impossible. State is written directly; nothing else on screen
   * depends on it until the user moves on.
   */
  const bindRange = (id: string, key: "budget" | "maxOrder" | "days", unit: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    const out = document.getElementById(id + "-out");
    el?.addEventListener("input", () => {
      const v = Number(el.value);
      (state as unknown as Record<string, number>)[key] = v;
      if (out) out.textContent = String(v);
      el.setAttribute("aria-valuetext", `${v} ${unit}`);
    });
  };
  bindRange("s-budget", "budget", "tUSDC");
  bindRange("s-order", "maxOrder", "tUSDC");
  bindRange("s-days", "days", "days");

  document.querySelectorAll<HTMLButtonElement>(".mk").forEach((b) => {
    b.addEventListener("click", () => {
      const mk = state.markets[Number(b.dataset.mk)];
      if (!mk) return;
      const next = new Set(state.allowed);
      if (next.has(mk.marketId)) next.delete(mk.marketId);
      else next.add(mk.marketId);
      set({ allowed: next, error: "" });
    });
  });

  document.getElementById("d-review")?.addEventListener("click", () => {
    if (state.allowed.size === 0) {
      set({ error: "pick at least one market" });
      return;
    }
    set({ error: "", screen: "review" });
  });
}

// ---- step 3 · review ----------------------------------------------------
//
// The four refusals used to open the app, before the user had done anything —
// four red crosses as a greeting, making claims at the moment they had least
// reason to be believed. They belong HERE, next to the signature, which is the
// only moment they are load-bearing. They are proven later still, by a refusal
// and a reverted transaction.
const CANNOT = [
  "move your money to any address but yours",
  "trade a market you did not allow",
  "spend more than the per-order cap",
  "keep trading after the budget or the clock runs out",
];

function row(k: string, v: string): string {
  return [
    '<div class="rowline" style="padding:7px 0;border-top:1px solid var(--rule)">',
    '<span style="font-size:12px;color:var(--dimmer)">' + k + "</span>",
    '<span style="font-size:13px;min-width:0;overflow-wrap:anywhere">' + esc(v) + "</span></div>",
  ].join("");
}

export function reviewScreen(): string {
  return [
    '<div class="screen">',
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">one signature. then nothing.</h2>',
    "<div>",
    row("delegate", state.delegate ? short(state.delegate) : "—"),
    row("total_budget", state.budget + " tUSDC"),
    row("max_per_order", state.maxOrder + " tUSDC"),
    row("allowed_markets", String(state.allowed.size)),
    row("expires", state.days + " days"),
    row("withdraw_destination", state.account ? short(state.account) : "your wallet"),
    "</div>",
    '<p class="body" style="margin:0">signing approves the registry to pull up to ' + state.budget +
      " tUSDC <b>from this wallet</b>, and writes the limits on chain. the money does not move now.</p>",
    '<div class="sep" style="display:flex;flex-direction:column;gap:10px">',
    '<span class="eyebrow">once signed, they cannot</span>',
    CANNOT.map((c) => '<span class="refusal"><span class="x">x</span>' + c + "</span>").join(""),
    "</div>",
    err(),
    '<button id="d-sign" class="btn accent"' + (state.busy ? " disabled" : "") + ">" +
      (state.busy ? "waiting…" : "approve + create mandate") + "</button>",
    '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' + logHtml() + "</div>",
    "</div>",
  ].join("");
}

export function bindReview(): void {
  document.getElementById("d-sign")?.addEventListener("click", async () => {
    if (!state.account) {
      set({ error: "connect first" });
      return;
    }
    set({ busy: true, error: "" });
    const label = document.getElementById("d-sign");
    const say = (t: string) => { if (label) label.textContent = t; };
    try {
      const w = wallet(state.account);
      const budgetRaw = BigInt(state.budget) * 1_000_000n;
      const orderRaw = BigInt(state.maxOrder) * 1_000_000n;

      // Approve exactly the budget. The allowance IS the second revocation
      // lever, and one the delegator already understands without reading us.
      const allowance = (await pub.readContract({
        address: COLLATERAL, abi: erc20Abi, functionName: "allowance",
        args: [state.account, REGISTRY as Address],
      })) as bigint;
      if (allowance < budgetRaw) {
        say("approve in your wallet…");
        const h = await w.writeContract({
          address: COLLATERAL, abi: erc20Abi, functionName: "approve",
          args: [REGISTRY as Address, budgetRaw],
        });
        state.log.unshift({
          html: 'approve · <a href="' + txUrl(h) + '" target="_blank" rel="noreferrer">' + h.slice(0, 12) + "…</a>",
        });
        say("waiting for the approve to confirm…");
        await pub.waitForTransactionReceipt({ hash: h });
      }

      const expiry = BigInt(Math.floor(Date.now() / 1000) + state.days * 86400);
      const ids = [...state.allowed] as Hex[];
      const next = (await pub.readContract({
        address: REGISTRY as Address, abi: registryAbi, functionName: "nextMandateId",
      })) as bigint;

      say("sign the mandate in your wallet…");
      const hash = await w.writeContract({
        address: REGISTRY as Address, abi: registryAbi, functionName: "createMandate",
        args: [state.delegate as Address, orderRaw, budgetRaw, expiry, ids],
      });
      state.log.unshift({
        html: 'mandate · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      say("waiting for confirmation…");
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("mandate transaction reverted");
      set({ busy: false, mandateId: next, screen: "issue" });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });
}

// ---- step 4 · hand over ------------------------------------------------------------

/** The link the delegate opens. Same origin, so it works wherever this is served. */
export function delegateLink(): string {
  const base = globalThis.location?.origin ?? "";
  const path = globalThis.location?.pathname?.includes("app") ? globalThis.location.pathname : "/app.html";
  return `${base}${path}?role=delegate&m=${state.mandateId ?? ""}`;
}

export function issueScreen(): string {
  if (!state.mandateId) {
    return [
      '<div class="screen">',
      '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">nothing to hand over yet</h2>',
      '<p class="body" style="margin:0">create a mandate first — step 04 — and the link and code appear here.</p>',
      err(),
      "</div>",
    ].join("");
  }
  const url = delegateLink();
  let qr = "";
  try {
    qr = qrSvg(url, 190);
  } catch {
    qr = '<span class="hint">the link is too long to encode as a code — use copy instead.</span>';
  }
  return [
    '<div class="screen">',
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">hand it to them</h2>',
    '<p class="body" style="margin:0">mandate <b>#' + String(state.mandateId) + '</b>. they scan this, or open the link. it carries no key and no permission by itself — the limits live on chain.</p>',
    '<div style="background:#fff;padding:12px;align-self:flex-start;line-height:0">' + qr + "</div>",
    '<div style="display:flex;flex-direction:column;gap:8px;min-width:0">',
    '<span class="eyebrow" style="letter-spacing:0.12em">delegate_link</span>',
    '<code id="d-link" style="font-size:11px;color:var(--dim);overflow-wrap:anywhere;min-width:0">' + esc(url) + "</code>",
    '<button id="d-copy" class="btn ghost">copy link</button>',
    "</div>",
    err(),
    '<button id="d-tomonitor" class="btn">done &mdash; watch it &rarr;</button>',
    "</div>",
  ].join("");
}

export function bindIssue(): void {
  document.getElementById("d-copy")?.addEventListener("click", async () => {
    const url = delegateLink();
    const btn = document.getElementById("d-copy");
    const restore = (t: string) => {
      if (!btn) return;
      btn.textContent = t;
      // Always put the label back. A control that keeps the last outcome as its
      // name has stopped telling you what it does.
      setTimeout(() => { btn.textContent = "copy link"; }, 2000);
    };
    try {
      await navigator.clipboard.writeText(url);
      restore("copied");
    } catch {
      // Clipboard is blocked without a secure context or a user gesture in some
      // browsers. Select the text so it can still be copied by hand.
      const el = document.getElementById("d-link");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      restore("selected — press copy");
    }
  });
  document.getElementById("d-tomonitor")?.addEventListener("click", () => go("manage"));
}

// ---- manage · where you live once it exists ------------------------------
//
// Monitoring and ending a delegation were two numbered steps, which implied you
// walk through them. You do not: one is where you sit, the other is a thing you
// do from there. Revoke is now an action on this screen, not a destination.

export interface MonitorData {
  m: readonly [Address, Address, bigint, bigint, bigint, bigint, boolean, boolean];
  remaining: bigint;
  clean: boolean;
  held: bigint;
}

export async function monitorData(): Promise<MonitorData | null> {
  if (!state.mandateId || !REGISTRY) return null;
  const [m, remaining, clean, held] = await Promise.all([
    pub.readContract({ address: REGISTRY as Address, abi: registryAbi, functionName: "mandates", args: [state.mandateId] }) as Promise<MonitorData["m"]>,
    pub.readContract({ address: REGISTRY as Address, abi: registryAbi, functionName: "remainingExposure", args: [state.mandateId] }) as Promise<bigint>,
    pub.readContract({ address: REGISTRY as Address, abi: registryAbi, functionName: "holdsNoFunds" }) as Promise<boolean>,
    pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [REGISTRY as Address] }) as Promise<bigint>,
  ]);
  return { m, remaining, clean, held };
}

/**
 * How old the figures on screen are, computed — never a fixed sentence.
 *
 * "every figure above is read from the contract" is only true of a read that
 * completed. Polls fail; this says which case the reader is looking at.
 */
export function freshnessLine(): string {
  const f = staleness();
  if (!f.known) return '<span class="hint">not read from the contract yet.</span>';
  if (!f.stale) return '<span class="hint">read from the contract ' + f.ageS + "s ago.</span>";
  return '<span class="hint" style="color:var(--accent)">last read from the contract ' + f.ageS +
    "s ago — the chain is not answering, so these figures are stale.</span>";
}


export function manageScreen(d: MonitorData | null): string {
  if (state.mandateParamError) {
    return '<div class="screen"><p role="alert" class="body" style="margin:0;color:var(--accent)">' +
      esc(state.mandateParamError) + "</p></div>";
  }
  if (!state.mandateId) {
    return [
      '<div class="screen">',
      '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">no delegation yet</h2>',
      '<p class="body" style="margin:0">set one up and this becomes where you watch it, share the link again, or end it.</p>',
      '<button id="m-start" class="btn accent">set one up &rarr;</button>',
      err(),
      "</div>",
    ].join("");
  }
  if (!d) {
    return [
      '<div class="screen">',
      '<p class="body" style="margin:0">reading delegation #' + String(state.mandateId) + " from the contract…</p>",
      freshnessLine(),
      err(),
      "</div>",
    ].join("");
  }
  const delegate = d.m[1];
  const perTrade = d.m[2];
  const cap = d.m[3];
  const used = d.m[4];
  const expiry = d.m[5];
  const revoked = d.m[6];
  const live = !revoked && BigInt(Math.floor(Date.now() / 1000)) < expiry;
  const pct = cap === 0n ? 0 : Number((d.remaining * 100n) / cap);
  const secs = Number(expiry) - Math.floor(Date.now() / 1000);

  return [
    '<div class="screen">',
    '<div class="rowline"><h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">your delegation</h2>',
    '<span style="font-size:11px;color:' + (live ? "var(--accent)" : "var(--dimmer)") + '">' +
      (live ? "active" : revoked ? "revoked" : "expired") + "</span></div>",
    '<div style="display:flex;flex-direction:column;gap:8px">',
    '<div class="rowline"><span style="font-size:12px;color:var(--dimmer)">they may still spend</span>',
    '<span style="font-size:22px;letter-spacing:-0.03em">' + fmt(d.remaining) + "</span></div>",
    '<div class="meter"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>',
    '<span class="hint">' + fmt(used) + " of " + fmt(cap) + " spent · max " + fmt(perTrade) + " per order</span>",
    "</div>",
    '<div style="display:flex;flex-direction:column">',
    row("trading for", short(delegate)),
    row("expires in", secs > 0 ? Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m" : "expired"),
    row("held by leash", fmt(d.held) + (d.clean ? "" : " UNATTRIBUTED")),
    "</div>",
    freshnessLine(),
    err(),
    '<div class="sep" style="display:flex;flex-direction:column;gap:8px">',
    '<button id="m-link" class="btn ghost">show the link again</button>',
    '<button id="m-revoke" class="btn accent"' + (state.busy || !state.account ? " disabled" : "") + ">" +
      (state.busy ? "ending it…" : "end this delegation") + "</button>",
    !state.account ? '<span class="hint">connect the wallet that created it to end it — only the delegator can.</span>' : "",
    '<span class="hint">one transaction, no counterparty. their next order reverts. you can also revoke the allowance from your wallet — either alone is enough.</span>',
    "</div>",
    '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' + logHtml() + "</div>",
    "</div>",
  ].join("");
}

export function bindManage(): void {
  document.getElementById("m-start")?.addEventListener("click", () => go("setup"));
  document.getElementById("m-link")?.addEventListener("click", () => go("issue"));
  document.getElementById("m-revoke")?.addEventListener("click", async () => {
    if (!state.account) { set({ error: "connect the delegator wallet first" }); return; }
    if (!state.mandateId) { set({ error: "no delegation to end" }); return; }
    set({ busy: true, error: "" });
    const label = document.getElementById("m-revoke");
    try {
      const hash = await wallet(state.account).writeContract({
        address: REGISTRY as Address, abi: registryAbi, functionName: "revoke", args: [state.mandateId],
      });
      state.log.unshift({
        html: 'ended · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      if (label) label.textContent = "waiting for confirmation…";
      await pub.waitForTransactionReceipt({ hash });
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });
}
