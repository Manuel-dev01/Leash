// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * PROBE B2 — does Leash need custody at all?
 *
 * Probe A proved `placeBinaryOrderFor` is gated by `OnlyApprovedContracts()`,
 * so MandateRegistry cannot route orders on a delegator's behalf. The fallback
 * is for the registry to trade AS ITSELF — which naively implies the delegator
 * must deposit collateral into the registry, i.e. custody.
 *
 * This contract tests the alternative: the registry never holds a resting
 * balance, and instead pulls collateral just-in-time inside the same
 * transaction that places the order.
 *
 *     delegator approves this contract for X          (funds stay in their wallet)
 *     delegate  calls placeFor(...)
 *       |- transferFrom(delegator -> this)            just-in-time
 *       |- approve(pool, cost)
 *       |- pool.placeBinaryOrder(...)                 placed as THIS contract
 *
 * If that fills, balance at rest is zero, the delegator never gives up custody
 * of the principal, and the ERC-20 allowance becomes a second revocation lever
 * they already understand without reading our contract.
 *
 * This is a PROBE. It is deliberately permissionless and has no mandate checks
 * — it exists to answer one mechanical question and must never be presented as,
 * or evolve into, MandateRegistry.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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
}

contract ProbeRouter {
    event Placed(bool success, uint128 id, uint256 pulled, uint256 restingBalance);

    struct Order {
        uint8 kind;
        uint256 price;
        uint256 quantity;
        uint64 expireTimestampNs;
        uint8 orderType;
        uint8 selfMatchingOption;
    }

    /**
     * Pull `cost` from `delegator`, place the order as this contract, and report
     * the balance left at rest. A zero resting balance is the whole point.
     */
    function placeFor(
        address delegator,
        address collateral,
        address pool,
        uint256 cost,
        Order calldata o
    ) external returns (bool success, uint128 id) {
        require(IERC20(collateral).transferFrom(delegator, address(this), cost), "pull failed");
        require(IERC20(collateral).approve(pool, cost), "approve failed");

        (success, id) = IBinaryPool(pool).placeBinaryOrder(
            o.kind,
            o.price,
            o.quantity,
            o.expireTimestampNs,
            o.orderType,
            o.selfMatchingOption,
            address(0), // builder — untagged, per §4.1 r8
            0,
            0
        );

        emit Placed(success, id, cost, IERC20(collateral).balanceOf(address(this)));
    }

    /** Read-only helper so the probe script can assert "nothing rests here". */
    function restingBalance(address collateral) external view returns (uint256) {
        return IERC20(collateral).balanceOf(address(this));
    }
}
