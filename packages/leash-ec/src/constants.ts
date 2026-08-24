/**
 * Verified facts about dreamDEX Event Contracts on Somnia Shannon testnet.
 *
 * EVERY value here was confirmed against the live chain or the sponsor's own
 * published source on 2026-08-23. Nothing is inferred from what "should" exist.
 * The provenance note on each entry says how it was confirmed — if you change a
 * value, change the note too, or the next person cannot tell fact from guess.
 *
 * Values marked RESOLVE-AT-RUNTIME are recorded for cross-checking only. Read
 * them from the chain at boot and fail loudly on a mismatch (see topics.ts).
 */

export const NETWORK = {
  /** eth_chainId -> 0xc488. Confirmed 2026-08-23. */
  chainId: 50312,
  rpc: "https://dream-rpc.somnia.network",
  rest: "https://stg.api.dreamdex.io/v0",
  ws: "wss://stg.api.dreamdex.io/v0/ws/public",
  explorer: "https://shannon-explorer.somnia.network",
  /** Measured over a 10,000-block timestamp delta: 0.1001 s/block. */
  blockTimeSec: 0.1,
  /**
   * HARD LIMIT on the public RPC: eth_getLogs rejects a range > 1000 blocks
   * ("block range exceeds 1000"). At 0.1 s/block that is 100 SECONDS of history
   * per call. Every historical scan must window. Confirmed 2026-08-23.
   */
  maxGetLogsBlockRange: 1000,
} as const;

/**
 * Event Contract core, from dreamdex-bot-kit packages/ec-core/src/addresses.ts
 * (the kit bundles these rather than resolving them; CREATE3-deterministic, so
 * identical on both networks). Each address below was additionally confirmed to
 * HAVE CODE on Shannon testnet via eth_getCode on 2026-08-23.
 */
export const EC = {
  /** Emits MarketCreated AND MarketFinalized for every market, on every venue. */
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  clobFactory: "0xb2BE8EE02F96379DB75f01802384593EBa9bfF04",
  binaryPoolImpl: "0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  marketCreator: "0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6",
  /**
   * COLLATERAL IS 6 DECIMALS ON TESTNET. Confirmed on-chain: decimals() -> 6,
   * symbol() -> "TUSDC", name() -> "Test USDC".
   *
   * CLAUDE.md 4.2 rule 9 ("USDso is 18 decimals") is a SPOT / MAINNET fact. On
   * testnet Event Contracts the collateral is 6-decimal Test USDC. Assuming 18
   * here misprices every mandate limit by 10^12 — the same class of bug the
   * rule warns about, in the opposite direction. Always read decimals().
   */
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  /** Public faucet(uint256) — selector 0x57915897 confirmed in deployed bytecode. */
  collateralFaucetSelector: "0x57915897",
} as const;

/**
 * Venue scope. THIS MOVES — the kit records that both networks changed venue
 * three times in the first week of August 2026. If market discovery returns
 * nothing, re-read venueId off a live market row rather than trusting this.
 */
export const VENUE_ID_TESTNET =
  "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

/**
 * Event topics, DERIVED from signatures and cross-checked against live logs.
 *
 * CLAUDE.md 4.2 rule 11 says "never hardcode topics, resolve at boot". The Bot
 * Kit's gotchas.md says the opposite: "pin topic0 from the docs". Both are
 * half-right, and the disagreement is itself the lesson. What actually broke
 * people was DERIVING from a signature string that had silently changed.
 *
 * So: we pin AND derive, and assert they match at boot (topics.ts). A mismatch
 * means the contract changed under us and must be a loud failure, never a
 * listener that quietly stops matching.
 */
export const TOPICS = {
  /**
   * THE LAYER 2 GATE. Emitted by the binaryModule SINGLETON, so ONE
   * subscription covers every market on every venue — which is precisely what
   * a per-pool, per-order stop registry cannot express.
   *
   * OBSERVED LIVE: 128 events in 50 minutes (~1 per 23 s) on 2026-08-23.
   * Signature: MarketFinalized(bytes32 indexed marketId, address indexed pool, uint256 marketKey)
   */
  MarketFinalized:
    "0x8f396ac6cf2e01887362e2b39d8e56860042c604e5b1b481c87e6d9f90006e08",

  /**
   * CAUTION: BinarySettlement declares a DIFFERENT event, also named
   * MarketFinalized, with 7 fields — topic0 0xaa0d535f... A topic-filtered scan
   * over the same 50 minutes found ZERO of those. Two same-named events, two
   * shapes, two emitters: never resolve a topic by event NAME alone.
   */
  SettlementMarketFinalized_DOES_NOT_FIRE:
    "0xaa0d535f55946d4080e0c3a62bb1c53e2596353e9ab633fca0ce625fa518edc1",

  /** Confirmed live on the settlement singleton (126 hits in the sample). */
  Redeemed:
    "0xe31682dd835b7d7bcc4d22f343666af1cc50614bfa16f510ed812ad4ed56f3b4",

  /** Derived value matches the Bot Kit's independently pinned constant exactly. */
  OrderFilled:
    "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399",

  /** The ONLY authoritative side source on a binary pool (v2 freed userData). */
  BinaryOrderPlaced:
    "0x74d63d9f1c4826854a227aa41c4a51723497a608aa14aa50e8153744f081d4e6",

  /** Observed in the same tx as finalization — pools ARE recycled. */
  PoolRecycled:
    "0xa3d129e6bdb33dcc6c5fa1ac04fc9f3b99262b8f735b96b14a8e65f4c307bb21",

  /** Observed on market contracts inside finalization txs. */
  StatusChanged:
    "0xe1377aa21d49fa10bb9ece6a0cd4f75597a90a80c3750f7f7674967f49ab9a62",
} as const;

/** Signatures the topics above are derived from. Kept adjacent on purpose. */
export const SIGNATURES = {
  MarketFinalized: "MarketFinalized(bytes32,address,uint256)",
  Redeemed: "Redeemed(uint256,address,address,uint8,uint256,uint256)",
  OrderFilled: "OrderFilled(uint128,uint128,uint256,uint256,uint256,uint256)",
  BinaryOrderPlaced: "BinaryOrderPlaced(uint128,uint8)",
  PoolRecycled: "PoolRecycled(uint64,address)",
  StatusChanged: "StatusChanged(uint8,uint8)",
} as const;

/**
 * OrderKind on a binary pool. The generic placeOrder REVERTS `UseBinaryPlacement`
 * here — the YES/NO side is an explicit parameter in v2.
 *
 * `price` is ALWAYS the YES-side price, whichever kind you send. Getting this
 * backwards prices a "Down" bet as an "Up" bet at the same number.
 */
export const OrderKind = {
  BUY_YES: 0,
  SELL_YES: 1,
  BUY_NO: 2,
  SELL_NO: 3,
} as const;

/** Leash's UI vocabulary maps onto OrderKind here, and nowhere else. */
export const UP = OrderKind.BUY_YES;
export const DOWN = OrderKind.BUY_NO;

/**
 * Selectors confirmed PRESENT in the deployed binaryPoolImpl bytecode
 * (2026-08-23). Presence proves the entry point exists; it does NOT prove what
 * authorizes it — see PROBE A. `isOperatorAuthorized` is notably ABSENT.
 */
export const POOL_SELECTORS = {
  placeBinaryOrder: "0x718c2d4d",
  /** The operator-routed entry point. What gates it is still UNVERIFIED. */
  placeBinaryOrderFor: "0x5d97c566",
  cancelOrder: "0xdbc91396",
  mintSet: "0x54657dd2",
  /** Caller-scoped vault withdraw — see the demo-beat-1 note in the plan. */
  withdraw: "0xf3fef3a3",
} as const;

/** Status 1 = Trading. Only a Trading market accepts orders. */
export const MARKET_STATUS_TRADING = 1;

/**
 * Somnia reactivity — from @somnia-chain/reactivity-contracts 0.2.1 source,
 * read 2026-08-24. These numbers decide whether Layer 2 is affordable.
 *
 * THE 32 STT IS NOT A DEPOSIT. `CLAUDE.md` §4.3 r16 reads as "subscriptions
 * cost 32 STT to fund". What the source actually says is
 * `SUBSCRIPTION_OWNER_MINIMUM_BALANCE = 32 ether`, enforced as
 * `InsufficientBalance()` — "calling contract balance is below ...". It is a
 * BALANCE FLOOR on the contract that calls subscribe(), checked at subscribe
 * time. The money is not spent and not escrowed; it just has to be sitting
 * there.
 *
 * Two consequences, both load-bearing on a 53 STT budget:
 *
 *   1. DeadhandHandler must HOLD >= 32 STT when it subscribes, so the 32 STT
 *      lives inside the contract. It is therefore STRANDED unless the contract
 *      has an owner-only withdraw. Writing that withdraw is not optional.
 *
 *   2. The real cost is per-invocation, not per-subscription. Each callback is
 *      charged gas at up to `maxFeePerGas`, drawn from the owner. The library
 *      DEFAULTS (10M gas x 20 gwei = 0.2 STT per invocation) are ruinous here:
 *      MarketFinalized fires roughly every 5-23s, so defaults would burn the
 *      whole budget in hours. Override both, and unsubscribe between sessions.
 */
export const REACTIVITY = {
  precompile: "0x0000000000000000000000000000000000000100",
  /** Balance floor on the SUBSCRIBING CONTRACT, not a payment. */
  subscriptionOwnerMinimumBalanceWei: 32n * 10n ** 18n,
  /** Matches the observed live gasPrice exactly (6 gwei, measured 2026-08-24). */
  minimumBaseFeePerGasWei: 6n * 10n ** 9n,
  maximumHandlerGasLimit: 200_000_000n,
  /** Library defaults — DO NOT USE. 10M x 20 gwei = 0.2 STT per invocation. */
  defaultMaxFeePerGasWei: 20n * 10n ** 9n,
  defaultHandlerGasLimit: 10_000_000n,
  /** ~210k gas each, so ~0.0013 STT. Subscribing/unsubscribing is nearly free. */
  subscriptionManagementGas: 210_000n,
  /**
   * onEvent enforces msg.sender == 0x0100 in the base contract. This is why
   * demo beat 3 is honest: nobody — including us — can forge an invocation.
   */
  onlyPrecompileCanInvoke: true,
} as const;
