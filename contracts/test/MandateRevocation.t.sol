// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {MockUSDC, MockBinaryPool} from "./Mocks.sol";

/**
 * Suite 2 of 2: REVOCATION.
 *
 * The other half of the security claim. A limit that cannot be withdrawn is not
 * a mandate, it is a standing order — so revocation has to be immediate,
 * unconditional, and available to the delegator without anyone's cooperation.
 */
contract MandateRevocationTest is Test {
    MandateRegistry reg;
    MockUSDC usdc;
    MockBinaryPool pool;

    address delegator = address(0xD1);
    address delegate = address(0xDE);
    address stranger = address(0x57);

    bytes32 constant MARKET = bytes32(uint256(0xBEEF));
    uint64 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        pool = new MockBinaryPool(usdc);
        reg = new MandateRegistry(address(usdc));
        expiry = uint64(block.timestamp + 1 days);
        usdc.mint(delegator, 1_000_000_000);
        vm.prank(delegator);
        usdc.approve(address(reg), type(uint256).max);
    }

    function _mandate(uint128 perTrade, uint128 cumulative) internal returns (uint256 id) {
        bytes32[] memory ms = new bytes32[](1);
        ms[0] = MARKET;
        vm.prank(delegator);
        id = reg.createMandate(delegate, perTrade, cumulative, expiry, ms);
    }

    function _place(uint256 id, uint256 price) internal returns (uint128) {
        vm.prank(delegate);
        return reg.placeForDelegator(id, MARKET, address(pool), 0, price, 1_000_000, uint64(block.timestamp + 60));
    }

    // ---- delegator revocation ---------------------------------------------

    function test_delegatorRevokes_immediately() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        assertTrue(reg.isActive(id));
        vm.prank(delegator);
        reg.revoke(id);
        assertFalse(reg.isActive(id));
    }

    function test_revokedMandate_cannotPlace() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegator);
        reg.revoke(id);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.Revoked.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    function test_revocationTakesEffectMidSession() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        _place(id, 500_000); // works
        vm.prank(delegator);
        reg.revoke(id);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.Revoked.selector);
        reg.placeForDelegator(id, MARKET, address(pool), 0, 500_000, 1_000_000, uint64(block.timestamp + 60));
    }

    function test_onlyDelegatorCanRevoke() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(stranger);
        vm.expectRevert(MandateRegistry.NotDelegator.selector);
        reg.revoke(id);
        vm.prank(delegate);
        vm.expectRevert(MandateRegistry.NotDelegator.selector);
        reg.revoke(id);
        assertTrue(reg.isActive(id), "still active after both failed attempts");
    }

    function test_revokeIsIdempotent() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegator);
        reg.revoke(id);
        vm.prank(delegator);
        reg.revoke(id); // must not revert
        assertFalse(reg.isActive(id));
    }

    function test_revokeUnknownMandate_reverts() public {
        vm.prank(delegator);
        vm.expectRevert(MandateRegistry.NoMandate.selector);
        reg.revoke(999);
    }

    // ---- expiry is revocation by clock ------------------------------------

    function test_expiryDeactivatesWithoutAnyTransaction() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        assertTrue(reg.isActive(id));
        vm.warp(expiry);
        assertFalse(reg.isActive(id), "no transaction required, the clock does it");
        assertEq(reg.remainingExposure(id), 0);
    }

    function test_cannotCreateAlreadyExpiredMandate() public {
        bytes32[] memory ms = new bytes32[](1);
        ms[0] = MARKET;
        vm.prank(delegator);
        vm.expectRevert(MandateRegistry.BadExpiry.selector);
        reg.createMandate(delegate, 1_000_000, 10_000_000, uint64(block.timestamp), ms);
    }

    // ---- permissionless breach revocation ---------------------------------

    /**
     * The facts are on-chain, so anyone may act on them. This is what lets the
     * DeadhandHandler revoke without being privileged — and what lets the
     * delegator do it themselves if Layer 2 is deleted entirely.
     */
    function test_expiredMandate_revocableByAnyone() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.warp(expiry + 1);
        vm.prank(stranger);
        assertTrue(reg.revokeIfBreached(id), "a passer-by can retire an expired mandate");
        (,,,,, , bool revoked,) = reg.mandates(id);
        assertTrue(revoked);
    }

    function test_healthyMandate_isNotRevocableByBreachCheck() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(stranger);
        assertFalse(reg.revokeIfBreached(id), "no breach, no revocation");
        assertTrue(reg.isActive(id));
    }

    function test_revokeIfBreached_onAlreadyRevoked_isNoop() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        vm.prank(delegator);
        reg.revoke(id);
        vm.prank(stranger);
        assertFalse(reg.revokeIfBreached(id));
    }

    // ---- revocation does not strand funds ---------------------------------

    function test_revocationLeavesNothingBehind() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        pool.setConsumeBps(5_000);
        _place(id, 500_000);
        vm.prank(delegator);
        reg.revoke(id);
        assertTrue(reg.holdsNoFunds(), "revoking never strands collateral here");
        assertEq(usdc.balanceOf(address(reg)), 0);
    }

    /**
     * Revocation stops FUTURE orders; it does not retroactively unwind a trade
     * that already happened. Stating it as a test so nobody later assumes the
     * stronger property from the demo narrative.
     */
    function test_revocationDoesNotUnwindSettledExposure() public {
        uint256 id = _mandate(1_000_000, 10_000_000);
        uint128 orderId = _place(id, 500_000);
        reg.settleAndEnforce(address(pool), orderId, 500_000, 1_000_000); // fully filled
        (,,,, uint128 used,,,) = reg.mandates(id);
        assertEq(used, 500_000);
        vm.prank(delegator);
        reg.revoke(id);
        (,,,, uint128 after_,,,) = reg.mandates(id);
        assertEq(after_, 500_000, "a completed trade stays on the books");
    }
}
