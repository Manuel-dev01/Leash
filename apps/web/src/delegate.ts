/**
 * DELEGATE — the surface that appears on camera repeatedly.
 *
 * The bar is: scan a QR, see what the key may do, tap Up or Down, get a tx hash.
 * Nothing between those steps. Every extra tap is a second of a judge's
 * attention spent on us rather than on the thing that is interesting.
 *
 * The mandate id arrives in the URL (?m=), which is what the delegator's QR
 * encodes — so a scan lands here already pointed at the right delegation.
 */
import {
  pub, wallet, connect, addNetwork, onRightChain, registryAbi,
  txUrl, fmt, errName,
} from "./chain.js";
import type { Address, Hex } from "viem";
import "./app.css";

const $ = (id: string) => document.getElementById(id)!;
const q = new URLSearchParams(location.search);
const REGISTRY = (q.get("r") ?? (import.meta as never as { env: Record<string, string> }).env?.VITE_REGISTRY ?? "") as Address;
const MANDATE = BigInt(q.get("m") ?? "0");

let account: Address | null = null;
let marketId: Hex | null = null;
let pool: Address | null = null;

function log(html: string) {
  const d = document.createElement("div");
  d.className = "line";
  d.innerHTML = html;
  $("log").prepend(d);
}

function fail(msg: string) {
  $("err").textContent = msg;
}

async function refresh() {
  if (!REGISTRY || MANDATE === 0n) {
    fail("No mandate in this link. Scan the QR your delegator gave you.");
    return;
  }
  const m = (await pub.readContract({
    address: REGISTRY, abi: registryAbi, functionName: "mandates", args: [MANDATE],
  })) as unknown as readonly [Address, Address, bigint, bigint, bigint, bigint, boolean, boolean];
  const [delegator, delegate, perTrade, cap, used, expiry, revoked, exists] = m;

  if (!exists) { fail(`Mandate #${MANDATE} does not exist on this registry.`); return; }

  const active = !revoked && BigInt(Math.floor(Date.now() / 1000)) < expiry;
  const remaining = used >= cap ? 0n : cap - used;
  const pct = cap === 0n ? 0 : Number((used * 100n) / cap);

  $("who").textContent = `for ${delegator.slice(0, 6)}…${delegator.slice(-4)}`;
  $("state").className = `pill ${active ? "live" : "dead"}`;
  $("state").textContent = active ? "LIVE" : revoked ? "REVOKED" : "EXPIRED";
  $("perTrade").textContent = `${fmt(perTrade)} tUSDC`;
  $("remaining").textContent = `${fmt(remaining)} tUSDC`;
  $("capline").textContent = `${fmt(used)} of ${fmt(cap)} used`;
  const bar = $("bar") as HTMLElement;
  bar.style.width = `${Math.min(pct, 100)}%`;
  $("meter").className = `meter ${pct > 85 ? "bad" : pct > 60 ? "warn" : ""}`;
  const mins = Number(expiry) - Math.floor(Date.now() / 1000);
  $("expiry").textContent = mins > 0 ? `${Math.floor(mins / 60)}m left` : "expired";

  const tradable = active && account !== null && delegate.toLowerCase() === account.toLowerCase() && marketId !== null;
  ($("up") as HTMLButtonElement).disabled = !tradable;
  ($("down") as HTMLButtonElement).disabled = !tradable;

  if (account && delegate.toLowerCase() !== account.toLowerCase()) {
    fail(`This mandate is for ${delegate.slice(0, 6)}…${delegate.slice(-4)}, not your wallet.`);
  } else if (active) {
    fail("");
  }
}

/** The market this mandate is allowed to trade, supplied by the issuing link. */
function readMarketFromLink() {
  const mk = q.get("mk"), p = q.get("p");
  if (mk && p) { marketId = mk as Hex; pool = p as Address; $("market").textContent = `${mk.slice(0, 10)}…`; }
  else $("market").textContent = "none in link";
}

async function place(kind: 0 | 2, label: string) {
  if (!account || !marketId || !pool) return;
  fail("");
  const btns = [$("up"), $("down")] as HTMLButtonElement[];
  btns.forEach((b) => (b.disabled = true));
  try {
    if (!(await onRightChain())) await addNetwork();
    // Price to the top of the range: a taker is charged the FILL price, not the
    // price it offered, so aggression costs nothing and removes the stale-book
    // failure mode that makes an order rest instead of fill.
    const price = 990_000n;
    const qty = 1_000_000n;
    const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;
    const args = [MANDATE, marketId, pool, kind, price, qty, expireNs] as const;

    // Simulate first. placeBinaryOrder returns (success, id) and a false does not
    // revert, so a mined transaction can be a silent rejection.
    await pub.simulateContract({ account, address: REGISTRY, abi: registryAbi, functionName: "placeForDelegator", args: args as never });

    const hash = await wallet(account).writeContract({
      address: REGISTRY, abi: registryAbi, functionName: "placeForDelegator", args: args as never,
    });
    log(`${label} sent · <a href="${txUrl(hash)}" target="_blank" rel="noreferrer">${hash.slice(0, 14)}…</a>`);
    const r = await pub.waitForTransactionReceipt({ hash });
    log(`${label} <b>${r.status === "success" ? "filled" : "reverted"}</b> · <a href="${txUrl(hash)}" target="_blank" rel="noreferrer">${hash.slice(0, 14)}…</a>`);
  } catch (e) {
    const n = errName(e);
    fail(
      n === "ExceedsCumulative" ? "Refused: this would exceed the mandate's total limit."
      : n === "StakeExceedsPerTrade" ? "Refused: bigger than the per-trade limit."
      : n === "Revoked" ? "This mandate has been revoked."
      : n === "Expired" ? "This mandate has expired."
      : n === "MarketNotAllowed" ? "Refused: this market is not on the mandate."
      : n,
    );
  } finally {
    await refresh();
  }
}

$("connect").addEventListener("click", async () => {
  try {
    account = await connect();
    if (!(await onRightChain())) await addNetwork();
    $("connect").textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
    await refresh();
  } catch (e) { fail(errName(e)); }
});
$("addnet").addEventListener("click", () => addNetwork().catch((e) => fail(errName(e))));
$("up").addEventListener("click", () => place(0, "UP"));
$("down").addEventListener("click", () => place(2, "DOWN"));

readMarketFromLink();
refresh().catch((e) => fail(errName(e)));
setInterval(() => refresh().catch(() => {}), 6000);
