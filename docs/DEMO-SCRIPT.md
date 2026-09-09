# Demo script — shot by shot

**Runtime 2:30, hard ceiling 3:00.** Twelve shots. Every number spoken here was
measured on the deployed build; nothing in the voiceover is aspirational.

**The sentence the whole demo exists to earn:**

> *"Nobody was running anything — the validators revoked him, and paid the
> delegator back."*

**Contents:** [Setup](#setup-before-you-record) · [The shots](#the-shots) ·
[Never say](#two-things-never-to-say) · [If it breaks](#if-it-breaks-on-stage)

---

## Setup before you record

```bash
npx tsx scripts/verify.ts     # 34 checks. Anything RED, do not record.
npm run ready                 # GO / WAIT / STOP — needs a market with ttl 200–900s
npm run collect               # push any outstanding refunds to delegators
ARM=1 npm run demo-reset      # seed AND subscribe
#   ... record ...
npm run disarm                # ALWAYS — ~15 STT/day while armed
```

Three things that decide whether the recording is possible at all:

- **`ARM=1` is not optional.** Seeding does not subscribe, and without a
  subscription validators never invoke the handler. Beat 3 simply does not
  happen, which on camera reads as the Deadhand failing rather than as nobody
  having switched it on.
- **Pick the 300-second market series.** Setup takes ~50s, so a 60s market is
  gone before you are ready and an hour-long one outlasts the demo. `ready`
  prints the ttl.
- **Two browser profiles**, not two tabs. One MetaMask profile exposes one
  account, so two tabs are the same identity. (The app follows `accountsChanged`
  if you do switch, but two profiles keep both sides on screen.)

---

## The shots

### Shot 1 · 0:00–0:12 · The problem
**On screen:** the landing page, top of the fold.

> "If you want someone to trade for you, there's one rail today: send them your
> keys. Leash is for the person who wants to prove they *can't* steal."

---

### Shot 2 · 0:12–0:22 · The live figure
**On screen:** scroll to the stat row. Point at `held by leash`.

> "That number is read from the deployed registry every block. Not a screenshot —
> if the chain doesn't answer, it shows a dash instead of a zero."

*Why this shot:* it establishes early that figures on screen come from chain,
which is the claim everything later depends on.

---

### Shot 3 · 0:22–0:38 · The mandate
**On screen:** delegator window. The review step, with the four limits visible.

> "The delegator sets four limits — per order, total budget, which markets, and
> an expiry. Then they sign twice: an ERC-20 approve, and the mandate itself.
> That's the last time they touch this."

---

### Shot 4 · 0:38–0:50 · The handoff
**On screen:** the issue step — QR code and link.

> "The delegate gets a link. It carries no key and no permission by itself. The
> permission lives on chain."

*Optional, strong if time allows:* scan the QR with a phone on camera.

---

### Shot 5 · 0:50–1:08 · Beat 1 — can't take
**On screen:** delegate window. Attempt to revoke the delegator's mandate.

> "This is the delegate's key. It cannot move the money — and not because we ask
> it nicely. The registry has no withdraw function at all. There's no selector to
> call."

**Cut to the explorer.** Status **0**, `NotDelegator`.

> "That's a real transaction, mined and reverted on our own authorization check.
> Not a message in the frontend."

---

### Shot 6 · 1:08–1:30 · Beat 2 — can trade
**On screen:** delegate window. Pick a market, pick a side, place.

> "Same key, ten seconds later. It places a real Event Contract order that
> dreamDEX accepts — drawing on an allowance the delegator can revoke at any
> moment. The delegator has signed nothing but an approve."

**Cut to the receipt.** Point at `BinaryOrderPlaced`.

> "The money is pulled from their wallet and swept back inside this one
> transaction. It was never ours."

⚠️ **Say "placed". Never say "filled".** See [below](#two-things-never-to-say).

---

### Shot 7 · 1:30–1:40 · The limit that refuses
**On screen:** drag the size above the per-order cap, press place.

> "And when it exceeds the mandate, the contract refuses it — by name."

**On screen:** `refused — bigger than the per-order cap.`

*Why this shot:* it is the cheapest possible proof that the limits are real, and
it costs ten seconds.

---

### Shot 8 · 1:40–1:52 · Nobody is running anything
**On screen:** close both browser windows. Show an empty desktop.

> "Now here's the part that isn't a UI. Both windows are shut. No server, no
> bot, no keeper. Nobody is running anything."

*Hold this shot longer than feels comfortable.* It is the setup for the whole
claim.

---

### Shot 9 · 1:52–2:10 · Beat 3 — the validators act
**On screen:** the `Deadhand` transaction on the explorer.

> "The market resolved. Somnia's validators saw it and invoked our handler in
> that same block — one subscription, serving every delegation. It settled the
> affected mandates, released the exposure, and revoked the one that breached."

**Point at:** `processed`, `failed=0`, and `MandateRevoked(…, "deadhand")`.

> "And nobody could have faked this. `onEvent` requires the caller to be the
> reactivity precompile at 0x0100 — not us, not a competitor."

---

### Shot 10 · 2:10–2:24 · The money moves
**On screen:** run `npm run collect` — **from the stranger key** — then the
delegator's balance.

> "The collateral goes back to the delegator. And anyone can trigger it — this
> is a wallet with no relationship to the mandate at all. The delegator doesn't
> depend on the delegate, and doesn't depend on us."

**Show a `sweepRefunds` transaction and the balance rising.**

---

### Shot 11 · 2:24–2:30 · The sentence
**On screen:** the reverted withdrawal and the Deadhand transaction, side by
side.

> "Nobody was running anything. The validators revoked him, and paid the
> delegator back. A stop-order registry fires an order for the account that armed
> it — it has no vocabulary for paying someone who never traded."

---

### Shot 12 · closing card
**On screen:** repo URL, live app URL, and:

```
npx tsx scripts/verify.ts     — 34 checks against the live deployment
```

> "Every claim in the README is checked by one command against the deployed
> contracts. Including the ones that are still amber."

---

## Two things never to say

**"The order filled."**
Binary books on this testnet are quote-only. Measured over ~100 seconds: **161
orders on binary pools produced 1 fill**, while 35 fills happened on spot and perp
pools in the same window. Both sides are posted — 55% BUY_YES, 45% SELL_YES — and
they do not cross. **Thirteen of fourteen rehearsals rested.** A fill is
possible; scripting around it is a coin flip with poor odds, and claiming it
invites the one correction you cannot recover from mid-demo.

Point at `BinaryOrderPlaced` in the receipt and the mandate meter ticking down.
Beat 2 does not depend on a fill.

**"And it's nearly free."**
It is not. Ignoring a finalization that is not ours costs **0.00174709 STT** —
measured twice, twenty minutes apart, identical to the wei — which is about
**15.1 STT/day** to sit armed. The argument is **shape, not price**: one
subscription regardless of how many delegations exist, against a model that funds
one per user per order.

---

## If it breaks on stage

| Symptom | Say this, then cut to the recording |
|---|---|
| No tradable market | "The venue runs a handful of markets at a time and we're between windows." True, and checkable in one query |
| Order rests, no fill | Expected. Beat 2 does not depend on a fill — point at `BinaryOrderPlaced` |
| Deadhand didn't fire | Check `disarm` wasn't left on from the last run. If the subscription is cold, say so plainly and show the previous transaction |
| A market on the mandate has closed | Use `allow the markets trading now` on the manage screen — it re-points a live mandate and changes no spending limit |
| `verify.ts` amber on `delegators-paid` | Expected. It is filled positions the registry cannot redeem, documented in `knownLimitations` |

The recorded backup exists for exactly this. Cutting to it is not a failure; a
correction mid-demo is.
