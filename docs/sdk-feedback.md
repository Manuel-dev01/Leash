# Feedback for the dreamDEX / Somnia team

Everything here was found while building Leash against Shannon testnet between
23 August and 6 September 2026. Each item is something we measured, usually
after it cost us a run, and every figure is from a receipt or a raw `eth_call`
rather than from documentation or simulation.

Written to be useful, not to complain. Where we got something wrong ourselves,
that is marked too — several of these are documented precisely because our first
answer was confidently incorrect.

---

## 1. `ec-core` has no silent-rejection guard on the binary path

**Highest-impact item in this document.**

`placeBinaryOrder` returns `(bool success, uint128 id)`. A `false` **does not
revert** — the transaction mines with `status = 1` and nothing is placed.
`ec-core`'s `assertTxOk` checks only `receipt.status === "reverted"`, so a
silent rejection passes it. The kit's `gotchas.md` note that "Core does both"
refers to the spot `packages/core`.

For anyone building on the binary path this is the difference between a working
bot and one that reports success while doing nothing.

**What we do instead**, and would suggest for `ec-core`: `eth_call` simulate →
abort if `success == false` → broadcast at the same gas limit → **assert a
`BinaryOrderPlaced` log is present in the receipt** → read the id from the
receipt.

## 2. The simulated `orderId` is not the real one

On our first guarded placement, simulation returned `…090512` and the receipt's
`BinaryOrderPlaced` carried `…090523`. Both are plausible `uint128`s and nothing
warns you. Code that tracks the simulated id tracks an order that does not
exist: it will "fail" to cancel and "fail" to find fills, and it looks like a
venue bug.

Reproduced on every placement.

## 3. `BinaryOrderPlaced`'s id is indexed; the data payload is only the kind

`BinaryOrderPlaced(uint128 indexed id, uint8 kind)` — the id is `topics[1]`, and
`data` is the `uint8`. Reading the id from `data` yields **0**, which then
matches no fill and reports "this order never fills" forever, while looking
entirely reasonable.

This cost us a harness rewrite. It is the same shape as the next item.

## 4. `OrderFilled`'s first two arguments are indexed

`takerOrderId` and `makerOrderId` are indexed. Declaring all six as non-indexed
**decodes to zeros without throwing**, which sails through exposure accounting
as a plausible "nothing filled".

Related: a transaction carries the counterparty's side too, so summing every
`OrderFilled` in a receipt over-reports. Attribute by matching `takerOrderId` to
the id read from the receipt.

## 5. `marketKey` is packed, not an identifier

`marketKey == (uint256(uint160(pool)) << 64) | nonce`. Read as a `uint256` it
yields a valid-looking 68-digit number that is not an id of anything. We only
noticed because the pool sitting in the low bits matched `topics[2]`.

## 6. Two different events are named `MarketFinalized`

`BinaryMarketsModule.MarketFinalized(bytes32 indexed marketId, address indexed
pool, uint256 marketKey)` — topic0 `0x8f396ac6…`, fires constantly.

`BinarySettlement` declares a **different** 7-field event with the same name —
topic0 `0xaa0d535f…` — which fired **zero** times in our observation window.

Resolving a topic by event name will silently pick the wrong one. We pin *and*
derive every topic and fail at boot if they disagree.

## 7. `getBookLevels` reverts on binary pools

It is a spot signature. There appears to be no equivalent read for binary book
depth, which makes it hard to know whether an order will cross before sending
it. We ended up inferring book state from `BinaryOrderPlaced` kinds.

**A `getBinaryBookLevels` would be genuinely useful.**

## 8. Binary tick and lot size are not readable on chain

Binary market rows carry no `tickSize`/`lotSize` (unlike spot and perp), so
`ec-core` takes them from config — tick 1000, lot 1 at 6dp. Anything quantizing
against on-chain values has nowhere to read them from.

## 9. `placeBinaryOrderFor` is gated by `OnlyApprovedContracts()`, undocumented

Selector `0x5d97c566`, gate `0x3fb0ba2e`. We ran the identical order from three
senders — a stranger, a would-be delegate, and **the pool owner acting for
itself** — and all three reverted the same way, while `placeBinaryOrder(self)`
got past authorization and failed on allowance.

So the gate is caller identity, not parameters, and **no EOA can be granted
routing authority on a binary pool**. The spot `OperatorPermissionsRegistry` /
`isOperatorAuthorized` surface is absent from the live binary implementation.

This is entirely reasonable as a design. It is just not written down anywhere,
and it invalidated our original architecture — for the better, as it happens.
**Documenting it would save someone else a week.**

## 10. `ec-core`'s bundled `binaryPoolImpl` is stale

Live pools are **beacon proxies**. The beacon resolves to an implementation
different from the address bundled as "verified 2026-07-24", so binary pools
were upgraded inside our build window. Anything scanning the bundled address
finds nothing and concludes the venue is empty.

Resolve through the beacon.

## 11. Pools are recycled across market windows

`PoolRecycled` fires in the **same transaction** as finalization. A pool that
served your market a minute ago may now serve a different one, so anything keyed
on a pool address silently begins governing the wrong market. We key everything
by `marketId` and compare `params.market` before trusting a pool.

## 12. Testnet Event Contract collateral is 6 decimals, mainnet is 18

Testnet is tUSDC at `0x70a86D88…`, `decimals()` → 6, confirmed independently by
`getBinaryPoolParams().oneCollateral == 1000000`. Mainnet EC is 18-decimal
USDso.

The rule cannot be "it's 18" or "it's 6" — it has to be *read*. Hardcoding
misprices every limit by 10^12.

## 13. Order expiry is capped at the market's expiry

Exceeding it reverts `OrderExpiryBeyondMarket` — **selector `0xd3dea628`**,
recorded here so a failed order is diagnosable in one lookup. The prose says so;
the selector does not appear anywhere searchable.

Also: `expireTimestampNs = 0` is rejected. There is no "never expires" sentinel.

---

## RPC / infrastructure

## 14. `eth_getLogs` does not honour topic filters

**On `api.infra.testnet.somnia.network`.** Verified with one variable changed
over an identical block range: a request for a `topic0` matching nothing
returned **the same 3 logs** as a request for the correct hash. Results are
scoped by address and block range only.

`viem`'s `getLogs({ event })` is unaffected because it re-filters client-side in
strict mode. A raw `client.request({ method: "eth_getLogs", topics: [...] })`
has no such protection, and ours silently over-counted for two weeks — we
reported "19,195 orders across 18 pools" when the real figure was a fifth of
that across six.

If this is intentional, documenting it would help. If not, it is a quiet
correctness hazard for anyone doing analytics.

## 15. `eth_getLogs` limits worth documenting together

- Ranges over **1000 blocks** are rejected — at 0.1s blocks that is 100 seconds
  of history per call.
- A chain-wide scan over a full 1000-block range returns **13–16 MB**, past
  viem's default 10 MB response cap.

Combined with item 14, a naive "scan for my event over the last hour" fails in
three different ways.

---

## Reactivity

## 16. The 32 STT is a balance floor, not a deposit — and it strands

`SUBSCRIPTION_OWNER_MINIMUM_BALANCE = 32 ether` is checked as a *balance*;
`subscribe()` is not payable and costs ~210k gas. The money is not spent — but
it is stranded in the subscribing contract unless that contract ships its own
withdraw.

Worth a sentence in the docs, because "deposit" is the natural reading and it is
wrong in an expensive direction.

## 17. Charging is on gas USED, not `gasLimit` — please document this

We verified it deliberately: the per-invocation cost came back **identical to
the wei** at `gasLimit` 3,000,000 and 8,000,000.

This is good news and it changes architecture. It means a generous `gasLimit`
costs nothing when the callback exits early, which is what makes a single
broad subscription with in-handler filtering viable. We only found it by
measuring, and we nearly designed around the opposite assumption.

Concrete figures from our handler, for calibration: an early-exit invocation
charges **291,181 gas**; a callback settling 32 items charges **8,189,902**, of
which **107,556** is dispatch and wrapper overhead — constant across batch sizes.

## 18. `onEvent`'s `msg.sender == 0x0100` check is the best thing in the library

It is what let us tell judges that a validator invocation cannot be forged by us
or by anyone. That property is worth advertising more loudly than it currently
is.

---

## Market structure

## 19. Binary books are quoted but barely crossed

Measured over ~100 seconds, chain-wide, filtered client-side:

| | |
|---|---|
| Orders placed on binary pools | **161** |
| Fills on those pools | **1** |
| Fills on spot/perp pools, same window | **35** |
| Kind mix | 55% BUY_YES, 45% SELL_YES, **zero** BUY_NO / SELL_NO |

Both sides are posted and they do not cross. Ten of our rehearsals placed an
aggressive taker at 0.99 and **all ten rested**.

This matters for anyone demoing: an Event Contract order is easy to *place* and
should not be assumed to *fill*. We rewrote our demo script around it.

## 20. The venue is six live markets at a time

BTC and ETH, in a 60s, a 300s and a 3600s window — confirmed by three
independent sweeps over different history depths, all returning the same six.
Markets are created ahead of `tradingStart`, so "live by expiry" and "open for
trading" are different sets and a naive filter finds markets it cannot trade.

## 21. Escrow return after settlement is not automatic — and this is undocumented

When a market resolves, resting orders do not return their collateral. Someone
must call **`cancelExpiredOrders(uint128[])`** on the pool. Until then the
collateral sits with the venue.

We spent a while assuming settlement pushed funds back, and accumulated 11.42
tUSDC of unreturned escrow before noticing.

**The good news, and worth advertising:** `cancelExpiredOrders` is
**permissionless**. We call it from a wallet with no relationship to the order
at all, and it works. That is a genuinely nice property — it means a user's
funds are never hostage to their counterparty or their tooling being online —
and nobody would know it from the docs.

## 22. Finalization is punctual — an earlier claim of ours was wrong

Over 40 finalizations matched to their `MarketCreated` expiry: **min −300s,
median 0s, max +60s**. Markets can finalize *early*, never meaningfully late.

We had previously recorded "finalization lags unpredictably" after three failed
runs. That was wrong; the real cause was our own setup time pushing us past a
market we had picked too tight. Correcting it is what made our reactive layer
reliable, so it is included here in case anyone else draws the same wrong
conclusion from the same symptom.

---

## Summary of what would help most

1. Document the `OnlyApprovedContracts` gate on `placeBinaryOrderFor` (item 9).
2. Add the simulate/assert guard to `ec-core`'s binary path (item 1).
3. Document that reactivity charges on gas *used* (item 17) — it is good news
   that changes designs.
4. Document that escrow returns via permissionless `cancelExpiredOrders`
   (item 21).
5. Refresh `ec-core`'s bundled `binaryPoolImpl`, or resolve through the beacon
   (item 10).
6. Confirm whether the `eth_getLogs` topic filter is meant to be ignored
   (item 14).

Happy to expand on any of these, and to share the probe scripts — they are all
in the repository under `scripts/`.
