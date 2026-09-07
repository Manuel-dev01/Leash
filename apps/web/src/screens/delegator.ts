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

// ---- 01 connect ----------------------------------------------------------

const CANNOT = [
  "move your money to any address but yours",
  "trade a market you did not allow",
  "spend more than the per-order cap",
  "keep trading after the budget or the clock runs out",
];

export function connectScreen(): string {
  return [
    '<div class="screen">',
    '<span class="eyebrow">01 / setup</span>',
    '<h2 style="margin:0;font-size:25px;line-height:1.22;font-weight:500;letter-spacing:-0.04em">let someone trade for you.<br />keep your money.</h2>',
    '<p class="body" style="margin:0">you approve an amount. you do not send it. it stays in this wallet until an order that satisfies your limits pulls exactly what it needs.</p>',
    '<div style="display:flex;flex-direction:column;gap:7px">',
    '<button id="d-addnet" class="btn ghost" style="display:flex;align-items:center;justify-content:space-between">',
    "<span>" + (state.onChain ? "network ready" : "add somnia network") + "</span>",
    '<span style="font-size:11px;color:var(--dimmer)">chain:50312</span></button>',
    '<button id="d-connect" class="btn"' + (state.busy ? " disabled" : "") + ">" +
      (state.busy ? "waiting for your wallet…" : state.account ? short(state.account) : "connect wallet") + "</button>",
    "</div>",
    '<div style="border-top:1px solid var(--rule);padding-top:16px;display:flex;flex-direction:column;gap:10px">',
    '<span class="eyebrow">what leash cannot do</span>',
    CANNOT.map((c) => '<span class="refusal"><span class="x">x</span>' + c + "</span>").join(""),
    "</div>",
    err(),
    "</div>",
  ].join("");
}

export function bindConnect(): void {
  document.getElementById("d-addnet")?.addEventListener("click", async () => {
    try {
      await addNetwork();
      set({ onChain: await onRightChain(), error: "" });
    } catch (e) {
      set({ error: errName(e) });
    }
  });
  document.getElementById("d-connect")?.addEventListener("click", async () => {
    set({ busy: true, error: "" });
    try {
      const a = await connect();
      if (!(await onRightChain())) await addNetwork();
      set({ account: a, onChain: await onRightChain(), busy: false, error: "", screen: "pick" });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });
}

// ---- 02 choose delegate --------------------------------------------------

export function pickScreen(): string {
  return [
    '<div class="screen">',
    '<span class="eyebrow">02 / who trades</span>',
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">who is trading for you?</h2>',
    '<div style="display:flex;flex-direction:column;gap:9px">',
    '<label class="eyebrow" for="d-addr" style="letter-spacing:0.12em">delegate_address</label>',
    '<input id="d-addr" class="field" value="' + esc(state.delegate) + '" placeholder="0x…" spellcheck="false" autocomplete="off" />',
    '<span class="hint">they sign their own transactions from this address. they never see your key.</span>',
    "</div>",
    err(),
    '<button id="d-next" class="btn">set the limits &rarr;</button>',
    "</div>",
  ].join("");
}

export function bindPick(): void {
  const input = document.getElementById("d-addr") as HTMLInputElement | null;
  const clear = document.querySelector<HTMLElement>('[role="alert"]');
  input?.addEventListener("input", () => {
    // Deliberately NOT set(): a re-render would replace the input mid-keystroke.
    // The error node is cleared directly instead, so the message does not sit
    // there contradicting what the user is typing.
    state.delegate = input.value;
    state.error = "";
    if (clear) clear.textContent = "";
  });
  document.getElementById("d-next")?.addEventListener("click", () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(state.delegate.trim())) {
      set({ error: "that is not a 20-byte address" });
      return;
    }
    set({ error: "", screen: "limits" });
  });
}

// ---- 03 limits -----------------------------------------------------------

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
    '<span class="eyebrow">03 / the leash</span>',
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

// ---- 04 review + sign ----------------------------------------------------

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
    '<span class="eyebrow">04 / sign once</span>',
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

// ---- 05 issue ------------------------------------------------------------

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
      '<span class="eyebrow">05 / issue</span>',
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
    '<span class="eyebrow">05 / issue</span>',
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">hand it to them</h2>',
    '<p class="body" style="margin:0">mandate <b>#' + String(state.mandateId) + '</b>. they scan this, or open the link. it carries no key and no permission by itself — the limits live on chain.</p>',
    '<div style="background:#fff;padding:12px;align-self:flex-start;line-height:0">' + qr + "</div>",
    '<div style="display:flex;flex-direction:column;gap:8px;min-width:0">',
    '<span class="eyebrow" style="letter-spacing:0.12em">delegate_link</span>',
    '<code id="d-link" style="font-size:11px;color:var(--dim);overflow-wrap:anywhere;min-width:0">' + esc(url) + "</code>",
    '<button id="d-copy" class="btn ghost">copy link</button>',
    "</div>",
    err(),
    '<button id="d-tomonitor" class="btn">watch it &rarr;</button>',
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
  document.getElementById("d-tomonitor")?.addEventListener("click", () => go("monitor"));
}

// ---- 06 monitor ----------------------------------------------------------

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

export function monitorScreen(d: MonitorData | null): string {
  if (state.mandateParamError) {
    return [
      '<div class="screen">',
      '<span class="eyebrow">06 / monitor</span>',
      '<p role="alert" class="body" style="margin:0;color:var(--accent)">' + esc(state.mandateParamError) + "</p>",
      "</div>",
    ].join("");
  }
  if (!state.mandateId) {
    return [
      '<div class="screen">',
      '<span class="eyebrow">06 / monitor</span>',
      '<p class="body" style="margin:0">no mandate yet. create one in steps 02–04, and this screen reads it back from the contract.</p>',
      err(),
      "</div>",
    ].join("");
  }
  if (!d) {
    return [
      '<div class="screen">',
      '<span class="eyebrow">06 / monitor</span>',
      '<p class="body" style="margin:0">reading mandate #' + String(state.mandateId) + " from the contract…</p>",
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
  const status = live ? "delegation_active" : revoked ? "revoked" : "expired";

  return [
    '<div class="screen">',
    '<div class="rowline"><span class="eyebrow">06 / monitor</span>',
    '<span style="font-size:11px;color:' + (live ? "var(--accent)" : "var(--dimmer)") + '">' + status + "</span></div>",
    '<div style="display:flex;flex-direction:column;gap:8px">',
    '<div class="rowline"><span style="font-size:12px;color:var(--dimmer)">allowance_remaining</span>',
    '<span style="font-size:22px;letter-spacing:-0.03em">' + fmt(d.remaining) + "</span></div>",
    '<div class="meter"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>',
    '<span class="hint">' + fmt(used) + " of " + fmt(cap) + " spent · max " + fmt(perTrade) + " per order</span>",
    "</div>",
    '<div style="display:flex;flex-direction:column">',
    row("mandate_id", "#" + String(state.mandateId)),
    row("trading_for", short(delegate)),
    row("expires_in", secs > 0 ? Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m" : "expired"),
    "</div>",
    '<div class="rowline" style="padding:8px 0;border-top:1px solid var(--rule)">',
    '<span style="font-size:12px;color:var(--dimmer)">held_by_registry</span>',
    '<span style="font-size:12.5px;color:' + (d.clean ? "var(--ink)" : "var(--accent)") + '">' +
      fmt(d.held) + (d.clean ? "" : " UNATTRIBUTED") + "</span></div>",
    freshnessLine(),
    '<p class="body" style="margin:0">the registry holds nothing that is not owed to a named party.</p>',
    err(),
    '<div style="display:flex;gap:7px"><button id="d-toissue" class="btn ghost">the link &rarr;</button>',
    '<button id="d-torevoke" class="btn ghost">ending it &rarr;</button></div>',
    "</div>",
  ].join("");
}

export function bindMonitor(): void {
  document.getElementById("d-torevoke")?.addEventListener("click", () => go("revoke"));
  document.getElementById("d-toissue")?.addEventListener("click", () => go("issue"));
}

// ---- 07 revoke -----------------------------------------------------------

export function revokeScreen(): string {
  const blocked = !state.account ? "connect your wallet to revoke — only the delegator can."
    : !state.mandateId ? "no mandate to revoke."
    : "";
  return [
    '<div class="screen">',
    '<span class="eyebrow">07 / revoke</span>',
    '<h2 style="margin:0;font-size:22px;line-height:1.28;font-weight:500;letter-spacing:-0.04em">ending it</h2>',
    '<p class="body" style="margin:0">one transaction, no counterparty. the delegate cannot stop it, cannot delay it, and does not need to agree. their next order reverts.</p>',
    '<p class="body" style="margin:0">you can also revoke the ERC-20 allowance from your wallet. either alone is enough.</p>',
    blocked ? '<span class="hint">' + blocked + "</span>" : "",
    err(),
    '<button id="d-revoke" class="btn accent"' + (state.busy || blocked ? " disabled" : "") + ">" +
      (state.busy ? "revoking…" : "revoke and withdraw") + "</button>",
    '<div style="font-size:11.5px;color:var(--dimmer);word-break:break-all">' + logHtml() + "</div>",
    "</div>",
  ].join("");
}

export function bindRevoke(): void {
  document.getElementById("d-revoke")?.addEventListener("click", async () => {
    // The button is disabled in exactly these cases, so this is belt and
    // braces — but it reports rather than returning silently, which is what it
    // used to do while looking perfectly clickable.
    if (!state.account) { set({ error: "connect your wallet first" }); return; }
    if (!state.mandateId) { set({ error: "no mandate to revoke" }); return; }
    set({ busy: true, error: "" });
    const label = document.getElementById("d-revoke");
    try {
      const hash = await wallet(state.account).writeContract({
        address: REGISTRY as Address, abi: registryAbi, functionName: "revoke", args: [state.mandateId],
      });
      state.log.unshift({
        html: 'revoke · <a href="' + txUrl(hash) + '" target="_blank" rel="noreferrer">' + hash.slice(0, 12) + "…</a>",
      });
      if (label) label.textContent = "waiting for confirmation…";
      await pub.waitForTransactionReceipt({ hash });
      set({ busy: false, screen: "monitor" });
    } catch (e) {
      set({ busy: false, error: errName(e) });
    }
  });
}
