# The four adversarial questions

Answered in writing, as Stage 5 requires, on 6 Sep against the deployed build.
Written to be read by someone trying to break the submission, not to reassure
anyone. Where the honest answer is "this is a real weakness", it says so.

Registry `0x105e7732DE6D2E8C43e5803F8Df0D2d4860E7679` ·
handler `0x66D1D983e89a7eCb4bCFf535A348C59086B686Ad`

---

## 1. Where does the demo depend on something we can't control?

Four places, in descending order of how likely they are to bite.

### (a) A market has to resolve, on camera, inside the demo window

Beat 3 needs a real `MarketFinalized`. We cannot make one happen. Measured
constraints:

- The venue runs **exactly six live markets at a time** — BTC and ETH, in a
  **60s**, a **300s** and a **3600s** window. That is the whole venue, not a
  sample: three independent discovery sweeps over 10, 30 and 80 windows each
  returned the same six.
- Finalization is **punctual**: over 40 finalizations matched to their
  `MarketCreated` expiry, min −300s, median 0s, max +60s. An earlier note
  claiming it "lags unpredictably" was wrong and was retracted — the late runs
  were our own setup time.
- Seeding a 3-mandate rehearsal takes ~50s, so the 300s series is usable only in
  roughly the **first half of its five-minute life**. At the wrong moment there
  is no usable market and the correct behaviour is to wait, not to fail.

**MEASURED ACROSS THE REHEARSAL SET, and this is the sharpest version of the
risk.** Two runs out of eighteen failed with `no-window` — and on one of them
the venue offered **no short-series market at all**: the only live ttls were
3,049s and 13,849s. The 60s and 300s series were simply absent for that stretch.

So the failure is not "we timed it badly". It is that **the market the demo
needs does not always exist**, and when it doesn't there is nothing to wait a
few seconds for.

**Mitigation:** `rehearse.ts` reports `no-window` as an outcome distinct from a
failure, and `verify.ts` says "no tradable market" rather than blaming the RPC.
Practically: check `verify.ts` immediately before recording, and if the short
series is missing, wait for it rather than starting.

**Residual risk: real and unmitigated.** If the venue stops creating short
markets during the recording window, beat 3 cannot be demonstrated live. The
recorded backup video is the only answer, which is why it is non-negotiable.

### (b) The public RPC

Two failures already observed, both on our critical path:

- **A single `eth_call` timeout killed a 50-minute measurement run** and left a
  subscription armed, because the same outage that broke the run also broke the
  unwind. Now: progress reads retry and tolerate failure (`poll` returns null,
  distinguishable from reading a zero), and the unwind retries with backoff.
- **`eth_getLogs` does not honour topic filters on this endpoint.** Verified with
  the probe pattern: a request for a `topic0` matching nothing returned the same
  3 logs as the correct hash. `viem`'s `getLogs({ event })` re-filters
  client-side and was never wrong; a raw `client.request` has no such
  protection, and `doctor.ts` used one.

**Mitigation:** no third party sits between opening the app and placing an
order — discovery reads `MarketCreated` straight from the module singleton, and
`verify.ts` asserts both that no shipped file names an indexer host and that
discovery *throws* against a dead RPC rather than reporting an empty venue.

### (c) The book

We price takers to the top of the range because a taker is charged the **fill**
price, not the price it offered — aggression is free and it removes the
stale-book failure mode. A bid priced 3 cents through a 0.515 ask still rested
with zero fills once, because the quote was gone by inclusion.

**MEASURED: binary books are quote-only.** Over ~100 seconds venue-wide, 161
orders on binary pools produced **1 fill**, while 35 fills landed on spot and
perp pools. Both sides are posted — 55% BUY_YES, 45% SELL_YES, zero on the NO
side — and they do not cross each other. Across the rehearsal set, a small
minority of runs filled.

**Residual risk: handled by not claiming it.** `rehearse.ts` records `filled`
and `rested` separately rather than calling a rest a pass, and the demo script
says "placed". Beat 2 proves the authorization and just-in-time custody path,
which is ours; a counterparty showing up is not.

### (d) Our own gas

`placeForDelegator` costs ~0.028 STT. The delegate key ran out mid-session once
and surfaced as an opaque `Missing or invalid parameters`. `verify.ts` now fails
when the delegate is under a floor sized for a full rehearsal set, and
`rehearse.ts` checks the budget **before run one**.

---

## 2. Where would a dreamDEX engineer say "you rebuilt SpotStopOrderRegistry"?

This is the question the submission most deserves to be attacked on, because the
surface similarity is real: both subscribe to the `0x0100` precompile, both act
on chain events, both are permissionless to trigger.

**The honest version of their case.** `SpotStopOrderRegistry` watches
`MarkPriceUpdated` and fires an order. We watch `MarketFinalized` and call a
registry function. Squint, and that is one pattern with two event names.

**Why it does not hold, in the order the differences matter:**

1. **The beneficiary is not the trader.** Their registry fires an order *for the
   account that armed it*. Ours performs a permission change and sweeps a payout
   **to the delegator — a party who never traded**. A stop-order registry has no
   vocabulary for returning funds to a third party, and that is structural, not
   a missing feature.
2. **The action is not an order.** `settleFinalizedMarket` releases exposure,
   revokes breached mandates, and books refunds. Nothing it does is a trade.
3. **One subscription, N beneficiaries.** `createPendingOrder` is `payable` and
   charges `somiPaymentPerOrder()` — funding is **per user per order**. Ours is
   one subscription serving every delegation, and measured settling **3 and 12
   mandates in single validator invocations**, `drained=true` both times.

**The reason the shapes differ is not cleverness, it is the event.** A price
threshold is inherently per-user: your stop is not my stop. A resolution is
inherently *shared* — every mandate on that market resolves in the same block.
That is why one subscription can serve all of them and theirs structurally
cannot.

**What we must NOT say.** "And it is nearly free." That was true of a probe
handler and is false of the shipped one: a skip costs **291,181 gas
(0.001747086 STT)**, about **15.1 STT/day** to sit armed. The argument is about
**shape, not price** — O(1) subscriptions against O(users × orders). Any
price-based version of this argument invites a correction we would deserve.

---

## 3. Which limit is enforced in the frontend while we claim it's on-chain?

**None — and this is asserted, not asserted-by-assertion.**

Every limit is checked inside `placeForDelegator` before any collateral moves
([MandateRegistry.sol:264-327](../contracts/src/MandateRegistry.sol#L264-L327)),
and the delegate has no route to the pool that bypasses it, because no such
route is grantable: `placeBinaryOrderFor` is gated by `OnlyApprovedContracts()`
and rejects **even the owner acting for itself** (Probe A, three senders, raw
`eth_call` data).

The frontend's own honesty is checked by `verify.ts`:

- **`assertive-copy`** — every user-visible string claiming a property must be
  computed from a check or listed with what backs it. It found six on its first
  run that had been written by hand and not vetted.
- **`onscreen-figures-are-chain-derived`** — a negative test. `readHeld` (the
  *shipped* function, called by verify rather than reimplemented) must return an
  em dash against a dead RPC, never a confident `0.00`.

**Two places where this was genuinely broken until this week, both now fixed:**

- The monitor screen printed *"every figure above is read from the contract"*
  **unconditionally**, while a failed poll left the previous read on screen with
  nothing marking it stale. Both roles now render their own read age.
- The delegate's market screen printed *"allowed"* from the **draft** market set
  before the mandate had been checked on chain. It now says "not checked yet".

**The one deliberate exception, declared:** the price line on `market_detail` is
decorative and labelled *"indicative price line — not a mandate figure and not
read from chain."* It ships under an explicit, recorded override of the
read-only-mirror rule. A chart may be decorative; nothing that looks like a
mandate limit may be.

---

## 4. What breaks if dreamDEX ships an upgrade?

**Not hypothetical.** Binary pools were already upgraded once inside this
hackathon: live pools are **beacon proxies**, and the beacon resolves to an
implementation different from the one `ec-core` bundles as "verified
2026-07-24". We resolve through the beacon and never scan a bundled address.

What breaks, by blast radius:

| If they change | Effect | Why we survive, or do not |
|---|---|---|
| `MarketFinalized`'s topic0 or shape | **Beat 3 stops.** Handler stops being invoked, or decodes garbage | Topics are **pinned AND derived**, and boot fails loudly on disagreement. The handler's shape check increments `skippedShape` rather than silently proceeding. `seen[marketId]` distinguishes "never delivered" from "delivered and skipped" |
| `placeBinaryOrder`'s signature | **Beat 2 stops.** Orders revert | Fails loudly at the revert. No silent path |
| Pool implementation behind the beacon | Probably nothing | We resolve through the beacon at runtime |
| Pool recycling behaviour | Nothing | Every mandate is keyed by `marketId`, never by pool address. A pool that served our market a minute ago may now serve a different one, and `tradableMarkets` compares `params.market` to catch exactly that |
| Collateral token or its decimals | Mispriced limits | `decimals()` is read, never assumed — testnet is 6dp tUSDC while mainnet EC is 18dp, so this genuinely differs by network |
| `OnlyApprovedContracts` opening up | Nothing breaks; a better path appears | We would still not need it. The registry places as itself |

**The structural answer.** `MandateRegistry` is immutable and admin-free by
choice, so we cannot hot-patch a venue change — and that is the correct
trade. The mitigation is that **Layer 2 is deletable**: if reactivity breaks,
`settleFinalizedMarket` is permissionless and the delegator (or anyone) calls it
directly. Proven live, from a stranger key with the handler unsubscribed and not
in the path.

**The honest residual.** If `placeBinaryOrder` changes signature mid-demo, we
have no live order path and no way to patch an immutable contract. We would ship
the recorded video and say so. That is the price of having no admin key, and it
is a price worth paying for a product whose entire claim is that nobody can
reach in.

---

## Open hypothesis carried into Stage 5

**H1 — 474 invocations, zero settles** (observed on the previous handler
deployment, `0xDED8c0bE…`).

- **H1a** — our market's `MarketFinalized` never reached the handler.
- **H1b** — it reached the handler and the `pendingSettlement == 0` early exit
  swallowed it.

**Distinguishing test:** `seen[marketId]` on the deployed handler, recorded
*before* the handler decides anything. Zero after a finalization we watched for
is H1a; non-zero with no settle is H1b.

Note that `invocations` never separated these — it counts every delivery, not
the delivery of *our* market — and neither would a plain skip counter, which is
already `invocations − marketsSettled`.

**Status: not reproduced, not retired.** Two runs on the current build, both
`seen == 1` and both settled. That is not evidence the bug is gone; it is
evidence the instrument works. It must not be reclassified as "probably fine" on
the strength of runs that happened to work.

---

## Failure classes this build keeps producing

Recorded as classes rather than incidents, because each was found three or four
times in different clothes before the pattern was named.

### A process you believe is dead can still write

- A crashed poll loop left a subscription **armed** for 400 unattended
  invocations.
- An RPC timeout killed a 50-minute run **and** broke the unwind that was
  supposed to clean up after it — one attempt, same unresponsive endpoint.
- A run stopped with `TaskStop` finished its poll anyway: it **set the batch cap
  from a superseded formula** and wrote its measurement point a second time. The
  cap read 13 an hour after being set to 15, on chain, with no process visibly
  running.

**What it costs:** chain state that disagrees with the repository, written by
something nobody is watching, discovered only if something asserts it.

**What actually helps:** assertions that read the chain back (`stillArmed()`,
the batch-cap equality check), idempotent writes (`savePoint` refuses a
duplicate transaction hash), and never trusting a mined transaction to mean the
thing happened. Killing a process is a request, not a guarantee.

### A verifier can check the paperwork instead of the conclusion

Distinct from the rule-6 class, and it lives specifically in verification code:
the check asserts that the *ingredients* are present rather than that the
*conclusion* follows.

- `batch-cap` asserted two measurement points existed but never that the
  deployed cap followed from them — so it passed green with a cap the fit
  contradicted, twice.
- `skip-cost` asserted the claim's provenance *label* matched the current build.
  Any number written into `claims.json` with the right code hash would have
  passed. It never looked at a receipt.
- `validators-settle-a-batch-in-block` asserted `marketsSettled > 0`. The claim
  names batch sizes; "at least one settle happened" does not check them.
- `no-eoa-authorization-surface` was the extreme case: it computed a selector
  and **returned unconditionally**. It could not fail, on the finding the entire
  product rests on.

**The question to ask every check:** *if the claim were false, would this
still pass?* All four would have. They now read receipts, decode raw revert
data, and compare the shipped value against what the evidence implies.

**A sub-lesson.** Making `no-eoa-authorization-surface` real exposed a second
bug inside it: a hand-written signature hashed to `0x275284bb` when the real
selector is `0x5d97c566`, so the call hit the fallback and reverted with **no
return data** — which the first version accepted as a pass. A check that accepts
"it reverted somehow" is barely a check. It now requires the exact selector, and
takes its ABI from the SDK rather than from a signature typed by hand.
