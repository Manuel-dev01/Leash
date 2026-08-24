// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

/**
 * PROBE C — does the Deadhand job actually FIT?
 *
 * A trivial handler that merely receives an invocation proves delivery and
 * nothing else. The real risk is that the actual work — decode the market,
 * iterate a bounded batch of mandates, several SSTOREs each, revoke breachers,
 * sweep payouts — does not fit the gas budget we intend to cap at. So this
 * handler does REPRESENTATIVE work and reports a number.
 *
 * Three questions, one deployment:
 *
 *   1. GAS. How much does a batch of N mandates cost? Set `batchSize` and read
 *      `gasUsed` off the Invoked event. That number sets the batch cap, the STT
 *      burn rate, and tells us whether a ~400k cap was engineering or wishing.
 *      `batchSize = 0` measures the early-exit path — the cost of being invoked
 *      for a finalization we do not care about, which is most of them.
 *
 *   2. REVERT. What does the precompile do when a handler reverts inside a
 *      validator invocation — retry, drop, or kill the subscription? Our batch
 *      iterates user-supplied state, so a revert is not hypothetical. If a
 *      revert is fatal, ONE malformed mandate takes down the whole Deadhand
 *      layer, silently, mid-demo. Arm `revertArmed` and watch whether the next
 *      finalization still arrives.
 *
 *   3. PAYLOAD. What is actually delivered? The real handler must decode it,
 *      and we are not going to discover the field packing on the 28th.
 *
 * Deliberately NOT MandateRegistry. No mandate semantics, no access control
 * beyond the owner knobs, and it is throwaway.
 */
contract ProbeHandler is SomniaEventHandler {
    address public immutable owner;

    // ---- knobs -------------------------------------------------------------
    /// Mandates to touch per invocation. 0 measures the early-exit path.
    uint256 public batchSize;
    /// When true the handler reverts inside the callback, on purpose.
    bool public revertArmed;

    // ---- observations ------------------------------------------------------
    uint256 public invocations;
    uint256 public subscriptionId;

    /// First payload seen, captured verbatim so we can inspect the real shape.
    bytes32[] public firstTopics;
    bytes public firstData;
    address public firstEmitter;
    bool public payloadCaptured;

    /**
     * Stand-in for the mandate slot the real registry will write. Field choice
     * mirrors what enforcement actually touches so the gas number transfers:
     * one SLOAD of a packed slot, then an SSTORE of the same slot.
     */
    struct Mandate {
        uint128 usedExposure;
        uint64 lastSettled;
        bool revoked;
    }

    mapping(uint256 => Mandate) public mandates;

    event Invoked(
        uint256 indexed seq,
        address emitter,
        bytes32 topic1,
        uint256 batch,
        uint256 gasUsed,
        uint256 gasLeftAtEntry
    );
    event LeashRevoked(uint256 indexed mandateId, uint256 usedExposure);
    event DeliberateRevert(uint256 indexed seq);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() payable {
        owner = msg.sender;
    }

    receive() external payable {}

    // ---- setup -------------------------------------------------------------

    /**
     * Pre-seed mandate slots so the batch writes non-zero -> non-zero, which is
     * the steady state. Seeding from zero would measure 20k-gas cold writes and
     * overstate the real cost by roughly 4x.
     */
    function seed(uint256 n) external onlyOwner {
        for (uint256 i = 0; i < n; ++i) {
            mandates[i] = Mandate({usedExposure: uint128(1e6 + i), lastSettled: uint64(block.timestamp), revoked: false});
        }
    }

    function setBatchSize(uint256 n) external onlyOwner { batchSize = n; }
    function setRevertArmed(bool v) external onlyOwner { revertArmed = v; }

    /**
     * Subscribe to MarketFinalized on the binaryModule singleton.
     *
     * `eventTopics` maps to topic0..topic3, so indexed arguments ARE filterable
     * at the precompile (the library's own scheduleSubscriptionAtTimestamp
     * filters on topic1 this way). Passing bytes32(0) leaves a slot wildcard.
     * We wildcard topics 1-3 here because a mandate set changes constantly and
     * one subscription must serve every delegation — but the capability is real
     * and worth knowing.
     */
    function subscribeTo(
        address emitter,
        bytes32 topic0,
        uint64 gasLimit,
        uint64 maxFeePerGas
    ) external onlyOwner returns (uint256) {
        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [topic0, bytes32(0), bytes32(0), bytes32(0)],
            origin: address(0),
            emitter: emitter
        });
        SomniaExtensions.SubscriptionOptions memory options = SomniaExtensions.SubscriptionOptions({
            priorityFeePerGas: 0,
            maxFeePerGas: maxFeePerGas,
            gasLimit: gasLimit
        });
        subscriptionId = SomniaExtensions.subscribe(address(this), filter, options);
        return subscriptionId;
    }

    function unsubscribeNow() external onlyOwner {
        SomniaExtensions.unsubscribe(subscriptionId);
        subscriptionId = 0;
    }

    /**
     * The 32 STT is a BALANCE FLOOR, not a deposit — it sits in this contract.
     * Without this function it would be stranded here permanently, which on a
     * 53 STT budget is unrecoverable. Not optional.
     */
    function withdraw() external onlyOwner {
        (bool ok, ) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    // ---- the callback ------------------------------------------------------

    function _onEvent(
        address emitter,
        bytes32[] calldata eventTopics,
        bytes calldata data
    ) internal override {
        uint256 g0 = gasleft();
        uint256 seq = ++invocations;

        if (!payloadCaptured) {
            firstEmitter = emitter;
            firstData = data;
            for (uint256 i = 0; i < eventTopics.length; ++i) firstTopics.push(eventTopics[i]);
            payloadCaptured = true;
        }

        if (revertArmed) {
            emit DeliberateRevert(seq);
            revert("probe: deliberate revert");
        }

        uint256 n = batchSize;
        for (uint256 i = 0; i < n; ++i) {
            Mandate memory m = mandates[i];
            m.usedExposure += 1;
            m.lastSettled = uint64(block.timestamp);
            // Revoke a deterministic slice, so the breach path is exercised too.
            if (i % 8 == 7) {
                m.revoked = true;
                emit LeashRevoked(i, m.usedExposure);
            }
            mandates[i] = m;
        }

        emit Invoked(
            seq,
            emitter,
            eventTopics.length > 1 ? eventTopics[1] : bytes32(0),
            n,
            g0 - gasleft(),
            g0
        );
    }

    function firstTopicsLength() external view returns (uint256) { return firstTopics.length; }
}
