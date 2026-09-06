# DEMO — script and rehearsal log

Target **2:30**, hard ceiling 3:00. Every number and every sentence below is
what the rehearsals actually produced, not what we hoped they would.

**The sentence the whole thing exists to earn:**

> *"Nobody was running anything — the validators revoked him, and paid the
> delegator back."*

---

## Before you record

```bash
npx tsx scripts/verify.ts        # must be 32/32. If red, do not record.
npx tsx scripts/demo-reset.ts    # clean state, seeded mandates, one market
npx tsx scripts/collect.ts       # drain any outstanding refund claims first
```

`demo-reset` now **refuses** to seed onto a market that already carries open
reservations. That is not fussiness: leftover reservations from a previous take
inflate `pending`, the batch clips at the cap, and beat 3 shows a *partial*
settle on camera — which reads as the Deadhand not working.

**Timing constraint, measured.** The venue runs **six live markets at a time**:
BTC and ETH, in a 60s, a 300s and a 3600s window. The 300s series is the only
one that gives a full three-beat cycle in minutes, and setup takes ~50s, so it
is usable only in roughly the **first half of its five-minute life**. If
`verify.ts` reports "no tradable market", that is the venue, not us — wait for
the next window.

---

## The script

### 0:00 — 0:20 · The problem

> "If you want someone to trade for you, there is one rail: send them your keys.
> Leash is for the person who wants to prove they *can't* steal."

Show the landing page. The `held by leash` figure is read from the deployed
registry, live.

### 0:20 — 0:50 · Beat 1 — can't take

Delegate's browser. Attempt to revoke the delegator's own mandate.

> "This is the delegate's key. It cannot move the money. Not 'we ask it not
> to' — the registry has no withdraw function at all, and this reverts on our
> own authorization check."

**Show the reverted transaction on the explorer.** Status 0, `NotDelegator`.
Real transaction, real revert — not a frontend message.

### 0:50 — 1:25 · Beat 2 — can trade

Same key, same second. Place an order.

> "Same key. It places a real Event Contract order on dreamDEX, drawing on an
> allowance — the delegator has signed nothing but an ERC-20 approve. The money
> is pulled and swept back inside this one transaction. It was never ours."

**Say "placed", never "filled".** Measured: binary books on this testnet are
quote-only — 161 orders produced 1 fill in ~100 seconds, while 35 fills happened
on spot and perp pools in the same window. Both sides are posted and they do not
cross. **Every rehearsal rested.** Claiming a fill invites the one correction we
cannot recover from mid-demo.

What to point at instead: `BinaryOrderPlaced` in the receipt, and the mandate
meter above the ticket ticking down — read from the contract, not from the page.

### 1:25 — 2:10 · Beat 3 — can't overreach

The delegate's order outlives the mandate that authorised it. Close both
browsers.

> "Now nobody is running anything. Both windows are shut."

When the market resolves:

> "Validators saw the resolution and invoked our handler in that block. One
> subscription, every delegation. It settled the affected mandates, released the
> exposure, and revoked the one that breached."

**Show the `Deadhand` transaction.** `processed`, `failed=0`, and
`MandateRevoked(…, "deadhand")`.

> "Nobody could have faked that. `onEvent` requires the caller to be the
> reactivity precompile — not us, not a competitor."

### 2:10 — 2:30 · The money

Run `scripts/collect.ts` — **from the stranger key**.

> "The collateral goes back to the delegator, and anyone can trigger it. This is
> a wallet with no relationship to the mandate at all. The delegator doesn't
> depend on the delegate, and doesn't depend on us."

**Show a `sweepRefunds` transaction and the delegator's balance rising.**
Measured on the first real run: **10 mandates paid, 8.04 tUSDC to delegators, by
a party who never traded.**

> "Money moved to the person who is not the trader. A stop-order registry has no
> vocabulary for that."

---

## Two things not to say

**"And it's nearly free."** It is not. A skip costs 291,181 gas
(0.001747086 STT), about 15.1 STT/day armed. The argument is **shape, not
price**: one subscription regardless of how many delegations exist, against a
model that funds one per user per order.

**"The order filled."** See beat 2.

## If it breaks on stage

| Symptom | Say this, then cut to the recording |
|---|---|
| No tradable market | "The venue runs six markets at a time and we're between windows" — true, and checkable |
| Order rests, no fill | Expected. Beat 2 does not depend on a fill |
| Market doesn't resolve in the window | Finalization is punctual (±60s, up to 300s early) but the window is the venue's, not ours |
| Handler doesn't fire | `seen[marketId]` on the deployed handler answers *why* in one call: `0` means it was never delivered, non-zero means it was delivered and skipped |

The recorded backup video removes every one of these. **Cut it before you need
it.**

---

## Rehearsal log

Harness: `npx tsx scripts/rehearse.ts` (`RUNS=20`). Full outcomes in
`.measurements/rehearsals.json`. It hunts one specific failure — `status = 1`
with nothing traded and no order resting — because `ec-core` has no guard
against it on the binary path and it looks like success.

| | |
|---|---|
| Runs completed | 14 of 20 at time of writing |
| Full three-beat passes | **14 / 14** |
| Beat 1 reverted on chain | 14 / 14 |
| Beat 2 accepted by the venue | 14 / 14 |
| Beat 2 **filled** | **1 / 14** — possible, not scriptable |
| Beat 3 settled and revoked | 14 / 14 |
| `seen[marketId]` after settle | `1`, every run — H1 has not recurred |
| Silent rejections | **0** |
| Handler gas per invocation | 945,766 – 1,028,680 (2-mandate batches) |

### What the rehearsals changed

- **Beat 2's wording.** It was written as "an order that fills". Fourteen runs
  produced exactly one fill, and a venue-wide measurement explains why.
- **Beat 3's payout leg was never running.** Settlement books a refund; the
  venue does not push collateral back until someone calls
  `cancelExpiredOrders`. Nobody was, so `totalRefundClaim` had reached 11.42
  tUSDC against a registry balance of 0. `collect.ts` runs both legs.
- **A real bug, disclosed not fixed.** `_sweep` keeps only `totalOwed`, so one
  delegator's booked refund can be swept to another delegator by their next
  order. Unreachable in a single-delegator demo; real in a multi-delegator
  deployment. See `knownLimitations` in `claims.json`.
