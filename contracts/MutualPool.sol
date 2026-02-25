// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MutualPool
 * @notice Decentralized mutual insurance protocol for AI agents.
 *         Agents contribute USDC to pools covering binary-outcome events.
 *         The protocol operator collects a 3% fee on resolved pools.
 */
contract MutualPool is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // --- Constants & State ---

    address public constant PROTOCOL_OWNER = 0x2b4D825417f568231e809E31B9332ED146760337;
    uint256 public constant PROTOCOL_FEE_BPS = 300; // 3%
    uint256 public constant MIN_CONTRIBUTION = 10e6; // 10 USDC (6 decimals)
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;
    address public oracle; // only the oracle can resolve pools

    uint256 public nextPoolId;

    enum PoolStatus { Open, Active, Resolved, Claimed }

    struct PoolInfo {
        uint256 id;
        string description;
        string evidenceSource;
        uint256 coverageAmount;
        uint256 premiumRate; // in basis points, e.g. 500 = 5%
        uint256 deadline;
        address insured;
        uint256 premiumPaid;
        uint256 totalCollateral;
        PoolStatus status;
        bool claimApproved;
        address[] participants;
    }

    // Pool ID => PoolInfo (without mapping fields)
    mapping(uint256 => PoolInfo) public pools;
    // Pool ID => participant address => contribution amount
    mapping(uint256 => mapping(address => uint256)) public contributions;
    // Pool ID => participant address => whether they have withdrawn
    mapping(uint256 => mapping(address => bool)) public hasWithdrawn;
    // Pool ID => whether the insured has withdrawn
    mapping(uint256 => bool) public insuredWithdrawn;

    // --- Events ---

    event PoolCreated(
        uint256 indexed poolId,
        address indexed insured,
        string description,
        uint256 coverageAmount,
        uint256 premiumRate,
        uint256 deadline
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
        uint256 premiumPaid
    );

    event FeeCollected(uint256 indexed poolId, uint256 feeAmount);

    event Withdrawn(
        uint256 indexed poolId,
        address indexed participant,
        uint256 amount
    );

    // --- Modifiers ---

    modifier onlyOracle() {
        require(msg.sender == oracle, "MutualPool: caller is not the oracle");
        _;
    }

    modifier poolExists(uint256 poolId) {
        require(poolId < nextPoolId, "MutualPool: pool does not exist");
        _;
    }

    // --- Constructor ---

    /**
     * @param _usdc Address of the USDC token contract
     * @param _oracle Address of the oracle (agent wallet that resolves pools)
     */
    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0), "MutualPool: invalid USDC address");
        require(_oracle != address(0), "MutualPool: invalid oracle address");
        usdc = IERC20(_usdc);
        oracle = _oracle;
    }

    // --- External Functions ---

    /**
     * @notice Create a new insurance pool. The caller becomes the insured and pays the premium.
     * @param _description Human-readable description of the covered event
     * @param _evidenceSource Public URL to verify the outcome
     * @param _coverageAmount USDC amount that covers the claim (6 decimals)
     * @param _premiumRate Premium rate in basis points (e.g. 500 = 5% of coverageAmount)
     * @param _deadline Unix timestamp when the pool can be resolved
     */
    function createPool(
        string calldata _description,
        string calldata _evidenceSource,
        uint256 _coverageAmount,
        uint256 _premiumRate,
        uint256 _deadline
    ) external nonReentrant returns (uint256 poolId) {
        require(_coverageAmount >= MIN_CONTRIBUTION, "MutualPool: coverage too low");
        require(_premiumRate > 0 && _premiumRate < BPS_DENOMINATOR, "MutualPool: invalid premium rate");
        require(_deadline > block.timestamp, "MutualPool: deadline must be in the future");
        require(bytes(_description).length > 0, "MutualPool: empty description");
        require(bytes(_evidenceSource).length > 0, "MutualPool: empty evidence source");

        uint256 premium = (_coverageAmount * _premiumRate) / BPS_DENOMINATOR;
        require(premium > 0, "MutualPool: premium is zero");

        poolId = nextPoolId++;

        PoolInfo storage pool = pools[poolId];
        pool.id = poolId;
        pool.description = _description;
        pool.evidenceSource = _evidenceSource;
        pool.coverageAmount = _coverageAmount;
        pool.premiumRate = _premiumRate;
        pool.deadline = _deadline;
        pool.insured = msg.sender;
        pool.premiumPaid = premium;
        pool.status = PoolStatus.Open;

        // Transfer premium from insured to contract
        usdc.safeTransferFrom(msg.sender, address(this), premium);

        emit PoolCreated(poolId, msg.sender, _description, _coverageAmount, _premiumRate, _deadline);
    }

    /**
     * @notice Join a pool by contributing USDC as collateral.
     * @param _poolId The pool to join
     * @param _amount USDC amount to contribute (6 decimals)
     */
    function joinPool(uint256 _poolId, uint256 _amount)
        external
        nonReentrant
        poolExists(_poolId)
    {
        PoolInfo storage pool = pools[_poolId];
        require(pool.status == PoolStatus.Open, "MutualPool: pool is not open");
        require(block.timestamp < pool.deadline, "MutualPool: past deadline");
        require(_amount >= MIN_CONTRIBUTION, "MutualPool: below minimum contribution");
        require(msg.sender != pool.insured, "MutualPool: insured cannot join as participant");

        if (contributions[_poolId][msg.sender] == 0) {
            pool.participants.push(msg.sender);
        }
        contributions[_poolId][msg.sender] += _amount;
        pool.totalCollateral += _amount;

        usdc.safeTransferFrom(msg.sender, address(this), _amount);

        emit AgentJoined(_poolId, msg.sender, _amount);

        // Auto-activate when collateral reaches coverage amount
        if (pool.totalCollateral >= pool.coverageAmount && pool.status == PoolStatus.Open) {
            pool.status = PoolStatus.Active;
            emit PoolActivated(_poolId, pool.totalCollateral);
        }
    }

    /**
     * @notice Resolve a pool. Only callable by the oracle after the deadline.
     * @param _poolId The pool to resolve
     * @param _claimApproved true if the insured event occurred (claim paid), false otherwise
     */
    function resolvePool(uint256 _poolId, bool _claimApproved)
        external
        nonReentrant
        onlyOracle
        poolExists(_poolId)
    {
        PoolInfo storage pool = pools[_poolId];
        require(
            pool.status == PoolStatus.Active || pool.status == PoolStatus.Open,
            "MutualPool: pool not resolvable"
        );
        require(block.timestamp >= pool.deadline, "MutualPool: deadline not reached");

        pool.status = PoolStatus.Resolved;
        pool.claimApproved = _claimApproved;

        // Calculate and transfer protocol fee from the premium
        uint256 fee = (pool.premiumPaid * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        if (fee > 0) {
            usdc.safeTransfer(PROTOCOL_OWNER, fee);
            emit FeeCollected(_poolId, fee);
        }

        emit PoolResolved(_poolId, _claimApproved, pool.totalCollateral, pool.premiumPaid);
    }

    /**
     * @notice Withdraw funds after a pool has been resolved.
     *         - If no claim: participants get collateral back + share of (premium - fee)
     *         - If claim approved: insured gets coverageAmount, participants split remainder
     * @param _poolId The pool to withdraw from
     */
    function withdraw(uint256 _poolId)
        external
        nonReentrant
        poolExists(_poolId)
    {
        PoolInfo storage pool = pools[_poolId];
        require(pool.status == PoolStatus.Resolved, "MutualPool: pool not resolved");

        uint256 fee = (pool.premiumPaid * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 premiumAfterFee = pool.premiumPaid - fee;

        if (pool.claimApproved) {
            // Claim was approved: insured gets coverage, participants lose collateral
            if (msg.sender == pool.insured) {
                require(!insuredWithdrawn[_poolId], "MutualPool: already withdrawn");
                insuredWithdrawn[_poolId] = true;

                // Insured receives the coverage amount
                uint256 payout = pool.coverageAmount;
                // If total collateral is less than coverage (shouldn't happen if Active), cap it
                if (payout > pool.totalCollateral) {
                    payout = pool.totalCollateral;
                }
                usdc.safeTransfer(msg.sender, payout);
                emit Withdrawn(_poolId, msg.sender, payout);
            } else {
                // Participants: get back any excess collateral above coverage proportionally
                uint256 contribution = contributions[_poolId][msg.sender];
                require(contribution > 0, "MutualPool: no contribution");
                require(!hasWithdrawn[_poolId][msg.sender], "MutualPool: already withdrawn");
                hasWithdrawn[_poolId][msg.sender] = true;

                uint256 payout = 0;
                if (pool.totalCollateral > pool.coverageAmount) {
                    // There's excess collateral; distribute proportionally
                    uint256 excess = pool.totalCollateral - pool.coverageAmount;
                    payout = (excess * contribution) / pool.totalCollateral;
                }
                // Participants also get a proportional share of premium after fee
                payout += (premiumAfterFee * contribution) / pool.totalCollateral;

                if (payout > 0) {
                    usdc.safeTransfer(msg.sender, payout);
                }
                emit Withdrawn(_poolId, msg.sender, payout);
            }
        } else {
            // No claim: participants get collateral back + share of premium
            if (msg.sender == pool.insured) {
                // Insured gets nothing back (premium already paid)
                revert("MutualPool: insured has no withdrawal when no claim");
            }

            uint256 contribution = contributions[_poolId][msg.sender];
            require(contribution > 0, "MutualPool: no contribution");
            require(!hasWithdrawn[_poolId][msg.sender], "MutualPool: already withdrawn");
            hasWithdrawn[_poolId][msg.sender] = true;

            // Return collateral + proportional share of premium minus fee
            uint256 premiumShare = (premiumAfterFee * contribution) / pool.totalCollateral;
            uint256 payout = contribution + premiumShare;

            usdc.safeTransfer(msg.sender, payout);
            emit Withdrawn(_poolId, msg.sender, payout);
        }
    }

    // --- View Functions ---

    /**
     * @notice Get participants of a pool
     */
    function getPoolParticipants(uint256 _poolId)
        external
        view
        poolExists(_poolId)
        returns (address[] memory)
    {
        return pools[_poolId].participants;
    }

    /**
     * @notice Get full pool info
     */
    function getPool(uint256 _poolId)
        external
        view
        poolExists(_poolId)
        returns (
            string memory description,
            string memory evidenceSource,
            uint256 coverageAmount,
            uint256 premiumRate,
            uint256 deadline,
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
            pool.insured,
            pool.premiumPaid,
            pool.totalCollateral,
            pool.status,
            pool.claimApproved,
            pool.participants.length
        );
    }

    /**
     * @notice Get the contribution of a specific participant in a pool
     */
    function getContribution(uint256 _poolId, address _participant)
        external
        view
        poolExists(_poolId)
        returns (uint256)
    {
        return contributions[_poolId][_participant];
    }

    // --- Admin Functions ---

    /**
     * @notice Update the oracle address. Only callable by the contract owner.
     */
    function setOracle(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "MutualPool: invalid oracle address");
        oracle = _newOracle;
    }
}
