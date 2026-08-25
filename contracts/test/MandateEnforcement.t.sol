// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MockUSDC, MockBinaryPool, ReentrantDelegator} from "./Mocks.sol";

/**
 * Suite 1 of 2: MANDATE ENFORCEMENT.
 *
 * Per CLAUDE.md §7 the only tests we write are enforcement and revocation,
 * because those two paths ARE the security claim and everything else is demo
 * surface. So these are adversarial cases, not happy paths — a limit that holds
 * at 100 and fails at 101 is only proven by testing 100 and 101.
 */
contract MandateEnforcementTest is Test {
    MandateRegistry reg;
    MockUSDC usdc;
    MockBinaryPool pool;

    address delegator = address(0xD1);
    address delegate = address(0xDE);
    address stranger = address(0x57);

    bytes32 constant MARKET = bytes32(uint256(0xBEEF));
    bytes32 constant OTHER_MARKET = bytes32(uint256(0xCAFE));

    uint64 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        pool = new MockBinaryPool(usdc);
        reg = new MandateRegistry(address(usdc));
        expiry = uint64(block.timestamp + 1 days);

        usdc.mint(delegator, 1_000_000_000); // 1000 tUSDC at 6dp
        vm.prank(delegator);
        usdc.approve(address(reg), type(uint256).max);
    }

    function _mandate(uint128 perTrade, uint128 cumulative) internal returns (uint256 id) {
        bytes32[] memory ms = new bytes32[](1);
        ms[0] = MARKET;
        vm.prank(delegator);
        id = reg.createMandate(delegate, perTrade, cumulative, expiry, ms);
    }

    /// price*qty/1e6 == cost. qty 1e6 (one share) makes cost == price.
    function _place(uint256 id, uint256 price, uint256 qty) internal returns (uint128) {
        vm.prank(delegate);
        return reg.placeForDelegator(id, MARKET, address(pool), 0, price, qty, uint64(block.timestamp + 60));
    }

    // ---- the headline invariant -------------------------------------------

    function test_holdsNoFunds_afterEveryOrderPath() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        assertTrue(reg.holdsNoFunds(), "clean at start");

        pool.setConsumeBps(10_000);
        _place(id, 500_000, 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 0, "full consume leaves nothing");
        assertTrue(reg.holdsNoFunds());

        // Partial consume: the pool takes less than offered, remainder must be swept.
        pool.setConsumeBps(6_000);
        _place(id, 500_000, 1_000_000);
        assertEq(usdc.balanceOf(address(reg)), 0, "residual MUST be swept in the same tx");
        assertTrue(reg.holdsNoFunds(), "the no-custody claim, asserted not described");
    }

    // ---- boundary: maxStakePerTrade ---------------------------------------

    function test_exactlyAtPerTradeLimit_isAllowed() public {
        uint256 id = _mandate(500_000, 10_000_000);
        _place(id, 500_000, 1_000_000); // cost == 500_000 == limit
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 500_000);
    }

    function test_oneUnitOverPerTradeLimit_reverts() public {
        uint256 id = _mandate(500_000, 10_000_000);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRegistry.StakeExceedsPerTrade.selector, uint256(500_001), uint128(500_000))
        );
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_001, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- boundary: cumulative exposure ------------------------------------

    function test_cumulativeLandingExactlyOnCap_isAllowed() public {
        uint256 id = _mandate(500_000, 1_000_000);
        _place(id, 500_000, 1_000_000);
        _place(id, 500_000, 1_000_000); // total exactly 1_000_000 == cap
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 1_000_000, "landing precisely on the cap is permitted");
        assertEq(reg.remainingExposure(id), 0);
    }

    function test_oneUnitPastCumulativeCap_reverts() public {
        uint256 id = _mandate(600_000, 1_000_000);
        _place(id, 500_000, 1_000_000);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRegistry.ExceedsCumulative.selector, uint256(1_000_001), uint128(1_000_000))
        );
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_001, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- the in-flight stacking window ------------------------------------

    /**
     * THE case that motivates reserving at placement rather than at fill.
     *
     * Two orders that each pass the per-trade check and collectively breach the
     * cumulative cap, sent before either settles. If exposure were reserved at
     * fill, both would pass and the cap would be a suggestion.
     */
    function test_stackingOrdersBeforeSettlement_cannotBreachCap() public {
        uint256 id = _mandate(700_000, 1_000_000);
        _place(id, 700_000, 1_000_000); // used = 700_000
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRegistry.ExceedsCumulative.selector, uint256(1_400_000), uint128(1_000_000))
        );
        // Individually fine (700_000 <= 700_000), collectively 1_400_000 > cap.
        reg.placeForDelegator(id, MARKET, address(pool), 0, 700_000, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- partial fills release exposure -----------------------------------

    /**
     * A resting order that only partly fills leaves exposure reserved against
     * quantity that never traded. Without release, a mandate silently erodes
     * across a session and rehearsal fifteen behaves differently from rehearsal
     * one.
     */
    function test_partialFill_releasesUnfilledExposure() public {
        uint256 id = _mandate(1_000_000, 1_000_000);
        uint128 orderId = _place(id, 1_000_000, 1_000_000); // reserve 1_000_000, cap reached
        (,,,, uint128 usedBefore,,,) = reg.mandates(id);
        assertEq(usedBefore, 1_000_000);
        assertEq(reg.remainingExposure(id), 0, "fully reserved");

        // Only 40% actually traded.
        reg.settleAndEnforce(address(pool), orderId, 1_000_000, 400_000);

        (,,,, uint128 usedAfter,,,) = reg.mandates(id);
        assertEq(usedAfter, 400_000, "only the filled part stays reserved");
        assertEq(reg.remainingExposure(id), 600_000, "the rest is usable again");
    }

    function test_settlementIsIdempotent() public {
        uint256 id = _mandate(1_000_000, 1_000_000);
        uint128 orderId = _place(id, 1_000_000, 1_000_000);
        reg.settleAndEnforce(address(pool), orderId, 1_000_000, 400_000);
        reg.settleAndEnforce(address(pool), orderId, 1_000_000, 400_000); // no-op, must not double-release
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 400_000, "settling twice must not release twice");
    }

    /// Anyone may settle — that is what keeps Layer 2 deletable.
    function test_anyoneCanSettle_notJustTheHandler() public {
        uint256 id = _mandate(1_000_000, 1_000_000);
        uint128 orderId = _place(id, 1_000_000, 1_000_000);
        vm.prank(stranger);
        reg.settleAndEnforce(address(pool), orderId, 1_000_000, 0);
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 0, "a stranger settling an unfilled order restores exposure");
    }

    // ---- expiry boundary ---------------------------------------------------

    function test_orderAtExpiryMinusOne_isAllowed() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.warp(expiry - 1);
        _place(id, 500_000, 1_000_000);
    }

    function test_orderExactlyAtExpiry_reverts() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.warp(expiry); // expiry is exclusive: block.timestamp >= expiry is dead
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.Expired.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    function test_orderAfterExpiry_reverts() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.warp(expiry + 1);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.Expired.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- market allowlist --------------------------------------------------

    function test_marketOutsideAllowlist_reverts() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.MarketNotAllowed.selector);
        reg.placeForDelegator(id, OTHER_MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- caller identity ---------------------------------------------------

    function test_strangerCannotPlace() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(stranger);
        vm.expectRevert(MandateRegistry.NotDelegate.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    /// Demo beat 1: the delegate has no withdrawal path at all, by construction.
    function test_delegatorCannotPlace_onlyTheDelegateTrades() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegator);
        vm.expectRevert(MandateRegistry.NotDelegate.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- silent rejection --------------------------------------------------

    function test_poolReturningFalse_reverts_notSilentSuccess() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        pool.setSucceed(false);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.PlacementRejected.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    function test_zeroQuantity_reverts() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.ZeroQuantity.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 0, uint64(block.timestamp + 60));
    }

    // ---- griefing: a delegator that cannot be paid -------------------------

    /**
     * A delegator who cannot receive its own collateral must NOT be able to
     * wedge its delegate's ability to trade. The sweep falls back to a claimable
     * balance instead of reverting the order.
     */
    function test_delegatorThatCannotReceive_doesNotBrickTrading() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        pool.setConsumeBps(6_000);      // 40% will need returning
        usdc.setBlocked(delegator, true);

        _place(id, 500_000, 1_000_000); // must NOT revert

        assertEq(reg.owed(delegator), 200_000, "unreturnable remainder becomes claimable");
        assertEq(reg.totalOwed(), 200_000);
        assertTrue(reg.holdsNoFunds(), "balance == totalOwed, still holding nothing of our own");

        // And it can be recovered once the delegator is receivable again.
        usdc.setBlocked(delegator, false);
        uint256 pre = usdc.balanceOf(delegator);
        vm.prank(delegator);
        reg.claimOwed();
        assertEq(usdc.balanceOf(delegator) - pre, 200_000);
        assertEq(usdc.balanceOf(address(reg)), 0);
    }

    // ---- reentrancy --------------------------------------------------------

    /**
     * The real attack shape: the delegator is paid during the sweep and reenters
     * `placeForDelegator` at that exact instant, while the order path is still
     * open and exposure has just been written.
     *
     * Two defences must both hold. Exposure is committed BEFORE any external
     * call (checks-effects-interactions), so a reentrant caller could not see a
     * stale figure even if it got in; and the guard means it does not get in at
     * all. This asserts the guard actually fired, rather than asserting an
     * outcome that would also occur if the callback never happened.
     */
    function test_reentrantPlace_duringSweep_isRejected() public {
        ReentrantDelegator evil = new ReentrantDelegator();
        usdc.mint(address(evil), 100_000_000);
        usdc.setHooked(address(evil), true);
        vm.prank(address(evil));
        usdc.approve(address(reg), type(uint256).max);

        bytes32[] memory ms = new bytes32[](1);
        ms[0] = MARKET;
        vm.prank(address(evil));
        uint256 id = reg.createMandate(address(evil), 1_000_000, 10_000_000, expiry, ms);

        // Leave a remainder so the sweep actually pays the delegator back,
        // which is what triggers the callback.
        pool.setConsumeBps(5_000);
        bytes memory payload = abi.encodeWithSelector(
            MandateRegistry.placeForDelegator.selector,
            id, MARKET, address(pool), uint8(0), uint256(500_000), uint256(1_000_000), uint64(block.timestamp + 60)
        );
        evil.arm(address(reg), payload);

        vm.prank(address(evil));
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));

        assertTrue(evil.reentryAttempted(), "the callback must actually have fired");
        assertTrue(evil.reentryReverted(), "and the reentrant call must have been rejected");

        // Exactly one order got through, so exposure reflects one placement.
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 500_000, "reentry must not have reserved a second time");
        assertTrue(reg.holdsNoFunds());
    }

    // ---- Deadhand settlement: bounded, resumable, isolated -----------------

    function _mandateFor(address who, uint128 perTrade, uint128 cum) internal returns (uint256 id) {
        usdc.mint(who, 1_000_000_000);
        vm.prank(who);
        usdc.approve(address(reg), type(uint256).max);
        bytes32[] memory ms = new bytes32[](1);
        ms[0] = MARKET;
        vm.prank(who);
        id = reg.createMandate(who, perTrade, cum, expiry, ms);
    }

    /**
     * A market with more open reservations than one batch can process must not
     * strand the remainder. The cursor is what makes that true, and this is the
     * failure that only shows up when the demo has more mandates than the test.
     */
    function test_settleFinalizedMarket_isBoundedAndResumable() public {
        uint256 id = _mandate(1_000_000, 100_000_000);
        for (uint256 i = 0; i < 5; ++i) _place(id, 500_000, 1_000_000);
        assertEq(reg.pendingSettlement(MARKET), 5);

        pool.market().setResolved(true);
        (uint256 p1,, bool d1) = reg.settleFinalizedMarket(MARKET, 2);
        assertEq(p1, 2); assertFalse(d1, "not drained after 2 of 5");
        assertEq(reg.pendingSettlement(MARKET), 3);

        (uint256 p2,, bool d2) = reg.settleFinalizedMarket(MARKET, 2);
        assertEq(p2, 2); assertFalse(d2);

        (uint256 p3,, bool d3) = reg.settleFinalizedMarket(MARKET, 2);
        assertEq(p3, 1, "only the straggler remained");
        assertTrue(d3, "drained");
        assertEq(reg.pendingSettlement(MARKET), 0);

        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 0, "all dead exposure released across the three batches");
    }

    /**
     * One hostile delegator must not block enforcement for its neighbours. The
     * concern is not subscription survival — that was measured as safe — it is a
     * batch that reverts and enforces nothing for the other mandates in it.
     */
    function test_settleFinalizedMarket_isolatesAHostileDelegator() public {
        address hostile = address(0xBAD);
        uint256 idA = _mandate(1_000_000, 10_000_000);
        uint256 idB = _mandateFor(hostile, 1_000_000, 10_000_000);

        _place(idA, 500_000, 1_000_000);
        vm.prank(hostile);
        reg.placeForDelegator(idB, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));

        // Now make paying the hostile delegator revert outright.
        usdc.setReverting(hostile, true);
        pool.setConsumeBps(5_000); // leave a remainder so a sweep is attempted

        pool.market().setResolved(true);
        (uint256 processed,, bool drained) = reg.settleFinalizedMarket(MARKET, 10);
        assertTrue(drained, "batch completed despite a hostile member");
        assertGe(processed, 1, "at least the honest mandate settled");

        (,,,, uint128 usedA,,,) = reg.mandates(idA);
        assertEq(usedA, 0, "the honest mandate was enforced regardless");
    }

    function test_settleFinalizedMarket_revokesBreachedOnSettle() public {
        uint256 id = _mandate(1_000_000, 1_000_000);
        _place(id, 1_000_000, 1_000_000);
        vm.warp(expiry + 1); // expiry is a breach condition
        pool.market().setResolved(true);
        reg.settleFinalizedMarket(MARKET, 10);
        (,,,,, , bool revoked,) = reg.mandates(id);
        assertTrue(revoked, "the deadhand revokes on settle");
    }

    function test_settleFinalizedMarket_isIdempotent() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        _place(id, 500_000, 1_000_000);
        pool.market().setResolved(true);
        reg.settleFinalizedMarket(MARKET, 10);
        (,,,, uint128 a,,,) = reg.mandates(id);
        pool.market().setResolved(true);
        reg.settleFinalizedMarket(MARKET, 10); // cursor is exhausted; must be a no-op
        (,,,, uint128 b,,,) = reg.mandates(id);
        assertEq(a, b, "re-settling must not double-release");
    }

    /**
     * THE EXPLOIT THIS CHECK EXISTS FOR.
     *
     * settleFinalizedMarket is permissionless and releases reserved exposure.
     * Without proof that the market actually resolved it is an exposure-reset
     * button: a delegate frees its own counter while its orders are still
     * resting, then places again, and maxCumulativeExposure means nothing.
     */
    function test_cannotReleaseExposureOnALiveMarket() public {
        uint256 id = _mandate(700_000, 1_000_000);
        _place(id, 700_000, 1_000_000);
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 700_000);

        // Market is still live.
        vm.expectRevert(MandateRegistry.MarketNotResolved.selector);
        reg.settleFinalizedMarket(MARKET, 10);

        (,,,, uint128 stillUsed,,,) = reg.mandates(id);
        assertEq(stillUsed, 700_000, "exposure must NOT be releasable early");

        // And the cap still bites, which is the point.
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(MandateRegistry.ExceedsCumulative.selector, uint256(1_400_000), uint128(1_000_000))
        );
        reg.placeForDelegator(id, MARKET, address(pool), 0, 700_000, 1_000_000, uint64(block.timestamp + 60));
    }

    function test_voidedMarketAlsoSettles() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        _place(id, 500_000, 1_000_000);
        pool.market().setVoided(true);
        (uint256 n,,) = reg.settleFinalizedMarket(MARKET, 10);
        assertEq(n, 1, "a voided market is over too");
    }

    function test_settleUnknownMarket_reverts() public {
        vm.expectRevert(MandateRegistry.UnknownMarket.selector);
        reg.settleFinalizedMarket(bytes32(uint256(0xDEAD)), 10);
    }

    // ---- asynchronous escrow: the defect the mock was hiding ---------------

    /**
     * The venue refunds a resting order's escrow to the order owner — us —
     * AFTER settlement has run. The mock refunds synchronously, so
     * holdsNoFunds() stayed green in this suite while the deployed registry
     * held 0.24 tUSDC. This reproduces the real ordering.
     */
    function test_lateEscrow_isAttributedToTheRightMandate() public {
        address other = address(0xA11CE);
        uint256 idA = _mandate(1_000_000, 10_000_000);
        uint256 idB = _mandateFor(other, 1_000_000, 10_000_000);

        _place(idA, 500_000, 1_000_000);
        vm.prank(other);
        reg.placeForDelegator(idB, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));

        pool.market().setResolved(true);
        reg.settleFinalizedMarket(MARKET, 10);

        // Escrow arrives LATE, as a lump, after settlement.
        usdc.mint(address(reg), 1_000_000);

        assertEq(reg.refundClaim(idA), 500_000, "A is owed its own escrow");
        assertEq(reg.refundClaim(idB), 500_000, "B is owed its own escrow");

        uint256 aBefore = usdc.balanceOf(delegator);
        uint256 bBefore = usdc.balanceOf(other);

        // Anyone can trigger it — no privilege, no waiting on the delegator.
        vm.prank(stranger);
        reg.sweepRefunds(idA);
        vm.prank(stranger);
        reg.sweepRefunds(idB);

        assertEq(usdc.balanceOf(delegator) - aBefore, 500_000, "A got exactly its own");
        assertEq(usdc.balanceOf(other) - bBefore, 500_000, "B got exactly its own");
        assertEq(reg.unattributed(), 0, "nothing belongs to nobody");
        assertTrue(reg.holdsNoFunds());
    }

    /**
     * The misallocation this replaced: a pooled sweep paid one delegator the
     * escrow of unrelated mandates. Observed live before the fix.
     */
    function test_settlingOneMandateDoesNotPayItAnothersEscrow() public {
        address other = address(0xA11CE);
        uint256 idA = _mandate(1_000_000, 10_000_000);
        uint256 idB = _mandateFor(other, 1_000_000, 10_000_000);
        _place(idA, 500_000, 1_000_000);
        vm.prank(other);
        reg.placeForDelegator(idB, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));

        pool.market().setResolved(true);
        reg.settleFinalizedMarket(MARKET, 10);
        usdc.mint(address(reg), 1_000_000); // both escrows arrive together

        uint256 aBefore = usdc.balanceOf(delegator);
        reg.sweepRefunds(idA);
        assertEq(usdc.balanceOf(delegator) - aBefore, 500_000, "A must NOT receive B's escrow");
        assertEq(reg.refundClaim(idB), 500_000, "B's claim survives untouched");
    }
}
