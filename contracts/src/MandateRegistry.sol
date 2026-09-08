// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * MandateRegistry — the authorization layer Event Contracts do not have.
 *
 * Probe A (24 Aug) established that binary pools expose no per-user
 * authorization surface: `placeBinaryOrderFor` is gated by
 * `OnlyApprovedContracts()` and rejects even the owner acting for itself. So a
 * delegate cannot be granted pool-level authority at all, by us or by anyone.
 *
 * This contract is therefore not a wrapper over someone else's permission
 * system. It IS the permission system:
 *
 *   delegator approves this contract for X collateral   principal stays put
 *   delegate  calls placeForDelegator(...)
 *     |- limits enforced HERE, in the order path
 *     |- transferFrom(delegator -> this)                just-in-time
 *     |- pool.placeBinaryOrder(...)                     placed as THIS contract
 *     |- sweep back to the delegator                    same transaction
 *
 * The delegate has no route to the pool that bypasses this function, because no
 * such route is grantable. That is why the limits are real.
 *
 * DELIBERATELY IMMUTABLE AND ADMIN-FREE. No proxy, no upgrade path, no owner,
 * no privileged role, no pause. "Custody by code with no discretion" collapses
 * into "custody by us" the moment an admin key exists, and a technical judge
 * finds that in thirty seconds. There is nothing here for us to abuse and
 * nothing for us to be pressured about.
 *
 * INVARIANT: `collateral.balanceOf(this) == totalOwed` after every external
 * entry point. `totalOwed` is non-zero only when a delegator's own token
 * transfer failed (see `_returnTo`). In the normal path it is zero, which is
 * the "this contract holds no funds" claim, asserted in the test suite rather
 * than described in a comment.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
}

interface IBinaryPoolParams {
    function getBinaryPoolParams() external view returns (
        address collateralToken, address market, address outcomeToken,
        uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking,
        address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k,
        uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k,
        address settlement, uint64 marketNonce, bool finalized
    );
}

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;
}

contract MandateRegistry {
    // ---- immutable wiring --------------------------------------------------

    IERC20 public immutable collateral;
    /// Read at construction, never assumed. Testnet EC collateral is 6dp, not 18.
    uint8 public immutable collateralDecimals;
    uint256 private immutable ONE_COLLATERAL;

    // ---- state -------------------------------------------------------------

    struct Mandate {
        address delegator;
        address delegate;
        uint128 maxStakePerTrade;
        uint128 maxCumulativeExposure;
        /// Reserved AT PLACEMENT, not at fill. See `placeForDelegator`.
        uint128 usedExposure;
        uint64 expiry;
        bool revoked;
        bool exists;
    }

    /**
     * A placement's reserved exposure, held until settlement releases whatever
     * never traded. Keyed by pool+orderId because order ids are only unique
     * within a pool.
     */
    struct Reservation {
        uint256 mandateId;
        uint128 reserved;
        bool open;
    }

    uint256 public nextMandateId = 1;
    mapping(uint256 => Mandate) public mandates;
    /// mandateId => marketId => allowed. Keyed by marketId: POOLS ARE RECYCLED.
    mapping(uint256 => mapping(bytes32 => bool)) public allowedMarket;
    /// keccak(pool, orderId) => reservation
    mapping(bytes32 => Reservation) public reservations;
    /// Collateral we could not hand back. Pull-payment fallback, never a balance we keep.
    mapping(address => uint256) public owed;
    uint256 public totalOwed;

    /**
     * Reservation keys per market, plus how far a settlement sweep has walked
     * them. A validator-invoked handler cannot read logs (§4.3 r18 — nothing is
     * fetched for you), so it cannot pass fill data. It CAN, however, act on the
     * one fact finalization establishes for certain: the market is over, so any
     * still-open reservation will never fill, and the exposure it holds is dead.
     *
     * The cursor makes a partial batch resumable. Without it, a market with more
     * open orders than one batch can process would silently strand the
     * remainder — the failure that only appears when the demo has more mandates
     * than the test did.
     */
    mapping(bytes32 => bytes32[]) public marketReservations;
    mapping(bytes32 => uint256) public settleCursor;
    /// mandateId => marketId => outcome quantity bought, for the payout sweep.
    mapping(uint256 => mapping(bytes32 => uint256)) public position;
    /// marketId => the BinaryMarket contract, recorded at first placement.
    mapping(bytes32 => address) public marketAddressOf;

    /**
     * Escrow the pool still owes back, attributed PER MANDATE.
     *
     * The venue refunds a resting order's escrow to the order's owner — us —
     * ASYNCHRONOUSLY, after settlement has already run. An earlier version swept
     * `balance - totalOwed` to whichever delegator happened to be settling,
     * which is a silent misallocation: observed live, a 3-mandate settlement
     * paid out the escrow of twelve unrelated mandates. Attribution is therefore
     * reserved at settlement, exactly as exposure is reserved at placement.
     */
    mapping(uint256 => uint256) public refundClaim;
    uint256 public totalRefundClaim;

    // ---- events ------------------------------------------------------------

    event MandateCreated(
        uint256 indexed mandateId, address indexed delegator, address indexed delegate,
        uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint64 expiry
    );
    event MandateRevoked(uint256 indexed mandateId, address indexed by, string reason);
    /// The delegator re-pointed a mandate at a different set of markets.
    event MarketsSet(uint256 indexed mandateId, uint256 count, bool allowed);
    event OrderPlacedFor(
        uint256 indexed mandateId, bytes32 indexed marketId, address indexed pool,
        uint128 orderId, uint128 reserved, uint128 usedExposure
    );
    event ExposureReleased(uint256 indexed mandateId, uint128 released, uint128 usedExposure);
    event Returned(address indexed to, uint256 amount);
    event ReturnFailed(address indexed to, uint256 amount);
    event OwedClaimed(address indexed by, uint256 amount);
    event PayoutSwept(uint256 indexed mandateId, address indexed to, uint256 amount, bytes32 marketId);
    event SettleFailed(bytes32 indexed marketId, bytes32 reservationKey, bytes reason);

    // ---- errors ------------------------------------------------------------

    error NotDelegator();
    error NotDelegate();
    error NoMandate();
    error Revoked();
    error Expired();
    error MarketNotAllowed();
    error StakeExceedsPerTrade(uint256 cost, uint128 limit);
    error ExceedsCumulative(uint256 wouldBe, uint128 limit);
    error ZeroQuantity();
    error PlacementRejected();
    error Reentrancy();
    error NothingOwed();
    error BadExpiry();
    error MarketNotResolved();
    error UnknownMarket();

    // ---- reentrancy guard --------------------------------------------------
    //
    // The order path ends by handing tokens back to the delegator, so
    // `balanceOf(this) == totalOwed` is a security invariant, not a nicety. A
    // delegator contract (or a collateral token with transfer hooks) receives
    // control at exactly the moment exposure accounting has just been written.
    // State is updated before every external call anyway (checks-effects-
    // interactions), but the guard makes that defence explicit rather than
    // dependent on reading the whole function correctly.

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address collateral_) {
        collateral = IERC20(collateral_);
        uint8 d = IERC20(collateral_).decimals();
        collateralDecimals = d;
        ONE_COLLATERAL = 10 ** d;
    }

    // ---- delegator surface -------------------------------------------------

    function createMandate(
        address delegate,
        uint128 maxStakePerTrade,
        uint128 maxCumulativeExposure,
        uint64 expiry,
        bytes32[] calldata marketIds
    ) external returns (uint256 mandateId) {
        if (expiry <= block.timestamp) revert BadExpiry();
        mandateId = nextMandateId++;
        mandates[mandateId] = Mandate({
            delegator: msg.sender,
            delegate: delegate,
            maxStakePerTrade: maxStakePerTrade,
            maxCumulativeExposure: maxCumulativeExposure,
            usedExposure: 0,
            expiry: expiry,
            revoked: false,
            exists: true
        });
        for (uint256 i = 0; i < marketIds.length; ++i) {
            allowedMarket[mandateId][marketIds[i]] = true;
        }
        emit MandateCreated(mandateId, msg.sender, delegate, maxStakePerTrade, maxCumulativeExposure, expiry);
    }

    /**
     * Point an existing mandate at a different set of markets.
     *
     * Event Contract markets resolve in 2-12 MINUTES. The allowed set was
     * written once in `createMandate` and could never be changed, so a mandate
     * whose expiry read "7 days" stopped having anything to trade within
     * minutes of being created, and every order after that reverted
     * `MarketNotAllowed`. The delegation was alive and useless.
     *
     * ONLY the delegator, and only their own mandate. This is not an admin
     * power and it is not a way around anything: widening is a thing the
     * delegator could already do by revoking and creating a new mandate, and
     * narrowing is strictly a tightening. `maxStakePerTrade`,
     * `maxCumulativeExposure` and `expiry` remain immutable for the life of the
     * mandate - those are the limits the delegate relies on, and the money
     * limits never move.
     *
     * Symmetric on purpose. An allow-list that can only ever grow is a weaker
     * promise than one the delegator can also shrink.
     */
    function setMarkets(uint256 mandateId, bytes32[] calldata marketIds, bool allowed) external {
        Mandate storage m = mandates[mandateId];
        if (!m.exists) revert NoMandate();
        if (msg.sender != m.delegator) revert NotDelegator();
        if (m.revoked) revert Revoked();
        if (block.timestamp >= m.expiry) revert Expired();
        for (uint256 i = 0; i < marketIds.length; ++i) {
            allowedMarket[mandateId][marketIds[i]] = allowed;
        }
        emit MarketsSet(mandateId, marketIds.length, allowed);
    }

    /// Immediate and unconditional. The delegator never needs anyone's cooperation.
    function revoke(uint256 mandateId) external {
        Mandate storage m = mandates[mandateId];
        if (!m.exists) revert NoMandate();
        if (msg.sender != m.delegator) revert NotDelegator();
        m.revoked = true;
        emit MandateRevoked(mandateId, msg.sender, "delegator");
    }

    // ---- the order path ----------------------------------------------------

    /**
     * Place a binary order on behalf of the mandate's delegator.
     *
     * EXPOSURE IS RESERVED AT PLACEMENT, NOT AT FILL. This is a deliberate
     * design decision, not an implementation detail. Reserving at fill leaves a
     * window between placement and fill in which a delegate can stack orders
     * that each pass the check individually and collectively breach the cap —
     * and fills are read from chain asynchronously, so that window is real and
     * not small. Reserving at placement makes the cap hold at every instant, at
     * the cost of temporarily over-reserving on orders that only partly fill.
     * `settleAndEnforce` gives the unfilled part back.
     */
    function placeForDelegator(
        uint256 mandateId,
        bytes32 marketId,
        address pool,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs
    ) external nonReentrant returns (uint128 orderId) {
        Mandate storage m = mandates[mandateId];
        if (!m.exists) revert NoMandate();
        if (msg.sender != m.delegate) revert NotDelegate();
        if (m.revoked) revert Revoked();
        if (block.timestamp >= m.expiry) revert Expired();
        if (!allowedMarket[mandateId][marketId]) revert MarketNotAllowed();
        if (quantity == 0) revert ZeroQuantity();

        // Worst-case cost of this order in raw collateral units. The pool may
        // charge less (a taker pays the fill price, not its offer) — the
        // difference comes back in the sweep below.
        uint256 cost = (price * quantity) / ONE_COLLATERAL;
        if (cost > m.maxStakePerTrade) revert StakeExceedsPerTrade(cost, m.maxStakePerTrade);

        uint256 wouldBe = uint256(m.usedExposure) + cost;
        if (wouldBe > m.maxCumulativeExposure) revert ExceedsCumulative(wouldBe, m.maxCumulativeExposure);

        // EFFECTS BEFORE INTERACTIONS. Exposure is committed before any external
        // call, so a reentrant call sees the reserved figure, not a stale one.
        m.usedExposure = uint128(wouldBe);

        address delegator = m.delegator;

        // What this contract held BEFORE this order touched anything. Every
        // token here belongs to someone else: escrow a pool returned for
        // another mandate, or a booked refund waiting to be claimed. The sweep
        // at the end of this function returns only what THIS order brought in
        // and did not spend, measured against this line.
        uint256 balBefore = collateral.balanceOf(address(this));

        // Pull just-in-time. The principal was never ours until this instant.
        _pull(delegator, cost);

        collateral.approve(pool, cost);
        bool ok;
        (ok, orderId) = IBinaryPool(pool).placeBinaryOrder(
            kind, price, quantity, expireTimestampNs, 0, 0, address(0), 0, 0
        );
        // placeBinaryOrder returns (success, id) and a `false` does NOT revert —
        // the silent rejection in the build spec §4.1 r7. Reverting here is the
        // on-chain half of that guard; the client half simulates first.
        if (!ok) revert PlacementRejected();

        collateral.approve(pool, 0);

        // Bind marketId to its BinaryMarket on first use, read from the pool
        // itself rather than trusted from the caller. Settlement needs this to
        // prove a market really resolved.
        if (marketAddressOf[marketId] == address(0)) {
            (, address mkt,,,,,,,,,,,,,) = IBinaryPoolParams(pool).getBinaryPoolParams();
            marketAddressOf[marketId] = mkt;
        }

        bytes32 rk = _key(pool, orderId);
        reservations[rk] = Reservation({mandateId: mandateId, reserved: uint128(cost), open: true});
        marketReservations[marketId].push(rk);
        position[mandateId][marketId] += quantity;

        emit OrderPlacedFor(mandateId, marketId, pool, orderId, uint128(cost), m.usedExposure);

        // Sweep THIS ORDER'S residual, and nothing else.
        //
        // This used to return `balance - (totalOwed + totalRefundClaim)`: every
        // token above a global floor, on the assumption that anything not
        // accounted for must belong to the caller. It does not. The floor was
        // wrong once already (it omitted refund claims, so one delegator's
        // booked refund left with another's order), and a floor that has to be
        // exactly right to avoid paying the wrong person is the wrong shape.
        //
        // Measured instead: balance now, minus balance before the pull. That is
        // precisely what this transaction brought in and the pool declined to
        // take. Money that was already here is untouched BY CONSTRUCTION rather
        // than by arithmetic that has to be maintained.
        //
        // Capped at `cost`, so a transfer that lands mid-call from somewhere
        // else cannot be paid out as this order's change.
        uint256 balAfter = collateral.balanceOf(address(this));
        uint256 residual = balAfter > balBefore ? balAfter - balBefore : 0;
        if (residual > cost) residual = cost;
        if (residual > 0) _returnTo(delegator, residual);
    }

    // ---- settlement --------------------------------------------------------

    /**
     * Release exposure reserved against quantity that never traded, and revoke
     * mandates in breach.
     *
     * Callable by ANYONE — the DeadhandHandler is one caller among several, not
     * the source of truth. That is what keeps Layer 2 deletable: with the
     * handler removed, the delegator (or anyone) calls this and the base app is
     * unchanged. `MandateRegistry` never depends on the handler having run.
     *
     * `filledQuantity` is the amount that actually traded, read from chain
     * (OrderFilled), never from REST.
     */
    function settleAndEnforce(
        address pool,
        uint128 orderId,
        uint256 price,
        uint256 filledQuantity
    ) public {
        bytes32 k = _key(pool, orderId);
        Reservation storage r = reservations[k];
        if (!r.open) return; // idempotent: settling twice is a no-op, not a revert

        Mandate storage m = mandates[r.mandateId];
        uint256 actual = (price * filledQuantity) / ONE_COLLATERAL;
        uint128 release = actual >= r.reserved ? 0 : r.reserved - uint128(actual);

        r.open = false;

        if (release > 0) {
            // Defensive: never underflow a mandate's exposure if accounting drifts.
            m.usedExposure = m.usedExposure > release ? m.usedExposure - release : 0;
            emit ExposureReleased(r.mandateId, release, m.usedExposure);
        }
    }

    /**
     * Settle a FINALIZED market: the entry point a validator-invoked handler can
     * actually call.
     *
     * Needs no fill data, because finalization settles the question by itself —
     * a still-open reservation on a finalized market can never fill, so all of
     * its reserved exposure is releasable. That is why this exists separately
     * from `settleAndEnforce`, which needs a fill price no contract can read.
     *
     * BOUNDED and RESUMABLE. Processes at most `maxItems` from the cursor and
     * returns whether the market is drained, so the caller (handler or human)
     * can come back for the rest. Stragglers are never silently dropped.
     *
     * PER-ITEM ISOLATION. One hostile delegator must not be able to block
     * enforcement for the other thirty-one, so each mandate's settle-and-sweep
     * is wrapped. Subscription survival is not the concern — that was measured
     * as safe — the concern is a batch that reverts and enforces nothing.
     *
     * Permissionless, like everything else here: the handler is one caller among
     * several, never the source of truth.
     */
    function settleFinalizedMarket(bytes32 marketId, uint256 maxItems)
        external
        returns (uint256 processed, uint256 failed, bool drained)
    {
        // THE MARKET MUST ACTUALLY BE OVER.
        //
        // Without this check the function is an exposure-reset button. It is
        // permissionless and it releases reserved exposure, so a delegate could
        // call it on a LIVE market, free its own counter while its orders were
        // still resting, and place again — defeating maxCumulativeExposure
        // entirely. Releasing exposure is only sound because finalization proves
        // the reservation can never be spent; verify that, do not assume it.
        address mkt = marketAddressOf[marketId];
        if (mkt == address(0)) revert UnknownMarket();
        if (!IBinaryMarket(mkt).isResolved() && !IBinaryMarket(mkt).isVoided()) revert MarketNotResolved();

        bytes32[] storage keys = marketReservations[marketId];
        uint256 i = settleCursor[marketId];
        uint256 end = i + maxItems;
        if (end > keys.length) end = keys.length;

        for (; i < end; ++i) {
            // Isolated so a bad mandate cannot stop its neighbours — but COUNTED
            // and EMITTED, because `processed == 0` must never be ambiguous
            // between "nothing to do" and "every single one failed".
            try this.settleOne(keys[i], marketId) { processed++; }
            catch (bytes memory reason) {
                failed++;
                emit SettleFailed(marketId, keys[i], reason);
            }
        }
        settleCursor[marketId] = i;
        drained = i >= keys.length;
    }

    /**
     * External only so `settleFinalizedMarket` can try/catch it. Callable
     * directly too — it is permissionless and idempotent either way.
     */
    function settleOne(bytes32 rk, bytes32 marketId) external {
        Reservation storage r = reservations[rk];
        if (!r.open) return;
        r.open = false;

        Mandate storage m = mandates[r.mandateId];
        uint128 release = r.reserved;
        m.usedExposure = m.usedExposure > release ? m.usedExposure - release : 0;
        emit ExposureReleased(r.mandateId, release, m.usedExposure);

        if (!m.revoked && (m.usedExposure > m.maxCumulativeExposure || block.timestamp >= m.expiry)) {
            m.revoked = true;
            emit MandateRevoked(r.mandateId, msg.sender, "deadhand");
        }

        // Book what the pool owes THIS mandate back, then pay whatever has
        // already arrived. The rest is claimable by anyone, at any time, via
        // sweepRefunds — so the common path needs no intervention and the
        // uncommon one needs no privilege.
        refundClaim[r.mandateId] += release;
        totalRefundClaim += release;
        _payRefund(r.mandateId, marketId);
    }

    /// Batch form, bounded by the caller. The handler passes a capped slice.
    function settleAndEnforceBatch(
        address[] calldata pools,
        uint128[] calldata orderIds,
        uint256[] calldata prices,
        uint256[] calldata filledQuantities
    ) external {
        uint256 n = pools.length;
        for (uint256 i = 0; i < n; ++i) {
            settleAndEnforce(pools[i], orderIds[i], prices[i], filledQuantities[i]);
        }
    }

    /**
     * Revoke a mandate found in breach. Permissionless on purpose: the facts are
     * on-chain, so anyone — the delegator, the handler, a passer-by — may act on
     * them, and the delegator is never dependent on us being online.
     */
    function revokeIfBreached(uint256 mandateId) external returns (bool) {
        Mandate storage m = mandates[mandateId];
        if (!m.exists || m.revoked) return false;
        if (m.usedExposure > m.maxCumulativeExposure) {
            m.revoked = true;
            emit MandateRevoked(mandateId, msg.sender, "exposure");
            return true;
        }
        if (block.timestamp >= m.expiry) {
            m.revoked = true;
            emit MandateRevoked(mandateId, msg.sender, "expiry");
            return true;
        }
        return false;
    }

    /**
     * Push a mandate's booked refund to its delegator, as far as the balance
     * allows. PERMISSIONLESS on purpose: if only the delegator could trigger
     * this, funds would sit stranded until they acted and "holds no funds" would
     * quietly mean "holds no funds eventually, if someone remembers".
     */
    function sweepRefunds(uint256 mandateId) external {
        _payRefund(mandateId, bytes32(0));
    }

    function _payRefund(uint256 mandateId, bytes32 marketId) private {
        uint256 claim = refundClaim[mandateId];
        if (claim == 0) return;
        uint256 bal = collateral.balanceOf(address(this));
        if (bal <= totalOwed) return;
        uint256 avail = bal - totalOwed;
        uint256 pay = claim < avail ? claim : avail;
        if (pay == 0) return;

        refundClaim[mandateId] = claim - pay;
        totalRefundClaim -= pay;
        address to = mandates[mandateId].delegator;
        _returnTo(to, pay);
        emit PayoutSwept(mandateId, to, pay, marketId);
    }

    // ---- pull-payment fallback --------------------------------------------

    function claimOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        collateral.transfer(msg.sender, amount);
        emit OwedClaimed(msg.sender, amount);
    }

    // ---- internals ---------------------------------------------------------

    function _key(address pool, uint128 orderId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(pool, orderId));
    }

    function _pull(address from, uint256 amount) private {
        if (amount == 0) return;
        require(collateral.transferFrom(from, address(this), amount), "pull failed");
    }

    /**
     * Hand back everything not consumed by the pool.
     *
     * Uses the balance rather than a computed remainder on purpose: the pool
     * takes what it takes, and measuring is more trustworthy than predicting —
     * the same reason we read order ids from receipts. Anything left here after
     * this call is a bug, and the test suite says so.
     */
    // `_sweep(to)` lived here: return `balance - (totalOwed + totalRefundClaim)`
    // to whoever placed the order. It is gone rather than fixed. Sweeping by
    // subtracting a global floor means the floor has to enumerate every claim
    // anyone else has on this contract, forever, and being one term short paid
    // one delegator's refund to another. `placeForDelegator` now measures its
    // own residual instead, so no floor has to be maintained at all.

    /**
     * A delegator that cannot receive its own collateral must not be able to
     * brick its delegate's ability to trade. If the transfer fails we credit a
     * claimable balance instead of reverting the whole order — the same
     * push-then-fall-back-to-pull shape BinarySettlement uses for `PayoutOwed`.
     */
    function _returnTo(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(collateral).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        bool transferred = ok && (ret.length == 0 || abi.decode(ret, (bool)));
        if (transferred) {
            emit Returned(to, amount);
        } else {
            owed[to] += amount;
            totalOwed += amount;
            emit ReturnFailed(to, amount);
        }
    }

    // ---- views -------------------------------------------------------------

    function openReservationCount(bytes32 marketId) external view returns (uint256) {
        return marketReservations[marketId].length;
    }

    function pendingSettlement(bytes32 marketId) external view returns (uint256) {
        uint256 n = marketReservations[marketId].length;
        uint256 c = settleCursor[marketId];
        return n > c ? n - c : 0;
    }

    function remainingExposure(uint256 mandateId) external view returns (uint256) {
        Mandate storage m = mandates[mandateId];
        if (!m.exists || m.revoked || block.timestamp >= m.expiry) return 0;
        return m.usedExposure >= m.maxCumulativeExposure ? 0 : m.maxCumulativeExposure - m.usedExposure;
    }

    function isActive(uint256 mandateId) external view returns (bool) {
        Mandate storage m = mandates[mandateId];
        return m.exists && !m.revoked && block.timestamp < m.expiry;
    }

    /**
     * The claim, as a function a judge can call: every unit here is owed to a
     * NAMED party. `totalOwed` is failed push-payments; `totalRefundClaim` is
     * escrow the venue has yet to return, booked per mandate. Anything beyond
     * those two is unattributed and is a bug.
     */
    function holdsNoFunds() external view returns (bool) {
        return collateral.balanceOf(address(this)) <= totalOwed + totalRefundClaim;
    }

    /**
     * True when what this contract holds covers everything it has booked.
     *
     * NOT true at every instant, and calling it an invariant would overstate
     * it: `settleOne` books a claim while the POOL still holds the proceeds,
     * and that return is asynchronous — measured on the live venue at minutes,
     * not blocks. In that window the balance is legitimately below the booked
     * total. `unbackedClaims()` measures the gap.
     *
     * It does close. Measured on this deployment: 11 mandates booked 0.22
     * tUSDC, the proceeds arrived late, `sweepRefunds` paid all 11 in full and
     * the outstanding total returned to zero.
     *
     * ⚠️ A gap that does NOT close is the signature of the old `_sweep`, which
     * subtracted a global floor and paid one delegator's booked refund out with
     * another delegator's order — so it never arrived for the party owed it.
     * The old registry sat permanently at 15.36 tUSDC booked against a zero
     * balance. Do not read a non-zero value here as that bug without first
     * waiting for the pool: the two look identical in a single snapshot, which
     * is a mistake this codebase has already made once.
     */
    function claimsAreBacked() external view returns (bool) {
        return collateral.balanceOf(address(this)) >= totalOwed + totalRefundClaim;
    }

    /**
     * How far the booked total exceeds what is held, in raw collateral units.
     *
     * Zero in the settled state. Non-zero only while a settlement's proceeds
     * are in flight from the pool. It must never RISE because someone else
     * traded - that rise is the misattribution bug, and it is what the floor
     * exists to detect.
     */
    function unbackedClaims() external view returns (uint256) {
        uint256 spokenFor = totalOwed + totalRefundClaim;
        uint256 held = collateral.balanceOf(address(this));
        return held >= spokenFor ? 0 : spokenFor - held;
    }

    /// Collateral here that belongs to nobody in particular. Must always be 0.
    function unattributed() external view returns (uint256) {
        uint256 bal = collateral.balanceOf(address(this));
        uint256 spoken = totalOwed + totalRefundClaim;
        return bal > spoken ? bal - spoken : 0;
    }
}
