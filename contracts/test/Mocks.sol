// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// 6-decimal collateral, matching testnet tUSDC rather than an 18dp default.
contract MockUSDC {
    string public name = "Test USDC";
    string public symbol = "TUSDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Set to make transfers TO this address fail, for the griefing test.
    mapping(address => bool) public blocked;
    /// Harsher than `blocked`: transfers to this address REVERT rather than return false.
    mapping(address => bool) public reverting;

    function setBlocked(address who, bool v) external { blocked[who] = v; }
    function setReverting(address who, bool v) external { reverting[who] = v; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    /// Recipients registered here get a callback on transfer, ERC777-style, so
    /// the reentrancy guard can be exercised for real rather than assumed.
    mapping(address => bool) public hooked;
    function setHooked(address who, bool v) external { hooked[who] = v; }

    function transfer(address to, uint256 a) external returns (bool) {
        require(!reverting[to], "recipient reverts");
        if (blocked[to]) return false; // returns false rather than reverting
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        if (hooked[to]) ITokenReceiver(to).onTokenReceived(a);
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/**
 * Stands in for a BinaryPool. Takes `consumeBps` of the offered cost, so a
 * partial fill (taker charged the fill price, not its offer) is reproducible.
 */
contract MockBinaryPool {
    MockUSDC public immutable token;
    uint128 public nextId = 1000;
    uint256 public consumeBps = 10_000; // 100% by default
    bool public succeed = true;
    /// When set, placeBinaryOrder returns (false, 0) — the silent rejection.
    function setSucceed(bool v) external { succeed = v; }
    function setConsumeBps(uint256 v) external { consumeBps = v; }

    constructor(MockUSDC t) { token = t; }

    function placeBinaryOrder(
        uint8, uint256 price, uint256 quantity, uint64, uint8, uint8, address, uint96, uint64
    ) external payable returns (bool, uint128) {
        if (!succeed) return (false, 0);
        uint256 cost = (price * quantity) / 1e6;
        uint256 take = (cost * consumeBps) / 10_000;
        if (take > 0) token.transferFrom(msg.sender, address(this), take);
        return (true, nextId++);
    }

    function cancelOrder(uint128) external {}
}

interface ITokenReceiver {
    function onTokenReceived(uint256 amount) external;
}

/**
 * A delegator that reenters the registry at the exact moment it is paid — i.e.
 * during the sweep, when exposure accounting has just been written and the
 * contract is mid-order-path. This is the real shape of the attack, so the
 * guard is tested rather than described.
 */
contract ReentrantDelegator is ITokenReceiver {
    address public registry;
    bytes public payload;
    bool public armed;
    bool public reentryAttempted;
    bool public reentryReverted;

    function arm(address r, bytes calldata p) external { registry = r; payload = p; armed = true; }

    function onTokenReceived(uint256) external override {
        if (!armed) return;
        armed = false; // one shot
        reentryAttempted = true;
        (bool ok, ) = registry.call(payload);
        reentryReverted = !ok;
    }
}
