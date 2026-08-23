# Telegram — dev group (`t.me/+XHq0F0JXMyhmMzM0`)

Send as ONE message. Ordered by how much each answer changes the architecture.

Most of `CLAUDE.md` §9 was answerable from the SDK source and the chain itself
(see `packages/leash-ec/src/constants.ts`), so this asks only what genuinely
cannot be read off either. Keeping it short is the point — a busy DevRel
answers four specific questions and ignores twelve vague ones.

---

Hi — building on dreamDEX Event Contracts for the hackathon (delegated trading
with on-chain limits, so a mentor can trade for someone without custody). Four
things I can't determine from the SDK or from chain state:

**1. What authorizes `placeBinaryOrderFor` on a binary pool?**
The selector (`0x5d97c566`) is in the deployed `binaryPoolImpl` bytecode, but
`isOperatorAuthorized` is not, and `operatorPermissionsRegistry` is left unset
in `ec-core/addresses.ts`. Is it the shared `OperatorPermissionsRegistry` like
spot? Is the grant per-selector and per-pool, and is it owner-revocable
immediately? This decides whether our limits sit in the order path or beside it.

**2. Is `BinaryMarketsModule.MarketFinalized` stable to subscribe to?**
topic0 `0x8f396ac6…`, from the module singleton — I'm seeing ~1 every 23s on
testnet, and the `0x0100` precompile already emitting inside your finalization
txs. Any planned signature change before ~7 Sep? (Noting `BinarySettlement`
declares a second, 7-field `MarketFinalized` that appears not to fire.)

**3. Subscription funding.**
Docs say 32 STT minimum. For a handler firing on every market finalization,
what's a realistic per-invocation cost, and is there a testnet grant for
hackathon teams? Also: is the funding denominated in STT or SOMI on Shannon?

**4. Venue + deadline.**
Testnet `VENUE_ID` moved three times in early August — is the current one
expected to hold through 7 Sep? And can you confirm the DoraHacks deadline
date and timezone? Sources conflict between 8 and 9 Sep.

Happy to send back a written SDK/docs feedback note at the end — I already have
concrete items, e.g. `ec-core`'s `assertTxOk` only checks for a reverted
receipt: unlike spot `packages/core` it doesn't `eth_call`-simulate or assert a
placement log, so gotcha #8 (a mined tx that's a silent rejection) is currently
unguarded on the binary path.

---

## Answers received

_(record here with the date, then mirror into `CLAUDE.md` §9)_

| # | Date | Answer |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
