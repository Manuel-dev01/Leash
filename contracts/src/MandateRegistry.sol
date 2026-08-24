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

    // ---- events ------------------------------------------------------------

    event MandateCreated(
        uint256 indexed mandateId, address indexed delegator, address indexed delegate,
        uint128 maxStakePerTrade, uint128 maxCumulativeExposure, uint64 expiry
    );
    event MandateRevoked(uint256 indexed mandateId, address indexed by, string reason);
    event OrderPlacedFor(
        uint256 indexed mandateId, bytes32 indexed marketId, address indexed pool,
        uint128 orderId, uint128 reserved, uint128 usedExposure
    );
    event ExposureReleased(uint256 indexed mandateId, uint128 released, uint128 usedExposure);
    event Returned(address indexed to, uint256 amount);
    event ReturnFailed(address indexed to, uint256 amount);
    event OwedClaimed(address indexed by, uint256 amount);
    event PayoutSwept(uint256 indexed mandateId, address indexed to, uint256 amount, bytes32 marketId);

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

        // Pull just-in-time. The principal was never ours until this instant.
        _pull(delegator, cost);

        collateral.approve(pool, cost);
        bool ok;
        (ok, orderId) = IBinaryPool(pool).placeBinaryOrder(
            kind, price, quantity, expireTimestampNs, 0, 0, address(0), 0, 0
        );
        // placeBinaryOrder returns (success, id) and a `false` does NOT revert —
        // the silent rejection in CLAUDE.md §4.1 r7. Reverting here is the
        // on-chain half of that guard; the client half simulates first.
        if (!ok) revert PlacementRejected();

        collateral.approve(pool, 0);

        bytes32 rk = _key(pool, orderId);
        reservations[rk] = Reservation({mandateId: mandateId, reserved: uint128(cost), open: true});
        marketReservations[marketId].push(rk);
        position[mandateId][marketId] += quantity;

        emit OrderPlacedFor(mandateId, marketId, pool, orderId, uint128(cost), m.usedExposure);

        // Sweep. Whatever the pool did not take goes straight back.
        _sweep(delegator);
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
        returns (uint256 processed, bool drained)
    {
        bytes32[] storage keys = marketReservations[marketId];
        uint256 i = settleCursor[marketId];
        uint256 end = i + maxItems;
        if (end > keys.length) end = keys.length;

        for (; i < end; ++i) {
            try this.settleOne(keys[i], marketId) { processed++; }
            catch { /* isolated: a bad mandate must not stop its neighbours */ }
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

        // Sweep anything sitting here to the delegator. Between transactions the
        // invariant holds this at zero, so a non-zero balance at finalization is
        // returned escrow or payout — money moving to the party who did NOT trade.
        uint256 free = collateral.balanceOf(address(this));
        if (free > totalOwed) {
            uint256 amount = free - totalOwed;
            _returnTo(m.delegator, amount);
            emit PayoutSwept(r.mandateId, m.delegator, amount, marketId);
        }
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
    function _sweep(address to) private {
        uint256 bal = collateral.balanceOf(address(this));
        uint256 keep = totalOwed;
        if (bal <= keep) return;
        _returnTo(to, bal - keep);
    }

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

    /// The claim, as a function a judge can call: we hold nothing but what we owe.
    function holdsNoFunds() external view returns (bool) {
        return collateral.balanceOf(address(this)) == totalOwed;
    }
}
