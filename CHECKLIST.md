# Leash — end-to-end product checklist

Every quoted string below was read out of the shipped source, not remembered.
If the app says something different, the app is wrong or this file is stale —
either way, say so.

- **App:** https://leash-rho.vercel.app
- **Chain:** Somnia Shannon, id `50312` · **Collateral:** tUSDC, **6 decimals**
- **Registry:** `0x105e7732DE6D2E8C43e5803F8Df0D2d4860E7679`
- **Handler:** `0x66D1D983e89a7eCb4bCFf535A348C59086B686Ad`

**The flow is 4 setup steps + one manage surface. The delegate has one screen.**
Anything describing `01 connect` / `02 choose_delegate` / `06 monitor` /
`07 revoke` is from the old build.

---

## 0 · Preflight

| # | Do | Expect | If not |
|---|---|---|---|
| 0.1 | `npx tsx scripts/verify.ts` | `34 checks: 33 pass, 1 amber, 0 fail` | Any **FAIL** → stop |
| 0.2 | Read the amber | `delegators-paid`, and only that — see §8 | An amber naming a *handler measurement* is different: it means the deployed bytecode moved and the gas figures need re-proving |
| 0.3 | `npm run ready` | `GO`, a market with ttl 200–900s | `WAIT` → next window ~5 min |
| 0.4 | Open a **normal browser window**. Call it **A**. Connect the delegator wallet here | Has tUSDC + STT | |
| 0.5 | Open a **second, separate window** — a different Chrome profile, or a different browser. Call it **B**. Connect the delegate wallet here | **≥ 0.3 STT** | Runs dry after ~10 orders |

> **Why two windows — and the shortcut.** MetaMask exposes **one active account
> per browser profile**. Two tabs in the same profile are therefore the SAME
> identity: switching the account switches it everywhere. Two separate profiles
> (or two browsers) give you two real identities at once, which is what these
> steps assume.
>
> **The shortcut:** you can do the whole run in ONE window by switching the
> MetaMask account when a section changes hands. The app watches
> `accountsChanged` and follows you — the "trading as" line updates without a
> reload, and if you are on the wrong account for a mandate it says so by name
> instead of letting you find out from a revert. Two profiles are still cleaner
> for a recording, because both sides stay on screen.
>
> **Sections 1, 2, 3 and 5 are the delegator (A). Section 4 is the delegate
> (B).** Each section says which. If you have to change identity mid-section to
> make something work, that is a bug — note the step number.

---

## 1 · Landing — **window A**

No wallet or role is involved here. This is the public page.

| # | Do | Expect |
|---|---|---|
| 1.1 | Open `/` | Hero fits **without scrolling**; refusal ticker scrolls |
| 1.2 | **Scroll down past the hero and the scrolling ticker**, to the row of four large figures | It reads `0.00` / `1` / `0` / `4` |
| 1.3 | The first of those four — the one labelled *held by leash, every block* | On load it is briefly `…`, then becomes a **number** (usually `0.00`) or an **em dash `—`**. It must never stay `…` |
| 1.4 | Read across the other three | `1` signature, then silence · `0` admin keys, upgrades, pauses · `4` limits, checked in the order path |
| 1.5 | Click **`add somnia 50312`** (in the row with *create a mandate*) | Wallet prompts; the label goes back to `add somnia 50312` within ~2.5s |
| 1.6 | **Scroll to the very bottom.** The right-hand item reads `registry 0x7ca9dA7B…23418864 →` | It is **underlined**, and clicking it opens the explorer on that address in a new tab |
| 1.7 | DevTools console | **No errors.** No 404s |

> **1.3 explained.** `…` means "we have not heard from the chain yet". A number
> means we asked and this is the answer. `—` means we asked and got nothing.
> The one thing it must never do is show a confident `0.00` when it never
> actually read — that distinction is a claim the project makes in
> `claims.json`, so it is worth the fifteen seconds.

---

## 2 · Setup — **window A** (the delegator)

**Look before you touch.** Top to bottom you should see: a one-line topbar
(`leash`, `chain 50312`, `add somnia 50312`), then **`step 1 of 4 · who trades`**
with a four-segment bar, then the heading.

**There must be no numbered nav list, and no italic paragraph of design
rationale anywhere on the page.**

### Step 1 — who trades

| # | Do | Expect |
|---|---|---|
| 2.1 | Read the first line | **“let someone trade for you. keep your money.”** — not “connect wallet” |
| 2.2 | Look at the bottom button | Reads **`connect first`**, and is **grey/muted — never red** |
| 2.3 | Click **`connect wallet`** | Approve in wallet; button is replaced by your address |
| 2.4 | If your wallet was on a different chain, look at the topbar after connecting | Connecting adds and switches the network for you; the topbar reads **`network ready`** |
| 2.5 | Type `abc` in the address field, click **`set the limits →`** | `that is not a 20-byte wallet address` |
| 2.6 | Keep typing | Error **clears as you type**, not on the next click |
| 2.7 | Paste **B's address** → **`set the limits →`** | Advances; header reads `step 2 of 4 · the limits` |

### Step 2 — the limits

| # | Do | Expect |
|---|---|---|
| 2.8 | Click **`← back`** | Returns to step 1 with **the address still filled in** |
| 2.9 | Forward again, then **drag** each of the three sliders with the mouse | The number tracks the drag smoothly and **does not stop after one step** |
| 2.10 | Click a slider handle, then press the **&larr; and &rarr; keys on your keyboard** (there are no arrow buttons on screen — this is a keyboard test) | The number steps by one on each press, and **keeps** stepping. If only the first press works, the screen is re-rendering and dropping focus |
| 2.11 | Read a market row | `BTC · resolves in 45m` — asset, then a **minutes** figure that counts down. `on`/`off` sits on the right. The failure to watch for is the two halves colliding into one word, `4mon`, which is a lost layout, not a unit |
| 2.12 | Toggle one off, then **`review →`** | Advances; count updated |
| 2.13 | Go back, toggle **all** off, **`review →`** | `pick at least one market`; stays put |

> **If no markets are open** you must see *“no market is open for trading right
> now…”* plus a working **`check again`** button. You must **never** be left on
> `reading live markets from chain…` with nothing happening.

### Step 3 — review

| # | Do | Expect |
|---|---|---|
| 2.14 | Read the summary | Matches your sliders exactly |
| 2.15 | `withdraw_destination` | **Your own address** — this is the line that matters |
| 2.16 | Find **`once signed, they cannot`** | The four ✗ items are **here**, at the signature — not on the first screen |
| 2.17 | Click **`approve + create mandate`**, then **reject** in the wallet | Error appears; button **re-enables**. Not stuck on `waiting…` |
| 2.18 | Repeat, approve both prompts | Label walks: `waiting for your wallet…` → `waiting for the approve to confirm…` → `waiting for confirmation…` |
| 2.19 | On success | Lands on step 4 |

### Step 4 — hand over

| # | Do | Expect |
|---|---|---|
| 2.20 | Screen shows | `mandate #N`, a **QR**, the link text, **`copy link`** |
| 2.21 | Read the link | `https://leash-rho.vercel.app/app?role=delegate&m=N` — **not** `localhost` |
| 2.22 | Click **`copy link`** | Becomes `copied`, reverts to `copy link` after ~2s |
| 2.23 | **Scan the QR with a real phone camera** | Opens the delegate view for that mandate |
| 2.24 | Click **`done — watch it →`** | Goes to *your delegation* |

> **2.23 is the one to actually perform.** The QR encoder is hand-written and was
> silently wrong twice during the build. A decoder test guards it now, but a real
> camera is an independent instrument.

---

## 3 · Your delegation — **window A** (the delegator)

| # | Do | Expect |
|---|---|---|
| 3.1 | Header | **`your delegation`** and a status of `active`. **No step counter** |
| 3.2 | Figures | `they may still spend`, spent-of-cap, `trading for` (B), `expires in`, `held by leash` |
| 3.3 | Freshness line | `read from the contract Ns ago` — the number rises, then resets on each poll |
| 3.4 | **`show the link again`** | Returns to the QR / link screen |
| 3.5 | **`end this delegation`** | Present **on this screen** — ending is an action here, not a separate step |
| 3.5b | **`set up another delegation`** | Also on this screen. Without it, resuming would trap you on your first mandate forever |
| 3.5c | Read the **`tradable now`** line | `N of M live markets`. If it says **`0 of M`** in red, that is correct and expected for any mandate more than a few minutes old |
| 3.5d | Click **`allow the markets trading now`** | One signature. Then the line becomes `M of M`, and the delegate can trade again. **Check the four limits above did not move** — this changes which markets, never how much |
| 3.6 | Turn wi-fi off ~30s | Line turns red: *the chain is not answering… stale*. Figures **stay**; no zeros appear |
| 3.7 | Wi-fi on, reload `/app?m=N` | Opens **directly on your delegation** — not back at step 1 |
| 3.8 | Now open **plain `/app`**, with no `?m=` at all | Still opens on your delegation. The app looks your newest mandate up **on the contract** by your address, and writes `?m=N` back into the URL |
| 3.9 | Close the tab entirely, reopen `/app` | Same — the delegation is on chain, so losing the link does not lose it |
| 3.10 | Click **`set up another delegation`** | Back to `step 1 of 4`, and `?m=` is **gone** from the URL. Your old delegation is untouched on chain |
| 3.11 | Reload once more | You are back on the **old** delegation, not the half-finished new one — nothing was created, so there is nothing newer to find |

---

## 4 · The delegate — **window B**

Switch windows here. Everything below happens in B, and B never opens the
delegator view.

| # | Do | Expect |
|---|---|---|
| 4.1 | Paste the link from 2.21 into window B | **One screen.** No step counter, and no `01 /` label above the heading |
| 4.2 | Find **`connect wallet`** | It is **on this screen**. You never touch window A |
| 4.3 | Connect | Shows **`trading as 0x5b92…`** |
| 4.4 | Envelope at the top | **`you may still spend`** with the real remaining budget |
| 4.5 | Pick a market | The row marks itself `trading` |
| 4.6 | Click **UP**, then **DOWN** | The selected one shows a **✓** — not colour alone |
| 4.7 | Drag size **above** the per-order cap, **`place order`** | `refused — bigger than the per-order cap.` |
| 4.7b | Look at the market rows | Any market the mandate does not name reads **`not on mandate`**, is greyed, and **cannot be selected**. You should never be able to pick one and then be refused |
| 4.8 | Drag the size back down | The refusal **clears as you drag** |
| 4.9 | Place a valid order | Tx hash + explorer link appears; status `placed` |
| 4.10 | Watch the envelope | Remaining **drops** within ~8s |
| 4.11 | Expand **`about this market`** | Opens in place; chart labelled *indicative price line — not a mandate figure* |
| 4.12 | Expand **`your orders`** | Opens in place; says payouts settle to the **delegator** |

> **4.9 will usually REST, not fill.** Binary books are quote-only — 4 of 17
> rehearsals filled. **Resting is a pass.** Do not say “filled” on camera.

---

## 5 · Negative cases — **window A unless a step says B**

| # | Do | Expect |
|---|---|---|
| 5.1 | `/app?m=abc` | A readable message about an unreadable id. **Page must not be dead** |
| 5.2 | `/app?role=delegate` with no `m` | **`no mandate on this link`** + how to get one. Never `reading the mandate…` |
| 5.3 | Go offline, reload `/` | First stat shows **`—`** and *chain unreachable* — **never `0.00`** |
| 5.4 | Offline, reload `/app`, reach step 2 | Markets report **failed** with a retry — not a spinner |
| 5.5 | Wallet on the wrong network | Topbar does **not** say `network ready` |
| 5.6 | In A, end the delegation; then place from B | `the delegator ended this delegation.` |
| 5.7 | From B, trade a market A did not allow | `refused — this market is not on the mandate.` |

---

## 6 · Mobile — a real phone, ~390px

| # | Expect |
|---|---|
| 6.1 | **Content in the first screenful.** Heading around 120px down, not 600 |
| 6.2 | **No horizontal scrolling on any screen** |
| 6.3 | The QR is large enough for a second phone to scan |
| 6.4 | Tapping the address field does **not** zoom the page in (an iOS habit when a font is under 16px) |
| 6.5 | Long errors **wrap** — never clipped mid-sentence |
| 6.6 | `viewing as` role switch sits at the **bottom** |

---

## 7 · Beat 3 — the timed one

| # | Do | Expect |
|---|---|---|
| 7.1 | `npm run ready` until `GO` | ttl 200–900s |
| 7.2 | `ARM=1 npm run demo-reset` | Seeds **and** subscribes; prints `ARMED subscription N` |
| 7.3 | Check the live column | `deadhand` reads `armed #N` |
| 7.4 | Close both browsers | Nothing is running |
| 7.5 | Wait for the market to resolve | `Deadhand` tx, `failed=0`, and `MandateRevoked(…, "deadhand")` |
| 7.6 | `npm run collect` | `sweepRefunds`, triggered by the **stranger** key. If the orders **rested** — which is the usual case — the delegator balance **rises**. If they filled, it pays 0 and the claim stays: see §8, that is expected, not a fault |
| 7.7 | `npm run disarm` | **Always.** ~15 STT/day while armed |

---

## 8 · Known-good — do not chase these

- **An order rests instead of filling.** Expected: 4 of 17.
- **`no market is open right now`.** The venue runs six at a time; 3 of 20
  rehearsals hit a gap. It is the venue, not us.
- **Refund claims outstanding while the registry holds 0.** `settleOne` books
  the whole escrow as refundable at resolution, and what happens next depends on
  whether the order ever traded:
  - **It rested** (the usual case) — the pool returns the escrow after a few
    minutes and `collect` pays it out in full. Measured: 11 mandates, 0.22
    tUSDC, cleared to zero.
  - **It filled** — the stake became an outcome position, and the registry has
    no interface to redeem one, so the claim never pays. Measured: 0.88 tUSDC
    across 32 filled mandates. `knownLimitations: no-redeem-path`.

  A single snapshot cannot tell these apart. Wait, run `collect`, look again.
  Either way nobody else's money is involved — the sweep returns only its own
  order's residual, so a stale claim strands nothing.
- **`held by leash` non-zero mid-order.** Correct while an order is open; it
  sweeps back in the same transaction.
- **`not checked yet`** on the allowed line, before the first on-chain check.

---

## 9 · The ones that actually matter

If you only do seven things:

1. **2.23** — scan the QR with a real camera
2. **4.2** — the delegate connects without leaving their own screen
3. **4.9 → 4.10** — place an order, watch the envelope drop
4. **3.8** — reload plain `/app` and land back on your delegation
5. **5.3** — offline shows `—`, never `0.00`
6. **3.5d** — re-point a stale mandate at the markets trading now, and confirm
   the four limits above it did not move
7. **7.5** — the `Deadhand` transaction with `MandateRevoked`

---

## Reporting

Note the **step number**. If something disagrees with this file, that is worth
knowing on its own — a checklist that is wrong about the product is worse than
no checklist.
