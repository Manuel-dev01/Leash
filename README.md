# Leash

**A dreamDEX trading key that cannot steal, on a mandate the validators enforce.**

Delegated trading today runs on a DM and a seed phrase. Someone wants a mentor,
a friend or a family member to trade for them, and the only rail available is
handing over full custody. The alternative to Leash is not self-custody — it is
sending your keys to a person.

Leash is for the **honest delegate**: someone who wants to prove they *can't*
steal.

- **Live app:** https://leash-rho.vercel.app
- **Network:** Somnia Shannon testnet (chain `50312`)
- **One command that checks every claim below:** `npx tsx scripts/verify.ts`

---

## Deployed

| | Address |
|---|---|
| `MandateRegistry` | [`0x7ca9dA7Be8C8F8Ca5E1c9821061cD4fc23418864`](https://shannon-explorer.somnia.network/address/0x7ca9dA7Be8C8F8Ca5E1c9821061cD4fc23418864) |
| `DeadhandHandler` | [`0xBffC022eC263C43B80bd040ded7e0A4a43101a97`](https://shannon-explorer.somnia.network/address/0xBffC022eC263C43B80bd040ded7e0A4a43101a97) |
| Collateral (tUSDC, **6 dp**) | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| Binary markets module (subscription emitter) | `0x3ecC694Cef705358864a646142ac17A90E29e388` |

**Subscription ID:** most recently `16507054`, armed at `gasLimit 8,000,000` on
`MarketFinalized`. It reads `0` between sessions **on purpose** — see
[Cost](#cost-and-why-we-do-not-say-it-is-free).

---

## How we use DreamDEX Event Contracts

Event Contracts have **no per-user authorization surface**. That is not an
assumption; it is [`scripts/probe-a.ts`](scripts/probe-a.ts), run against live
testnet, and re-run on every `verify.ts` invocation.

`placeBinaryOrderFor` exists (selector `0x5d97c566`) but is gated by
**`OnlyApprovedContracts()` (`0x3fb0ba2e`)** — an allowlist of *contracts*. The
identical order was rejected from three senders **including the owner acting for
itself**, while the same order via `placeBinaryOrder(self)` sailed past
authorization and failed on allowance. So the gate is caller identity, not
parameters, and **no EOA can ever be granted pool-level authority**.

Leash therefore does not wrap someone else's permission system. It *is* the
permission system: the registry places orders **as itself**, which is why it
needs no permission from dreamDEX, and why the delegate has no route to the pool
that bypasses our checks.

### The order path, by line number

[`contracts/src/MandateRegistry.sol`](contracts/src/MandateRegistry.sol) —
`placeForDelegator`, [line 264](contracts/src/MandateRegistry.sol#L264):

| Line | What happens |
|---|---|
| [264](contracts/src/MandateRegistry.sol#L264) | `placeForDelegator(mandateId, marketId, pool, kind, price, quantity, expireTimestampNs)` — the delegate's only entry point |
| 265–296 | **Every limit is enforced here**, before any money moves: per-order cap, cumulative budget, market allowlist, expiry, delegate identity, revocation |
| [297](contracts/src/MandateRegistry.sol#L297) | `_pull(delegator, cost)` — just-in-time `transferFrom`. Until this line the principal has never left the delegator's wallet |
| [301](contracts/src/MandateRegistry.sol#L301) | `IBinaryPool(pool).placeBinaryOrder(...)` — placed **as the registry** |
| [307](contracts/src/MandateRegistry.sol#L307) | `if (!ok) revert PlacementRejected()` — `placeBinaryOrder` returns `(bool, uint128)` and a `false` does **not** revert. A mined transaction can be a silent rejection; this is the guard `ec-core` does not have |
| [327](contracts/src/MandateRegistry.sol#L327) | `_sweep(delegator)` — the residual goes back in the **same transaction** |

The sweep is not hygiene. Pulling worst-case cost once left **0.258 tUSDC**
stranded when the order filled below its limit. Without it, balance-at-rest is
non-zero and the no-custody claim is *nearly* true — which is worse than false,
because it survives casual inspection.

### Event Contract facts this build established

None of these are documented anywhere else. Each was measured, and several
corrected an earlier wrong answer of our own.

| | |
|---|---|
| **The simulated `orderId` is not the real one** | Simulation returned `…090512`; the receipt's `BinaryOrderPlaced` carried `…090523`. Both plausible `uint128`s, no warning. Read the id from the receipt |
| **`BinaryOrderPlaced`'s id is INDEXED** | It is `topics[1]`; `data` holds only the `uint8` kind. Reading the id from `data` yields `0`, matches no fill, and reports "never fills" while looking reasonable |
| **`OrderFilled`'s first two args are indexed** | Declaring all six as non-indexed decodes to **zeros without throwing**, which sails through exposure accounting as a plausible "nothing filled" |
| **`marketKey` is packed, not an id** | `(uint160(pool) << 64) \| nonce`. Read as a `uint256` it yields a valid-looking 68-digit number |
| **Pools are recycled** | `PoolRecycled` fires in the same transaction as finalization. Key everything by `marketId`; a mandate keyed on a pool address silently starts governing a different market |
| **Cross generously — aggression is free** | A taker is charged the **fill** price, not the price it offered |
| **Order expiry is capped at the market's** | Exceeding it reverts `OrderExpiryBeyondMarket` (`0xd3dea628`) |
| **Testnet EC collateral is 6 dp**, not 18 | `decimals()` → 6. Mainnet EC is 18. Always read it |
| **`ec-core`'s bundled `binaryPoolImpl` is stale** | Live pools are beacon proxies resolving elsewhere. Binary pools were upgraded *during* this hackathon |
| **This RPC ignores `eth_getLogs` topic filters** | A request for a `topic0` matching nothing returns the same logs as the correct hash. `viem`'s `getLogs({event})` re-filters client-side and is safe; a raw `client.request` is not |

---

## The three beats

Each is a real transaction. If any were faked it would be one explorer lookup
from discovery.

### 1. Can't take
The delegate calls `revoke()` on the delegator's mandate. It **mines and
reverts** with `NotDelegator` — our own authorization check, not an incidental
failure. The registry has **no `withdraw` function at all**: there is no
selector to call, which is the strongest form the claim can take.

### 2. Can trade
The same key places a **real Event Contract order that the venue accepts** —
`BinaryOrderPlaced` in the receipt — drawing on an allowance the delegator can
revoke at any moment. The delegator has signed nothing but an ERC-20 `approve`,
and the principal is pulled and swept back inside the one transaction.

**We do not claim it fills.** Binary books on this testnet are quote-only:
measured over ~100 seconds, **161 orders on binary pools produced 1 fill**, while
35 fills happened on spot and perp pools in the same window. Both sides are
posted (55% BUY_YES, 45% SELL_YES) and simply do not cross. Across 14
rehearsals **one filled and thirteen rested** — so a fill is possible, and
scripting the demo around it would be a coin flip with poor odds.

That is the venue's business, not Leash's. What beat 2 proves is the part that
is ours: an order placed by a delegate, on the delegator's money, that never
entered anyone's custody — and which the mandate could have refused.

### 3. Can't overreach
The delegate's order outlives the mandate that authorised it. When the market
resolves, **validators invoke the handler and, in the same block, settle every
affected mandate, revoke the breachers, and sweep the payout to the delegator** —
a party who never traded.

`onEvent` enforces `msg.sender == 0x0100` in the reactivity base contract, so a
validator invocation **cannot be forged** — by a competitor or by us. That is
what makes beat 3 checkable rather than asserted, and `verify.ts` proves it by
calling `onEvent` from an ordinary EOA and asserting the revert.

### The three links a judge should click

| Beat | Transaction |
|---|---|
| 1 · can't take — mines and **reverts** with `NotDelegator` | [`0xed1868a5`](https://shannon-explorer.somnia.network/tx/0xed1868a5b22d4b6ec1f345f66eee49f61d4d202fdcbbde237f4a02251698087e) |
| 2 · can trade — order accepted, `BinaryOrderPlaced` | [`0xba7d0af5`](https://shannon-explorer.somnia.network/tx/0xba7d0af5d6a5befd3f4f6a36938c0c72105dda54abde03505e5bf4b0fcabea39) |
| 2 · the one that **filled**, 1 of 14 | [`0x90726a11`](https://shannon-explorer.somnia.network/tx/0x90726a115261bdc67c164d04114764c1d11e93b612ef9ac99ac8b8a37de2b5f1) |
| 3 · validators settle **and revoke**, in-block | [`0xdb795747`](https://shannon-explorer.somnia.network/tx/0xdb795747fa69736c63cbb81f70332872dcad50175f210c12d3cfc31397d41088) |
| 3 · payout to the delegator, triggered by a **stranger** | [`0x51a9f9fc`](https://shannon-explorer.somnia.network/tx/0x51a9f9fc31eb1fe3400f1ba5e46d65be046ab43be83fc1af942476e24acfc3ad) |

---

## The claims, and what backs each

Every claim is a row in [`claims.json`](claims.json) with two deliberately
separate fields: **what proves it**, and **what that proof runs against**.

The second field exists because four times in this build a green check certified
behaviour the real system did not exhibit — and each time the assertion was
sound while the thing it ran against was a mock. `holdsNoFunds()` passed in the
suite while the deployed registry held 0.24 tUSDC, because the mock refunded
escrow synchronously and the venue does not.

`npx tsx scripts/verify.ts` turns each row into an assertion against the
**deployed** system and exits non-zero on failure. It does two things a
checklist cannot:

- **Fails on stale evidence.** Claims carry the handler code hash their proof
  came from; when the deployed bytecode moves, the claim reports amber rather
  than coasting on an old run.
- **Runs the negative cases.** A dead RPC must render an em dash and never a
  confident `0.00`; discovery must *throw* rather than report an empty venue;
  each named refusal is provoked from a real key and decoded from **raw revert
  data**, never pattern-matched out of an error message.

### Non-upgradeable, no admin key, no privileged role

True in source and asserted against the deployment, as a three-link chain:

1. **Deployed == artifact.** `eth_getCode`, immutables masked and solc's CBOR
   metadata trailer stripped, is byte-for-byte equal to the local compile.
2. **The artifact has no upgrade path.** solc's own instruction listing reports
   **0 `DELEGATECALL`, 0 `SELFDESTRUCT` across 5,802 runtime instructions**, and
   its selector table contains none of `owner` / `admin` / `pause` /
   `upgradeTo` / `transferOwnership` / `withdraw` among 30 entry points.
3. **Storage is not a proxy.** All three EIP-1967 slots read zero.

Link 1 is what makes link 2 a statement about the *deployment* rather than about
a local file.

> A linear disassembly of the deployed bytes reports `DELEGATECALL` at offset
> 8557, and `cast disassemble` agrees. Both are wrong — that offset is inside a
> 32-byte data blob (it is `MandateRevoked`'s topic0 constant). Never assert an
> opcode's absence from a linear scan of EVM bytecode; ask the compiler that
> emitted it.

### The registry holds no funds

`collateral.balanceOf(registry) <= totalOwed + totalRefundClaim`, with
`unattributed() == 0`. Asserted three ways:

- **Live, on the deployed contract** — `verify.ts`, every run.
- **In the suite, after every order path** —
  [`test_holdsNoFunds_afterEveryOrderPath`](contracts/test/MandateEnforcement.t.sol#L56),
  `contracts/test/MandateEnforcement.t.sol:56`.
- **41 tests total** — 28 enforcement, 13 revocation. `forge test`.

---

## Layer 2 is deletable

Deleting `DeadhandHandler` and its subscription leaves a fully working app.
Everything the handler does calls a **permissionless** registry entry point, and
the registry never assumes a handler ran — it contains no reference to one, and
its deployed bytecode does not carry the handler's address.

Proven live: a **stranger key** — not the delegator, not the delegate, not the
handler — calls `settleFinalizedMarket` directly and it succeeds.

## Why this is not `SpotStopOrderRegistry`

The surface similarity is real, so here is the difference in the order it
matters:

1. **The beneficiary is not the trader.** Their registry fires an order *for the
   account that armed it*. Ours performs a permission change and sweeps a payout
   **to the delegator, who never traded.** A stop-order registry has no
   vocabulary for returning funds to a third party.
2. **The action is not an order.** It releases exposure, revokes breached
   mandates, and books refunds.
3. **One subscription, N beneficiaries.** `createPendingOrder` is `payable` and
   charges `somiPaymentPerOrder()` — funding is **per user per order**. Ours is
   one subscription serving every delegation.

The shapes differ because the *events* differ. A price threshold is inherently
per-user: your stop is not my stop. A resolution is inherently **shared** —
every mandate on that market resolves in the same block. That is why one
subscription can serve all of them and theirs structurally cannot.

### Measured, on the deployed handler, from real validator invocations

| Quantity | Value |
|---|---|
| Settle **3** mandates | 1,350,525 gas, `drained=true` |
| Settle **12** mandates | 3,301,786 gas, `drained=true` |
| Settle **32** mandates | 8,082,346 gas, `failed=0` |
| Fitted cost | **~433,450 gas fixed + ~239,028 per mandate** (three points, one bytecode) |
| Wrapper overhead | **107,556 gas**, identical at every batch size |
| Subscription `gasLimit` | **8,000,000** — forced by measurement; a 12-mandate settle does not fit under 3M |
| **Batch cap** | **15**, 50% of where the budget binds (~31) |

The cap is load-bearing, not cautious: the 32-mandate settle cost 8,082,346 gas
and would have **run out of gas** under the shipped limit. It only completed
because that measurement run armed at 10M.

### Cost, and why we do not say it is free

Ignoring a finalization that is not ours costs **291,181 gas (0.001747086 STT)**,
read from receipts and identical on every invocation — about **15.1 STT/day** to
sit armed. That is not a rounding error, which is why the subscription is armed
for demo windows and unsubscribed after.

Charging is on **gas used, not `gasLimit`** — the same figure came back to the
wei at limits of 3M and 8M — which is what makes the wide limit the batch needs
free.

The argument is about **shape, not price**: O(1) subscriptions against
O(users × orders).

---

## Run it yourself

```bash
npm install
forge test                        # 41 tests
npx tsx scripts/doctor.ts         # connectivity, topics, live invariants
npx tsx scripts/verify.ts         # every claim in claims.json, against the deployment
```

`verify.ts` can legitimately go red on `real-event-contract-order` when no market
is open. The venue runs **six live markets at a time** — BTC and ETH, in a 60s,
a 300s and a 3600s window — so there are windows with nothing tradable. The
message distinguishes that from an RPC failure.

## Honesty register

- The demo breach is **deliberate**: the delegate over-trades on purpose so
  revocation fires on camera.
- Delegator and delegate are two browser profiles presented as two people.
- A mandate is pre-seeded so a judge is one tap from the interesting part.
- **No liquidity was self-funded**, and no order in this repo was filled by a
  counterparty we control. Binary books are quoted but barely crossed (1 fill
  per ~161 binary orders), so our orders rest. We could seed a counterparty to
  force a fill on camera; we have not, and if we ever do it will be disclosed
  here.
- An earlier version of this README said books were "genuinely traded" on the
  strength of a fill count that turned out to include spot and perp pools.
  `OrderFilled` is not unique to Event Contracts.
- The price line on `market_detail` is decorative and labelled as such. It ships
  under an explicit, recorded override of our own no-charts rule. A chart may be
  decorative; **nothing that looks like a mandate limit may be.**

## Licence

MIT.
