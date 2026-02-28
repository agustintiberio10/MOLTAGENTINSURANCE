// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MutualLumina
 * @author MutualBot Insurance Protocol
 * @notice Standalone decentralized mutual insurance vault on Base L2.
 *         No external Router — users interact directly with this contract.
 *
 * @dev Lifecycle:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ POOL LIFECYCLE                                               │
 *   │                                                              │
 *   │  createAndFund(msg.sender) ──► Open (premium deposited)      │
 *   │       │                                                      │
 *   │  joinPool(msg.sender) fills collateral                       │
 *   │    totalCollateral >= coverage ──► Active                     │
 *   │                                                              │
 *   │  depositDeadline & underfunded:                               │
 *   │    cancelAndRefund() ──► Cancelled (100% refund, no fee)      │
 *   │                                                              │
 *   │  deadline reached:                                            │
 *   │    resolvePool(oracle) ──► Resolved                           │
 *   │                                                              │
 *   │  deadline + 24h & oracle silent:                              │
 *   │    emergencyResolve(anyone) ──► Resolved (no claim)           │
 *   │                                                              │
 *   │  withdraw() ──► funds distributed per accounting rules        │
 *   └──────────────────────────────────────────────────────────────┘
 *
 *   Fee model (applied ONLY at resolution):
 *     fee = 3% of (premiumPaid + totalCollateral)
 *     netAmount = (premiumPaid + totalCollateral) - fee
 *
 *   Withdrawal accounting:
 *     NO CLAIM  → insured: 0, providers split netAmount pro-rata
 *     CLAIM     → insured: min(coverage, netAmount),
 *                 providers split remainder pro-rata
 */
contract MutualLumina is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════
    // CONSTANTS
    // ══════════════════════════════════════════════════════════════

    /// @notice Protocol treasury for fee collection.
    address public constant PROTOCOL_OWNER =
        0x2b4D825417f568231e809E31B9332ED146760337;

    /// @notice Protocol fee: 3 % (300 bps), on the full pot at resolution.
    uint256 public constant PROTOCOL_FEE_BPS = 300;

    /// @notice Minimum USDC contribution for collateral providers (10 USDC).
    uint256 public constant MIN_CONTRIBUTION = 10e6;

    /// @notice Basis-points denominator (10 000).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Deposit window closes 2 h before the resolution deadline.
    uint256 public constant DEPOSIT_WINDOW_BUFFER = 2 hours;

    /// @notice Emergency resolve unlocks 24 h after the deadline.
    uint256 public constant EMERGENCY_RESOLVE_DELAY = 24 hours;

    // ══════════════════════════════════════════════════════════════
    // STATE
    // ══════════════════════════════════════════════════════════════

    /// @notice USDC token used for all transfers (6 decimals on Base).
    IERC20 public immutable usdc;

    /// @notice Authorized oracle address for pool resolution.
    address public oracle;

    /// @notice Auto-incrementing pool counter.
    uint256 public nextPoolId;

    /// @notice Pool lifecycle states. Pending is removed — pools start Open.
    enum PoolStatus {
        Open,
        Active,
        Resolved,
        Cancelled
    }

    /// @notice Full on-chain state for a single insurance pool.
    struct PoolInfo {
        uint256 id;
        string description;
        string evidenceSource;
        uint256 coverageAmount;
        uint256 premiumRate;
        uint256 deadline;
        uint256 depositDeadline;
        address insured;
        uint256 premiumPaid;
        uint256 totalCollateral;
        PoolStatus status;
        bool claimApproved;
        uint256 netAmount;
        uint256 protocolFee;
        address[] participants;
    }

    /// @dev poolId → PoolInfo
    mapping(uint256 => PoolInfo) public pools;

    /// @dev poolId → provider → USDC amount deposited
    mapping(uint256 => mapping(address => uint256)) public contributions;

    /// @dev poolId → provider → already withdrawn flag
    mapping(uint256 => mapping(address => bool)) public hasWithdrawn;

    /// @dev poolId → insured already withdrawn flag
    mapping(uint256 => bool) public insuredWithdrawn;

    // ══════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════

    event PoolCreated(
        uint256 indexed poolId,
        string description,
        uint256 coverageAmount,
        uint256 premiumRate,
        uint256 deadline
    );
    event PremiumFunded(
        uint256 indexed poolId,
        address indexed insured,
        uint256 premiumAmount
    );
    event AgentJoined(
        uint256 indexed poolId,
        address indexed participant,
        uint256 amount
    );
    event PoolActivated(uint256 indexed poolId, uint256 totalCollateral);
    event PoolResolved(
        uint256 indexed poolId,
        bool claimApproved,
        uint256 totalCollateral,
        uint256 netAmount,
        uint256 protocolFee
    );
    event PoolCancelled(
        uint256 indexed poolId,
        uint256 totalCollateral,
        uint256 premiumRefunded
    );
    event EmergencyResolved(
        uint256 indexed poolId,
        address indexed triggeredBy
    );
    event FeeCollected(uint256 indexed poolId, uint256 feeAmount);
    event Withdrawn(
        uint256 indexed poolId,
        address indexed participant,
        uint256 amount
    );
    event OracleUpdated(address indexed newOracle);

    // ══════════════════════════════════════════════════════════════
    // MODIFIERS
    // ══════════════════════════════════════════════════════════════

    /// @dev Restricts a function to the current oracle address.
    modifier onlyOracle() {
        require(msg.sender == oracle, "Lumina: not oracle");
        _;
    }

    /// @dev Ensures the pool has been created.
    modifier poolExists(uint256 poolId) {
        require(poolId < nextPoolId, "Lumina: pool does not exist");
        _;
    }

    // ══════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════

    /// @notice Deploy MutualLumina with the USDC token and initial oracle.
    /// @param _usdc  Address of the USDC token (6 decimals).
    /// @param _oracle  Initial oracle address.
    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0), "Lumina: invalid USDC address");
        require(_oracle != address(0), "Lumina: invalid oracle address");
        usdc = IERC20(_usdc);
        oracle = _oracle;
    }

    // ══════════════════════════════════════════════════════════════
    // POOL CREATION + PREMIUM FUNDING  (single transaction)
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Create a new insurance pool and fund its premium in one call.
     *
     * @dev msg.sender becomes the contratante (insured).
     *      premium = coverageAmount × premiumRate / 10 000.
     *      The pool starts directly in Open status — there is no Pending step.
     *      The caller must have approved this contract for ≥ premium USDC.
     *
     * @param _description     Human-readable pool description.
     * @param _evidenceSource  URI / identifier for evidence evaluation.
     * @param _coverageAmount  Maximum payout in USDC (6 decimals).
     * @param _premiumRate     Premium rate in basis points (e.g. 500 = 5 %).
     * @param _deadline        Unix timestamp after which the oracle may resolve.
     * @return poolId          The ID of the newly created pool.
     */
    function createAndFund(
        string calldata _description,
        string calldata _evidenceSource,
        uint256 _coverageAmount,
        uint256 _premiumRate,
        uint256 _deadline
    ) external nonReentrant returns (uint256 poolId) {
        require(
            _coverageAmount >= MIN_CONTRIBUTION,
            "Lumina: coverage below minimum"
        );
        require(
            _premiumRate > 0 && _premiumRate < BPS_DENOMINATOR,
            "Lumina: invalid premium rate"
        );
        require(
            _deadline > block.timestamp + DEPOSIT_WINDOW_BUFFER,
            "Lumina: deadline too soon"
        );
        require(bytes(_description).length > 0, "Lumina: empty description");
        require(
            bytes(_evidenceSource).length > 0,
            "Lumina: empty evidence source"
        );

        uint256 premium = (_coverageAmount * _premiumRate) / BPS_DENOMINATOR;
        require(premium > 0, "Lumina: premium is zero");

        poolId = nextPoolId++;

        PoolInfo storage pool = pools[poolId];
        pool.id = poolId;
        pool.description = _description;
        pool.evidenceSource = _evidenceSource;
        pool.coverageAmount = _coverageAmount;
        pool.premiumRate = _premiumRate;
        pool.deadline = _deadline;
        pool.depositDeadline = _deadline - DEPOSIT_WINDOW_BUFFER;
        pool.insured = msg.sender;
        pool.premiumPaid = premium;
        pool.status = PoolStatus.Open;

        usdc.safeTransferFrom(msg.sender, address(this), premium);

        emit PoolCreated(
            poolId,
            _description,
            _coverageAmount,
            _premiumRate,
            _deadline
        );
        emit PremiumFunded(poolId, msg.sender, premium);
    }

    // ══════════════════════════════════════════════════════════════
    // JOIN POOL  (direct call — no router)
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Join a pool as a collateral provider.
     *
     * @dev msg.sender deposits USDC directly. No router intermediary.
     *      When totalCollateral reaches coverageAmount the pool becomes Active.
     *      The caller must have approved this contract for ≥ _amount USDC.
     *
     * @param _poolId  Pool to join.
     * @param _amount  USDC collateral (6 decimals). Must be ≥ MIN_CONTRIBUTION.
     */
    function joinPool(
        uint256 _poolId,
        uint256 _amount
    ) external nonReentrant poolExists(_poolId) {
        PoolInfo storage pool = pools[_poolId];
        require(pool.status == PoolStatus.Open, "Lumina: pool not open");
        require(
            block.timestamp < pool.depositDeadline,
            "Lumina: deposit window closed"
        );
        require(_amount >= MIN_CONTRIBUTION, "Lumina: below minimum");
        require(msg.sender != pool.insured, "Lumina: insured cannot join");

        if (contributions[_poolId][msg.sender] == 0) {
            pool.participants.push(msg.sender);
        }
        contributions[_poolId][msg.sender] += _amount;
        pool.totalCollateral += _amount;

        usdc.safeTransferFrom(msg.sender, address(this), _amount);

        emit AgentJoined(_poolId, msg.sender, _amount);

        if (
            pool.totalCollateral >= pool.coverageAmount &&
            pool.status == PoolStatus.Open
        ) {
            pool.status = PoolStatus.Active;
            emit PoolActivated(_poolId, pool.totalCollateral);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // CANCELLATION
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Cancel an underfunded pool after the deposit deadline.
     *
     * @dev Anyone may call. No fee is charged on cancellation.
     *      - 100 % of premiumPaid is refunded to the insured.
     *      - Providers recover 100 % of their collateral via withdraw().
     *
     * @param _poolId  Pool to cancel.
     */
    function cancelAndRefund(
        uint256 _poolId
    ) external nonReentrant poolExists(_poolId) {
        PoolInfo storage pool = pools[_poolId];
        require(pool.status == PoolStatus.Open, "Lumina: not cancellable");
        require(
            block.timestamp >= pool.depositDeadline,
            "Lumina: deposit window still open"
        );
        require(
            pool.totalCollateral < pool.coverageAmount,
            "Lumina: pool is fully funded"
        );

        pool.status = PoolStatus.Cancelled;

        // 100 % premium refund — zero fee on cancellation
        if (pool.premiumPaid > 0) {
            usdc.safeTransfer(pool.insured, pool.premiumPaid);
        }

        emit PoolCancelled(_poolId, pool.totalCollateral, pool.premiumPaid);
    }

    // ══════════════════════════════════════════════════════════════
    // ORACLE RESOLUTION
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Resolve a pool after the deadline. Oracle-only.
     *
     * @dev fee = 3 % of (premiumPaid + totalCollateral).
     *      netAmount = (premiumPaid + totalCollateral) - fee.
     *      Fee is transferred to PROTOCOL_OWNER immediately.
     *
     * @param _poolId         Pool to resolve.
     * @param _claimApproved  True → insured's claim is approved.
     */
    function resolvePool(
        uint256 _poolId,
        bool _claimApproved
    ) external nonReentrant onlyOracle poolExists(_poolId) {
        PoolInfo storage pool = pools[_poolId];
        require(
            pool.status == PoolStatus.Active ||
                pool.status == PoolStatus.Open,
            "Lumina: not resolvable"
        );
        require(
            block.timestamp >= pool.deadline,
            "Lumina: deadline not reached"
        );

        pool.status = PoolStatus.Resolved;
        pool.claimApproved = _claimApproved;

        uint256 totalPot = pool.premiumPaid + pool.totalCollateral;
        uint256 fee = (totalPot * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;

        pool.protocolFee = fee;
        pool.netAmount = totalPot - fee;

        if (fee > 0) {
            usdc.safeTransfer(PROTOCOL_OWNER, fee);
            emit FeeCollected(_poolId, fee);
        }

        emit PoolResolved(
            _poolId,
            _claimApproved,
            pool.totalCollateral,
            pool.netAmount,
            fee
        );
    }

    // ══════════════════════════════════════════════════════════════
    // EMERGENCY RESOLUTION
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Emergency resolve when the oracle is silent 24 h after deadline.
     *
     * @dev Anyone may call. Always resolves with claimApproved = false.
     *      Same fee logic as resolvePool().
     *
     * @param _poolId  Pool to emergency-resolve.
     */
    function emergencyResolve(
        uint256 _poolId
    ) external nonReentrant poolExists(_poolId) {
        PoolInfo storage pool = pools[_poolId];
        require(
            pool.status == PoolStatus.Active ||
                pool.status == PoolStatus.Open,
            "Lumina: not resolvable"
        );
        require(
            block.timestamp >= pool.deadline + EMERGENCY_RESOLVE_DELAY,
            "Lumina: emergency not yet available"
        );

        pool.status = PoolStatus.Resolved;
        pool.claimApproved = false;

        uint256 totalPot = pool.premiumPaid + pool.totalCollateral;
        uint256 fee = (totalPot * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;

        pool.protocolFee = fee;
        pool.netAmount = totalPot - fee;

        if (fee > 0) {
            usdc.safeTransfer(PROTOCOL_OWNER, fee);
            emit FeeCollected(_poolId, fee);
        }

        emit EmergencyResolved(_poolId, msg.sender);
        emit PoolResolved(
            _poolId,
            false,
            pool.totalCollateral,
            pool.netAmount,
            fee
        );
    }

    // ══════════════════════════════════════════════════════════════
    // WITHDRAWAL
    // ══════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw funds after resolution or cancellation.
     *
     * @dev Open to all participants. Payout rules:
     *
     *      ── Cancelled ──
     *        Provider → 100 % of their collateral (premium already refunded).
     *
     *      ── Resolved · NO CLAIM ──
     *        Insured  → 0.
     *        Provider → netAmount × contribution / totalCollateral.
     *
     *      ── Resolved · CLAIM APPROVED ──
     *        Insured  → min(coverageAmount, netAmount).
     *        Provider → (netAmount − insuredPayout) × contribution / totalCollateral.
     *
     * @param _poolId  Pool to withdraw from.
     */
    function withdraw(
        uint256 _poolId
    ) external nonReentrant poolExists(_poolId) {
        PoolInfo storage pool = pools[_poolId];
        require(
            pool.status == PoolStatus.Resolved ||
                pool.status == PoolStatus.Cancelled,
            "Lumina: not resolved or cancelled"
        );

        // ── CANCELLED ──────────────────────────────────────────────
        if (pool.status == PoolStatus.Cancelled) {
            require(
                msg.sender != pool.insured,
                "Lumina: insured already refunded via cancelAndRefund"
            );
            uint256 contribution = contributions[_poolId][msg.sender];
            require(contribution > 0, "Lumina: no contribution");
            require(
                !hasWithdrawn[_poolId][msg.sender],
                "Lumina: already withdrawn"
            );

            hasWithdrawn[_poolId][msg.sender] = true;
            usdc.safeTransfer(msg.sender, contribution);
            emit Withdrawn(_poolId, msg.sender, contribution);
            return;
        }

        // ── RESOLVED ───────────────────────────────────────────────
        if (pool.claimApproved) {
            // ── CLAIM APPROVED ─────────────────────────────────────
            if (msg.sender == pool.insured) {
                require(
                    !insuredWithdrawn[_poolId],
                    "Lumina: already withdrawn"
                );
                insuredWithdrawn[_poolId] = true;

                uint256 payout = pool.coverageAmount;
                if (payout > pool.netAmount) {
                    payout = pool.netAmount;
                }

                usdc.safeTransfer(msg.sender, payout);
                emit Withdrawn(_poolId, msg.sender, payout);
            } else {
                uint256 contribution = contributions[_poolId][msg.sender];
                require(contribution > 0, "Lumina: no contribution");
                require(
                    !hasWithdrawn[_poolId][msg.sender],
                    "Lumina: already withdrawn"
                );
                hasWithdrawn[_poolId][msg.sender] = true;

                // Deterministic insured payout (same regardless of withdrawal order)
                uint256 insuredPayout = pool.coverageAmount;
                if (insuredPayout > pool.netAmount) {
                    insuredPayout = pool.netAmount;
                }

                uint256 providerPool = pool.netAmount - insuredPayout;
                uint256 payout = (providerPool * contribution) /
                    pool.totalCollateral;

                if (payout > 0) {
                    usdc.safeTransfer(msg.sender, payout);
                }
                emit Withdrawn(_poolId, msg.sender, payout);
            }
        } else {
            // ── NO CLAIM ───────────────────────────────────────────
            require(
                msg.sender != pool.insured,
                "Lumina: no withdrawal when no claim"
            );
            uint256 contribution = contributions[_poolId][msg.sender];
            require(contribution > 0, "Lumina: no contribution");
            require(
                !hasWithdrawn[_poolId][msg.sender],
                "Lumina: already withdrawn"
            );
            hasWithdrawn[_poolId][msg.sender] = true;

            uint256 payout = (pool.netAmount * contribution) /
                pool.totalCollateral;

            usdc.safeTransfer(msg.sender, payout);
            emit Withdrawn(_poolId, msg.sender, payout);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════

    /// @notice Get the list of collateral providers for a pool.
    /// @param _poolId Pool ID.
    /// @return Array of provider addresses.
    function getPoolParticipants(
        uint256 _poolId
    ) external view poolExists(_poolId) returns (address[] memory) {
        return pools[_poolId].participants;
    }

    /// @notice Get full pool details.
    /// @param _poolId Pool ID.
    function getPool(
        uint256 _poolId
    )
        external
        view
        poolExists(_poolId)
        returns (
            string memory description,
            string memory evidenceSource,
            uint256 coverageAmount,
            uint256 premiumRate,
            uint256 deadline,
            uint256 depositDeadline,
            address insured,
            uint256 premiumPaid,
            uint256 totalCollateral,
            PoolStatus status,
            bool claimApproved,
            uint256 participantCount
        )
    {
        PoolInfo storage pool = pools[_poolId];
        return (
            pool.description,
            pool.evidenceSource,
            pool.coverageAmount,
            pool.premiumRate,
            pool.deadline,
            pool.depositDeadline,
            pool.insured,
            pool.premiumPaid,
            pool.totalCollateral,
            pool.status,
            pool.claimApproved,
            pool.participants.length
        );
    }

    /// @notice Get a specific provider's USDC contribution.
    /// @param _poolId Pool ID.
    /// @param _participant Provider address.
    /// @return USDC amount deposited (6 decimals).
    function getContribution(
        uint256 _poolId,
        address _participant
    ) external view poolExists(_poolId) returns (uint256) {
        return contributions[_poolId][_participant];
    }

    /// @notice Get pool accounting after resolution.
    /// @param _poolId Pool ID.
    /// @return netAmount   (premiumPaid + totalCollateral) − fee.
    /// @return protocolFee  Fee sent to PROTOCOL_OWNER.
    /// @return totalCollateral  Total USDC collateral deposited.
    function getPoolAccounting(
        uint256 _poolId
    )
        external
        view
        poolExists(_poolId)
        returns (
            uint256 netAmount,
            uint256 protocolFee,
            uint256 totalCollateral
        )
    {
        PoolInfo storage pool = pools[_poolId];
        return (pool.netAmount, pool.protocolFee, pool.totalCollateral);
    }

    /// @notice Pure calculator: premium for a given coverage and rate.
    /// @param _coverageAmount Coverage in USDC (6 decimals).
    /// @param _premiumRate    Rate in basis points.
    /// @return Premium amount in USDC (6 decimals).
    function calculatePremium(
        uint256 _coverageAmount,
        uint256 _premiumRate
    ) external pure returns (uint256) {
        return (_coverageAmount * _premiumRate) / BPS_DENOMINATOR;
    }

    // ══════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════

    /// @notice Update the oracle address. Owner-only.
    /// @param _newOracle New oracle address (must not be zero).
    function setOracle(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "Lumina: invalid oracle address");
        oracle = _newOracle;
        emit OracleUpdated(_newOracle);
    }
}
