# Architecture

How Leash is put together, and why each piece is shaped the way it is. Written
for someone deciding whether to trust it, so the reasoning that produced each
decision is here alongside the decision — including the times the first answer
was wrong.

**Contents**

1. [The problem, stated precisely](#the-problem-stated-precisely)
2. [Why the obvious design is impossible](#why-the-obvious-design-is-impossible)
3. [System shape](#system-shape)
4. [Layer 1 — the registry](#layer-1--the-registry)
5. [The order path, step by step](#the-order-path-step-by-step)
6. [Custody: how the principal never rests here](#custody-how-the-principal-never-rests-here)
7. [Layer 2 — the deadhand handler](#layer-2--the-deadhand-handler)
8. [Why one subscription, and what it costs](#why-one-subscription-and-what-it-costs)
9. [The frontend](#the-frontend)
10. [Trust boundaries](#trust-boundaries)
11. [Verification as a build artifact](#verification-as-a-build-artifact)
12. [Known limitations](#known-limitations)

---

## The problem, stated precisely

Two people, one pot of money.

- **The delegator** owns the collateral. They want someone else to trade it, and
  they want to bound what that person can do without trusting them.
- **The delegate** trades. They want to demonstrate they *cannot* steal, because
  that is what makes anyone willing to let them trade at all.

The requirement is not "make theft unlikely". It is: **there must be no
transaction the delegate can send that moves the money anywhere except back to
the delegator.** Anything weaker is a promise, and promises are what the seed
phrase already offers.

---

## Why the obvious design is impossible

The obvious design is a session key: the delegator grants the delegate scoped
authority on the venue, and the venue enforces the scope.

**Event Contracts have no such surface, and this was established by measurement,
not assumption** — [`scripts/probe-a.ts`](../scripts/probe-a.ts), re-run on every
`verify.ts`.

`placeBinaryOrderFor` exists (selector `0x5d97c566`) and looks exactly like the
routing entry point you would want. It is gated by `OnlyApprovedContracts()`
(`0x3fb0ba2e`). The probe sent one identical order from three senders, varying
only the caller:

| Sender | Result |
|---|---|
| A stranger | `OnlyApprovedContracts()` |
| The would-be delegate | `OnlyApprovedContracts()` |
| **The pool owner, acting for itself** | `OnlyApprovedContracts()` |
| Same order via `placeBinaryOrder(self)` | Past authorization; failed on allowance |

The owner being rejected is the decisive case: it proves the gate is **caller
identity**, not parameters or permissions. No EOA can be granted routing
authority on a binary pool, and the spot `OperatorPermissionsRegistry` surface is
absent from the live binary implementation.

**So Leash could not wrap a permission system. It had to become one.** The
registry places orders *as itself* — a contract calling `placeBinaryOrder` on its
own behalf, needing no permission from dreamDEX, and giving the delegate no route
to the pool that bypasses it.

That inversion is the whole architecture. Everything below follows from it.

---

## System shape

```
  delegator (EOA)                                  delegate (EOA)
       │                                                  │
       │ 1. ERC-20 approve(registry, amount)              │ 2. placeForDelegator(...)
       │    — the ONLY signature they give                │    — signs their own tx
       ▼                                                  ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  MandateRegistry            immutable · no admin · holds nothing │
  │                                                                  │
  │   mandates[id]      delegator, delegate, per-trade cap,          │
  │                     cumulative cap, used, expiry, revoked        │
  │   allowedMarket[id][marketId]                                    │
  │   reservations[pool|orderId]  → what to release at settlement    │
  └───────┬─────────────────────────────────────────┬────────────────┘
          │ 3. transferFrom → approve → place       │ 5. settleFinalizedMarket
          │    → sweep residual, ALL one tx         │    (permissionless)
          ▼                                         ▲
  ┌──────────────────────┐                ┌─────────┴───────────────┐
  │ dreamDEX binary pool │                │  DeadhandHandler        │
  │ placeBinaryOrder     │                │  onEvent, msg.sender    │
  └──────────┬───────────┘                │  MUST be 0x0100         │
             │ 4. market resolves         └─────────▲───────────────┘
             ▼                                      │
   BinaryMarketsModule ── MarketFinalized ──────────┘
   0x3ecC694C…                          Somnia validators, one subscription
```

The delegator appears once, at step 1, and never again. Steps 3 through 5 happen
without them — including the one that pays them.

---

## Layer 1 — the registry

[`contracts/src/MandateRegistry.sol`](../contracts/src/MandateRegistry.sol) is
the product. It is immutable, has no admin role, and holds no funds at rest.

A **mandate** is what the delegator signs into existence:

```solidity
struct Mandate {
    address delegator;              // the only address money can return to
    address delegate;               // the only address that may trade it
    uint128 maxStakePerTrade;       // per-order ceiling
    uint128 maxCumulativeExposure;  // total ever committed
    uint128 usedExposure;           // reserved at PLACEMENT, not at fill
    uint64  expiry;
    bool    revoked;
    bool    exists;
}
```

Two details carry more weight than they look:

**`usedExposure` counts at placement, not at fill.** A resting order has not
spent anything yet, but it *could*. Counting at fill would let a delegate stack
unlimited resting orders inside a cap that only tightens when they cross. Budget
is committed when the risk is taken.

**Everything is keyed by `marketId`, never by pool address.** Pools are recycled
across market windows — `PoolRecycled` fires in the same transaction as
finalization — so a mandate keyed on a pool would silently begin governing a
different market. `reservations` is keyed by `pool|orderId` because order ids are
only unique within a pool, and `marketAddressOf` is bound on first use by reading
the pool rather than trusting the caller.

### What the delegator can change afterwards

Only one thing: **which markets**, via `setMarkets`. Not an admin power — it is
callable only by that mandate's own delegator, and both a stranger and the
delegate revert `NotDelegator`.

It exists because Event Contract markets resolve in **2–12 minutes** while the
allowed set was written once at creation, so a mandate whose expiry read "7 days"
had nothing left to trade within minutes and refused every order. It is
symmetric — the delegator can narrow as well as widen, because an allow-list that
only grows is a weaker promise — and it moves **no money limit**. The per-trade
cap, the cumulative cap and the expiry are immutable for the life of the mandate,
with tests that say so.

---

## The order path, step by step

Everything happens in one transaction, signed by the delegate. Line numbers are
[`MandateRegistry.placeForDelegator`](../contracts/src/MandateRegistry.sol#L298).

1. **Authorize** — caller is the named delegate (L309); not revoked (L310); not
   expired (L311); market is on the mandate (L312).
2. **Price the risk** — worst-case cost of the order, checked against the
   per-trade cap (L319) and the cumulative budget (L322).
3. **Commit exposure before any external call** (L326). Effects before
   interactions, so a reentrant call sees the reserved figure rather than a stale
   one.
4. **Record the balance before touching anything** (L335). This is what makes the
   sweep attributable — see below.
5. **Pull just-in-time** (L338). Until this instruction the principal is in the
   delegator's wallet.
6. **Place as the registry** (L342), then revoke the pool's allowance.
7. **Make a silent rejection loud** (L348). `placeBinaryOrder` returns
   `(bool success, uint128 id)` and a `false` does **not** revert — a mined
   transaction can be a rejection. The client simulates first; this is the
   on-chain half of the same guard.
8. **Reserve** what to release later, keyed by `pool|orderId`, and bind
   `marketId` to its market address by reading the pool.
9. **Sweep the residual home** (L383–L386).

---

## Custody: how the principal never rests here

The custody claim is not "we are careful with your money". It is that there is no
state in which the money is ours.

Between step 5 and step 9 — inside one transaction — the registry holds the
collateral. Before and after, it holds nothing. The sweep is what closes that
window, and its design took two attempts.

**The version that was wrong.** `_sweep(to)` returned
`balance - (totalOwed + totalRefundClaim)`: everything above a global floor, on
the assumption that anything unaccounted for belonged to the caller. It does not.
The floor was one term short — it omitted refund claims — so **one delegator's
booked refund left with another delegator's order**. Misattribution, not
stranding: the money went to the wrong party, and the claim stayed on the books
unbacked.

Worse, the invariant that was supposed to catch it could not. `holdsNoFunds()`
asserts `balance <= owed + claims`, so a misallocation *lowers* the balance and
the check passes **more easily the worse the bug gets**.

**The version that is right.** `placeForDelegator` records the balance before it
pulls, and returns exactly what that transaction brought in and the pool declined
to take, capped at the order's own cost. Money already in the contract is
untouched **by construction**, not by arithmetic anyone has to keep correct. A
floor that must enumerate every claim anyone holds on the contract, forever, is
the wrong shape — so it is gone rather than repaired.

The test for this fails against the old sweep with an *arithmetic underflow*,
because the delegator ends up with more than they spent.

### Two views, and the difference between them

- **`holdsNoFunds()`** — the ceiling. Nothing here is unattributed.
- **`claimsAreBacked()` / `unbackedClaims()`** — the floor, published as a
  **reading, not a guarantee**. Settlement books a claim while the pool still
  holds the proceeds, so it is legitimately false for minutes at a time.

Publishing the second as an invariant would claim something the contract does not
deliver. What *is* invariant, and has its own test: a third party's order never
widens the gap.

---

## Layer 2 — the deadhand handler

[`contracts/src/DeadhandHandler.sol`](../contracts/src/DeadhandHandler.sol)
subscribes to `MarketFinalized` on the binary markets module. When a market
resolves, Somnia validators invoke `onEvent` and the handler settles every
affected mandate in that block: releasing exposure, revoking any mandate in
breach, and sweeping released collateral to the delegator.

**It cannot be forged.** `onEvent` enforces `msg.sender == 0x0100` — the
reactivity precompile — in the base contract. Not by us, not by a competitor.
`verify.ts` proves it by calling `onEvent` from an ordinary EOA and asserting the
revert. That is what makes "the validators did it" checkable rather than
asserted.

**It is deletable, and that is a design requirement.** Everything the handler
does calls a *permissionless* registry entry point. The registry contains no
reference to a handler; its deployed bytecode does not carry the address. Delete
the handler and the subscription, and the app still works — a stranger key can
call `settleFinalizedMarket` directly, which is tested live on every run,
including draining a 32-mandate market in slices.

**The batch is bounded, and the bound is measured.** Validator callbacks run
under a gas budget you do not control; an unbounded loop is a silent no-op in
production. The cap comes from real invocations on the deployed bytecode:

| n | Result |
|---|---|
| 3 | 1,550,679 gas |
| 12 | 3,302,336 gas |
| 32 | **out of gas** — `DeadhandFailed`, nothing settled |

That fits ~966,795 fixed + ~194,628 per mandate, which predicts 7.19M at n=32 —
but the real cost exceeded ~7.89M, so **the line under-predicts at high n by at
least 10%**. It is the second time a fit here has erred in the dangerous
direction. The cap ships at **17**, not the fitted ceiling of 35, and
`verify.ts` fails if a cap ever rests on a single measurement, because one batch
size cannot separate fixed cost from marginal.

---

## Why one subscription, and what it costs

dreamDEX ships `SpotStopOrderRegistry`, which also subscribes to the precompile
and acts on events. The similarity is real and the difference is structural:

**Their event is per-user. Ours is shared.** A price threshold belongs to one
account — your stop is not my stop — so funding is per user per order
(`createPendingOrder` is `payable`). A market *resolution* belongs to everyone on
that market: every mandate resolves in the same block. One subscription can
therefore serve every delegation, and theirs structurally cannot.

**And the action is not an order.** It is a permission change plus a payout to a
party who never traded. A stop-order registry has no vocabulary for that.

**What it costs, stated honestly.** Ignoring a finalization that is not ours costs
**0.00174709 STT** — measured twice, twenty minutes apart, identical to the wei.
That is ~15.1 STT/day to sit armed, so the subscription is armed for demo windows
and unsubscribed after. The argument is about *shape*, not price: O(1)
subscriptions against O(users × orders). Charging is on gas **used**, not
`gasLimit`, which is why the wide limit the batch needs is free.

---

## The frontend

[`apps/web/`](../apps/web) — TypeScript and viem, no framework. One bundle serves
a landing page and the app; the app serves both roles.

**Every limit on screen is read from the contract.** The delegator's draft values
during setup are explicitly *not* the mandate — until `allowedMarket` has been
read for a real mandate id, the UI says `not checked yet` rather than showing the
draft.

Three pieces of state discipline that each came from a real failure:

- **Freshness is computed, never asserted.** Reads are stamped from when the read
  *started*, not when it landed, so a response 40 seconds in flight cannot report
  itself as current. A poll that fails leaves the previous figures on screen and
  marks them stale.
- **Loading, empty and failed are three different renderings.** They were once one
  string, which made a quiet venue and a broken RPC indistinguishable.
- **Identity changes are followed.** The app listens for `accountsChanged`;
  without it, switching MetaMask to the delegate left the app acting as the
  delegator and simulating the delegate's order as the wrong party.

The markets screen reads the venue's own question text, strike, trading window,
fees and settlement address from `MarketCreated` and `getBinaryPoolParams` —
data that discovery already fetched and used to discard. It shows **no price**,
because there is none to read: `getBookLevels` reverts on binary pools and
`BinaryOrderPlaced` carries no price. It used to draw a hardcoded twelve-point
sparkline; that is deleted, and `verify.ts` asserts no fabricated series can
return.

---

## Trust boundaries

| Party | What they can do | What stops them |
|---|---|---|
| **Delegate** | Place orders within the mandate | Every limit is checked in the order path, and there is no path around it — no EOA can reach the pool through the registry any other way |
| **Delegate** | Move money | Nothing to call. The registry has **no `withdraw` selector at all** |
| **Delegator** | Revoke, or re-point markets | Immediate and unilateral; also revocable by dropping the ERC-20 allowance, which needs no knowledge of Leash |
| **Us** | Nothing privileged | No admin key, no upgrade path, no pause. Verified against deployed bytecode |
| **Handler owner** | Manage the subscription, withdraw the 32 STT floor | Cannot touch mandates or collateral; the registry does not know the handler exists |
| **Validators** | Invoke `onEvent` | Only the precompile at `0x0100` can; enforced in the base contract |
| **Anyone** | Settle a resolved market, sweep refunds to their owner | Permissionless by design — it is what makes Layer 2 deletable |

The delegator's ERC-20 allowance is the outer boundary and the most important
one: it is a lever they already understand, and it works whether or not they ever
read a line of this repo.

---

## Verification as a build artifact

[`scripts/verify.ts`](../scripts/verify.ts) is 34 checks that run against the
**live deployment**, not against the code. It exists because this build produced
four separate green checks that certified behaviour the real system did not
exhibit — every time, the assertion was sound and the thing it ran against was a
mock.

Three rules came out of that, and they are enforced structurally:

1. **Provenance is keyed by code hash.** [`claims.json`](../claims.json) records
   what each measurement was taken *from*. When the deployed bytecode moves,
   `verify.ts` reports amber rather than green — a measurement that outlives its
   build is a fact about another program.
2. **Check the conclusion, not the ingredients.** A verifier that asserts the
   inputs exist will pass while the output is wrong. The batch-cap check once did
   exactly that: green with a cap of 32 while the fit implied 15.
3. **Never print a verdict that is not computed.** A status line that can print
   without checking will eventually lie. Two did — both are now derived, and both
   say how to tell two similar-looking states apart rather than asserting which
   one you are in.

The suite also asserts things about *itself*: that no user-visible string claims
a property without a named backing, that no new silent `catch` appears without
review, and that no commit message carries an attribution trailer.

---

## Known limitations

Stated here rather than left for a judge to find. The machine-readable versions
are in `claims.json` under `knownLimitations`.

- **No redeem path.** A filled order's stake becomes an outcome position, and the
  registry's pool interface has only `placeBinaryOrder` and `cancelOrder`. A
  winning position is never converted back to collateral. Unfilled escrow returns
  and pays out normally; this only affects fills, and binary books are quote-only.
- **`claimsAreBacked()` is a reading, not an invariant** — false while proceeds
  are in flight, and permanently for filled positions per the point above.
- **The batch cap is conservative on purpose.** 17 against a fitted ceiling of 35,
  because the fit under-predicts at high n and an out-of-gas invocation settles
  nothing at all.
- **One hour is the venue's horizon ceiling.** Not a Leash constraint — mandates
  are keyed by `marketId`, never by duration — but it is what exists today.
- **Testnet only.** Mainnet has different collateral decimals (18 vs 6) and is
  out of scope for this submission.
