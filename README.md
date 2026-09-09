# Leash

**A dreamDEX trading key that cannot steal, on a mandate the validators enforce.**

Delegated trading today runs on a DM and a seed phrase. Someone wants a mentor, a
friend or a family member to trade for them, and the only rail available is
handing over full custody. The alternative to Leash is not self-custody — it is
sending your keys to a person.

Leash is for the **honest delegate**: someone who wants to prove they *can't*
steal.

| | |
|---|---|
| **Live app** | https://leash-rho.vercel.app |
| **Network** | Somnia Shannon testnet, chain `50312` |
| **Verify every claim here** | `npx tsx scripts/verify.ts` — 34 checks against the live deployment |

---

## Contents

1. [Two minutes, no setup](#two-minutes-no-setup) — what to click
2. [Run it yourself](#run-it-yourself) — clone to verified in four commands
3. [Deployed addresses](#deployed-addresses)
4. [How we use DreamDEX Event Contracts](#how-we-use-dreamdex-event-contracts)
5. [The three beats](#the-three-beats) — the whole product, as three transactions
6. [What is claimed, and what backs it](#what-is-claimed-and-what-backs-it)
7. [Why this is not `SpotStopOrderRegistry`](#why-this-is-not-spotstoporderregistry)
8. [Venue scope, and why the horizon is not ours](#venue-scope-and-why-the-horizon-is-not-ours)
9. [Honesty register](#honesty-register) — what is staged, and what we got wrong
10. [Repository map](#repository-map)

**Deeper reading:** [Architecture](docs/ARCHITECTURE.md) ·
[Demo script](docs/DEMO-SCRIPT.md) ·
[Adversarial questions](docs/adversarial.md) ·
[Feedback for the dreamDEX team](docs/sdk-feedback.md)

---

## Two minutes, no setup

Leash is three claims. Each is one real transaction on Shannon, and each would
be one explorer lookup from exposure if it were faked.

| | Claim | Transaction |
|---|---|---|
| **1** | The delegate **cannot take the money** — `revoke()` mines and **reverts** with `NotDelegator`, our own check | [`0xed1868a5…`](https://shannon-explorer.somnia.network/tx/0xed1868a5b22d4b6ec1f345f66eee49f61d4d202fdcbbde237f4a02251698087e) |
| **2** | The same key **can trade** — a real Event Contract order the venue accepts, `BinaryOrderPlaced` in the receipt | [`0xba7d0af5…`](https://shannon-explorer.somnia.network/tx/0xba7d0af5d6a5befd3f4f6a36938c0c72105dda54abde03505e5bf4b0fcabea39) |
| **2b** | …and one that actually **filled**, 1 of 14 rehearsals | [`0x90726a11…`](https://shannon-explorer.somnia.network/tx/0x90726a115261bdc67c164d04114764c1d11e93b612ef9ac99ac8b8a37de2b5f1) |
| **3** | **Validators** settle and revoke in-block, nobody running anything | [`0xdb795747…`](https://shannon-explorer.somnia.network/tx/0xdb795747fa69736c63cbb81f70332872dcad50175f210c12d3cfc31397d41088) |
| **3b** | …and the money goes to the delegator, triggered by a **stranger** | [`0x51a9f9fc…`](https://shannon-explorer.somnia.network/tx/0x51a9f9fc31eb1fe3400f1ba5e46d65be046ab43be83fc1af942476e24acfc3ad) |

To drive it yourself: open the [live app](https://leash-rho.vercel.app), create a
mandate for any address, and open the link it gives you in a second browser
profile. [The demo script](docs/DEMO-SCRIPT.md) is the shot-by-shot version.

---

## Run it yourself

```bash
git clone https://github.com/Manuel-dev01/Leash && cd Leash
npm install
forge test                    # 56 contract tests, no network needed
npx tsx scripts/verify.ts     # 34 checks against the LIVE deployment
```

`verify.ts` is the point of this repo. It does not test the code against itself —
it reads the deployed bytecode, calls the deployed contracts, replays real
validator invocations, and fails when a sentence in this README stops being
true. Every figure below carries a provenance record in
[`claims.json`](claims.json), keyed by the deployed **code hash**, so a
measurement that outlived its build reports amber instead of green.

**Two results are expected and are not failures:**

- `real-event-contract-order` goes red when **no market is open**. The venue runs
  a handful at a time in 60s/300s/3600s windows, so there are genuine gaps. The
  message distinguishes that from an RPC failure.
- One **amber** on `delegators-paid` — see
  [refunds](#refunds-arrive-late-and-sometimes-cannot-arrive).

To run the app locally: `cd apps/web && npm install && npm run dev`.

---

## Deployed addresses

| | Address |
|---|---|
| `MandateRegistry` | [`0x105e7732DE6D2E8C43e5803F8Df0D2d4860E7679`](https://shannon-explorer.somnia.network/address/0x105e7732DE6D2E8C43e5803F8Df0D2d4860E7679) |
| `DeadhandHandler` | [`0x66D1D983e89a7eCb4bCFf535A348C59086B686Ad`](https://shannon-explorer.somnia.network/address/0x66D1D983e89a7eCb4bCFf535A348C59086B686Ad) |
| Collateral — tUSDC, **6 dp** | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| Binary markets module — the subscription's emitter | `0x3ecC694Cef705358864a646142ac17A90E29e388` |

The subscription is armed at `gasLimit 8,000,000` on `MarketFinalized` and reads
`0` between sessions **on purpose**: staying armed costs ~15 STT/day, so it is
armed for demo windows and unsubscribed afterwards.

---

## How we use DreamDEX Event Contracts

Event Contracts have **no per-user authorization surface**. That is not an
assumption; it is [`scripts/probe-a.ts`](scripts/probe-a.ts), run against live
testnet and re-run on every `verify.ts` invocation.

`placeBinaryOrderFor` exists — selector `0x5d97c566` — but is gated by
**`OnlyApprovedContracts()` (`0x3fb0ba2e`)**, an allowlist of *contracts*. The
identical order was rejected from three senders **including the pool owner acting
for itself**, while the same order via `placeBinaryOrder(self)` sailed past
authorization and failed on allowance. So the gate is caller identity, not
parameters, and **no EOA can ever be granted pool-level authority**.

Leash therefore does not wrap someone else's permission system. It *is* the
permission system: the registry places orders **as itself**, which is why it
needs no permission from dreamDEX, and why the delegate has no route to the pool
that bypasses our checks.

### The order path, by line number

Every limit is checked before any money moves, in
[`MandateRegistry.placeForDelegator`](contracts/src/MandateRegistry.sol#L298):

| Step | Line |
|---|---|
| Caller must be the named delegate | [L309](contracts/src/MandateRegistry.sol#L309) |
| Not revoked, not expired | [L310–L311](contracts/src/MandateRegistry.sol#L310) |
| Market must be on the mandate | [L312](contracts/src/MandateRegistry.sol#L312) |
| Per-order cap | [L319](contracts/src/MandateRegistry.sol#L319) |
| Cumulative budget | [L322](contracts/src/MandateRegistry.sol#L322) |
| Balance recorded **before** any pull | [L335](contracts/src/MandateRegistry.sol#L335) |
| Just-in-time pull from the delegator | [L338](contracts/src/MandateRegistry.sol#L338) |
| Order placed **as the registry** | [L342](contracts/src/MandateRegistry.sol#L342) |
| Silent rejection is made loud | [L348](contracts/src/MandateRegistry.sol#L348) |
| Residual swept back, same transaction | [L383–L386](contracts/src/MandateRegistry.sol#L383) |

The delegator's principal is in their own wallet until line 338 and back home by
line 386. There is no state in which Leash holds it.

### Event Contract facts this build established

None of these are documented anywhere; each cost us a run. The full write-up is
[`docs/sdk-feedback.md`](docs/sdk-feedback.md).

- `placeBinaryOrderFor` is gated by an approved-**contract** allowlist. No EOA
  can be granted routing authority on a binary pool.
- The **simulated `orderId` is not the receipt's.** Code that tracks the
  simulated id tracks an order that does not exist.
- `getBookLevels` is a spot signature and **reverts** on binary pools. There is
  no on-chain read for binary book depth.
- `marketKey` is packed `(pool << 64) | nonce`, not an id — it decodes as a
  plausible 68-digit number.
- Pools are **recycled** across market windows, so anything keyed by pool address
  silently starts governing a different market. Leash keys everything by
  `marketId`.
- Two different events are both named `MarketFinalized`, with different shapes.
  Resolving a topic by name picks the wrong one.

---

## The three beats

### 1. Can't take

The delegate calls `revoke()` on the delegator's mandate. It **mines and reverts**
with `NotDelegator` — our own authorization check, not an incidental failure.
The registry has **no `withdraw` function at all**: there is no selector to call,
which is the strongest form the claim can take.

### 2. Can trade

The same key places a real Event Contract order the venue accepts, drawing on an
allowance the delegator can revoke at any moment. The delegator has signed
nothing but an ERC-20 `approve`.

**We do not claim it fills.** Binary books on this testnet are quote-only:
measured over ~100 seconds, **161 orders on binary pools produced 1 fill**, while
35 fills happened on spot and perp pools in the same window. Both sides are
posted — 55% BUY_YES, 45% SELL_YES — and simply do not cross. Across 14
rehearsals **one filled and thirteen rested**.

That is the venue's business, not Leash's. What beat 2 proves is the part that is
ours: an order placed by a delegate, on the delegator's money, that never entered
anyone's custody — and which the mandate could have refused.

### 3. Can't overreach

The delegate's order outlives the mandate that authorised it. When the market
resolves, **validators invoke the handler and, in the same block, settle every
affected mandate, revoke the breachers, and sweep the released collateral to the
delegator** — a party who never traded.

`onEvent` enforces `msg.sender == 0x0100` in the reactivity base contract, so a
validator invocation **cannot be forged** — by a competitor or by us. `verify.ts`
proves it by calling `onEvent` from an ordinary EOA and asserting the revert.

---

## What is claimed, and what backs it

The full ledger is [`claims.json`](claims.json); the mechanism is described in
[Architecture § verification](docs/ARCHITECTURE.md#verification-as-a-build-artifact).

### Non-upgradeable, no admin key, no privileged role

True in source and asserted against the deployment as a three-link chain:

1. **Deployed == artifact.** `eth_getCode`, with immutables masked and solc's
   CBOR metadata trailer stripped, is byte-for-byte equal to the local compile.
2. **The artifact has no upgrade path.** solc's own instruction listing reports
   **0 `DELEGATECALL`, 0 `SELFDESTRUCT`**, and its selector table contains none of
   `owner` / `admin` / `pause` / `upgradeTo` / `transferOwnership` / `withdraw`.
3. **Storage is not a proxy.** All three EIP-1967 slots read zero.

Link 1 is what makes link 2 a statement about the *deployment* rather than about
a local file.

> A linear disassembly of the deployed bytes reports `DELEGATECALL` at offset
> 8557, and `cast disassemble` agrees. Both are wrong — that offset is inside a
> 32-byte data blob. Never assert an opcode's absence from a linear scan; ask the
> compiler that emitted it.

**One function changes a mandate after creation, and it is not an admin power.**
`setMarkets(mandateId, marketIds[], allowed)` is callable only by that mandate's
own delegator — a stranger and the delegate both revert `NotDelegator`. It exists
because markets resolve in minutes while the allowed set was fixed at creation,
so a mandate was untradable long before its expiry. It is symmetric, and it moves
**no money limit**: `maxStakePerTrade`, `maxCumulativeExposure` and `expiry` are
immutable for the life of the mandate.

### The registry holds no funds

`collateral.balanceOf(registry) <= totalOwed + totalRefundClaim`, with
`unattributed() == 0`. Asserted three ways: live on the deployed contract every
`verify.ts` run; in the suite after every order path
([`test_holdsNoFunds_afterEveryOrderPath`](contracts/test/MandateEnforcement.t.sol));
and across **56 tests** — `forge test`.

#### A sweep returns only its own order's residual

`placeForDelegator` records the balance **before** it pulls, and returns exactly
what that transaction brought in and the pool declined to take, capped at the
order's own cost. Collateral already in the contract for someone else is
untouched *by construction*.

It used to subtract a global floor — `balance - (totalOwed + totalRefundClaim)` —
on the assumption that anything unaccounted for belonged to the caller. That
floor was one term short, and one delegator's booked refund left with another
delegator's order. A floor that has to enumerate every claim anyone holds is the
wrong shape; it is gone rather than repaired.
[`test_collateralHeldForOthersSurvivesAnUnrelatedOrder`](contracts/test/MandateEnforcement.t.sol)
holds even when the bookkeeping meant to protect that money is absent, and
against the old sweep it fails with an arithmetic underflow — the delegator
ending up with more than they spent.

#### What "payout" means here, precisely

**Released collateral, not winnings.** When a market resolves, escrow the pool
did not consume comes back and is swept to the delegator — real money moving to
the party who never traded. But a **filled** order's stake has become an outcome
position, and the registry's `IBinaryPool` interface exposes only
`placeBinaryOrder` and `cancelOrder` — there is **no redeem path**, so a winning
position is never converted back. It does not affect the demo, since orders rest
rather than fill, but the word must not imply winnings.

#### Refunds arrive late, and sometimes cannot arrive

`settleOne` books a claim the moment a market resolves, but the pool returns the
escrow asynchronously — measured at minutes. In that window
`claimsAreBacked()` is legitimately false, so it is published as a **reading, not
a guarantee**.

For rested orders the gap closes: 11 mandates booked 0.22 tUSDC and
`sweepRefunds` paid every one in full, triggered by a key that never traded. For
**filled** orders it never closes, per the paragraph above. A single snapshot
cannot tell the two apart — this build mistook one for the other once — so the
test is whether it clears.

### Layer 2 is deletable

Deleting `DeadhandHandler` and its subscription leaves a fully working app.
Everything the handler does calls a **permissionless** registry entry point, and
the registry contains no reference to a handler — its deployed bytecode does not
carry the address. Proven live: a **stranger key** calls `settleFinalizedMarket`
directly and it succeeds, including draining a 32-mandate market in slices.

---

## Why this is not `SpotStopOrderRegistry`

The surface similarity is real, so here is the difference in the order it
matters:

1. **The beneficiary is not the trader.** Their registry fires an order *for the
   account that armed it*. Ours performs a permission change and sweeps released
   collateral **to the delegator, who never traded.** A stop-order registry has
   no vocabulary for returning funds to a third party.
2. **The action is not an order.** It releases exposure, revokes breached
   mandates, and books refunds.
3. **One subscription, N beneficiaries.** `createPendingOrder` is `payable` and
   charges `somiPaymentPerOrder()` — funding is **per user per order**. Ours is
   one subscription serving every delegation.

The shapes differ because the *events* differ. A price threshold is inherently
per-user: your stop is not my stop. A resolution is inherently **shared** — every
mandate on that market resolves in the same block. That is why one subscription
can serve all of them and theirs structurally cannot.

### Measured, on the deployed handler, from real validator invocations

| Quantity | Value |
|---|---|
| Settle **3** mandates | 1,550,679 gas, `drained=true` |
| Settle **12** mandates | 3,302,336 gas, `drained=true` |
| Settle **32** mandates | **ran out of gas** — `DeadhandFailed`, nothing settled |
| Fitted cost | **~966,795 gas fixed + ~194,628 per mandate** |
| Subscription `gasLimit` | **8,000,000** |
| **Batch cap** | **17** |
| Ignoring a finalization that is not ours | **0.00174709 STT**, twice, identical to the wei |

**We do not say it is nearly free.** Sitting armed costs about **15.1 STT/day**,
which is why the subscription is armed for demo windows and unsubscribed after.
The argument is about *shape*, not price: O(1) subscriptions against
O(users × orders).

The cap is load-bearing and the fit is optimistic at the top: the n=32 invocation
was delivered and **failed**, so the real cost there exceeds ~7.89M against a
predicted 7.19M. The two-point line under-predicts at high n by at least 10% —
the second time a fit here has erred in the dangerous direction — which is why
the cap is 17 and is not raised toward the fitted ceiling of 35.

---

## Venue scope, and why the horizon is not ours

Measured 8 Sep, from `MarketCreated` on chain:

| | |
|---|---|
| Markets discovered / still live | 102 / **8** |
| Assets | **BTC and ETH**, nothing else |
| Windows | 60s · 300s · 3600s |
| Longest horizon available | **~1 hour** |

Two market kinds run side by side, and only one carries a strike:

```
strike=7903405  "Pricefeed test: will BTC/USDC's price be at or above 79034.05 …"
strike=0        "BTC closes at or above its opening price"
```

Nobody would delegate months of trading against a three-minute prediction, and
that is a fair objection — but **the ceiling is the venue's, not Leash's.** A
mandate names markets by `marketId`, never by horizon; nothing in
`MandateRegistry` reads an expiry to decide what may be traded, and `setMarkets`
re-points a live mandate at whatever is listed now. If Event Contracts list
day-long markets tomorrow, Leash trades them with no change.

The in-app markets screen shows all of this from chain — the venue's own question
text, strike, trading window, fee schedule, settlement address, and whether each
market is on your mandate. **It shows no price**, because there is none to show:
`getBookLevels` reverts on binary pools and `BinaryOrderPlaced` carries no price.
Saying so is more useful than drawing something in the gap.

---

## Honesty register

- The demo breach is **deliberate**: the delegate over-trades on purpose so
  revocation fires on camera.
- Delegator and delegate are two browser profiles presented as two people.
- A mandate is pre-seeded so a judge is one tap from the interesting part.
- **No liquidity was self-funded**, and no order in this repo was filled by a
  counterparty we control. Binary books are quoted but barely crossed, so our
  orders rest. If we ever seed a counterparty it will be disclosed here.
- An earlier version of this README said books were "genuinely traded" on the
  strength of a fill count that turned out to include spot and perp pools.
  `OrderFilled` is not unique to Event Contracts.
- The app **used to draw a decorative price line** from twelve hardcoded numbers,
  labelled "indicative". In a product whose whole claim is that on-screen figures
  come from the contract, it was the one thing that was invented. It is deleted,
  and `verify.ts` now asserts that no fabricated series can return.
- The gas figures here were all re-measured after the 8 Sep redeploy. Earlier
  numbers — a cap of 13, and of 24 — are retracted in `claims.json` with the
  reason.

---

## Repository map

```
contracts/src/MandateRegistry.sol    limits, custody, settlement  — the product
contracts/src/DeadhandHandler.sol    one subscription, validator-invoked
contracts/test/                      56 tests: enforcement + revocation
packages/leash-ec/                   Event Contract client: discovery, topics, constants
apps/web/                            both UIs, one bundle
scripts/verify.ts                    34 checks against the live deployment
scripts/deploy.ts · retarget.ts      deploy, then roll addresses across the repo
claims.json                          every claim, with provenance by code hash
docs/                                architecture, demo script, adversarial Q&A, SDK feedback
```

---

## Licence

MIT — see [`LICENSE`](LICENSE).
