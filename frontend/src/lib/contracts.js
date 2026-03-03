/**
 * Contract addresses, ABIs, and ethers.js helpers for the MutualPool dApp.
 *
 * Chain: Base Mainnet (8453)
 */

export const CHAIN_ID = 8453;
export const CHAIN_NAME = "Base";
export const RPC_URL = "https://mainnet.base.org";

// ═══════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES
// ═══════════════════════════════════════════════════════════════

export const CONTRACTS = {
  MUTUAL_LUMINA: "0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

// ═══════════════════════════════════════════════════════════════
// ABIs (minimal — only what the frontend needs)
// ═══════════════════════════════════════════════════════════════

/** @deprecated Use LUMINA_ABI for new pools */
export const VAULT_ABI = [
  // Read
  "function getPool(uint256 _poolId) view returns (string description, string evidenceSource, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline, address insured, uint256 premiumPaid, uint256 totalCollateral, uint8 status, bool claimApproved, uint256 participantCount)",
  "function getRequiredPremium(uint256 _poolId) view returns (uint256)",
  "function getPoolParticipants(uint256 _poolId) view returns (address[])",
  "function getContribution(uint256 _poolId, address _participant) view returns (uint256)",
  "function getPoolAccounting(uint256 _poolId) view returns (uint256 premiumAfterFee, uint256 protocolFee, uint256 totalCollateral)",
  "function nextPoolId() view returns (uint256)",
  // Write (no Router needed)
  "function withdraw(uint256 _poolId)",
  "function cancelAndRefund(uint256 _poolId)",
  "function emergencyResolve(uint256 _poolId)",
  // Events
  "event PoolCreated(uint256 indexed poolId, string description, uint256 coverageAmount, uint256 premiumRate, uint256 deadline)",
  "event PremiumFunded(uint256 indexed poolId, address indexed insured, uint256 premiumAmount)",
  "event AgentJoined(uint256 indexed poolId, address indexed participant, uint256 amount)",
  "event PoolActivated(uint256 indexed poolId, uint256 totalCollateral)",
  "event PoolResolved(uint256 indexed poolId, bool claimApproved, uint256 totalCollateral, uint256 premiumAfterFee, uint256 protocolFee)",
];

export const LUMINA_ABI = [
  // Read
  "function getPool(uint256 _poolId) view returns (string description, string evidenceSource, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline, address insured, uint256 premiumPaid, uint256 totalCollateral, uint8 status, bool claimApproved, uint256 participantCount)",
  "function getPoolParticipants(uint256 _poolId) view returns (address[])",
  "function getContribution(uint256 _poolId, address _participant) view returns (uint256)",
  "function getPoolAccounting(uint256 _poolId) view returns (uint256 netAmount, uint256 protocolFee, uint256 totalCollateral)",
  "function calculatePremium(uint256 _coverageAmount, uint256 _premiumRate) pure returns (uint256)",
  "function nextPoolId() view returns (uint256)",
  // Write (direct — no Router needed)
  "function joinPool(uint256 _poolId, uint256 _amount)",
  "function withdraw(uint256 _poolId)",
  "function cancelAndRefund(uint256 _poolId)",
  "function emergencyResolve(uint256 _poolId)",
  // Events
  "event PoolCreated(uint256 indexed poolId, string description, uint256 coverageAmount, uint256 premiumRate, uint256 deadline)",
  "event PremiumFunded(uint256 indexed poolId, address indexed insured, uint256 premiumAmount)",
  "event AgentJoined(uint256 indexed poolId, address indexed participant, uint256 amount)",
  "event PoolActivated(uint256 indexed poolId, uint256 totalCollateral)",
  "event PoolResolved(uint256 indexed poolId, bool claimApproved, uint256 totalCollateral, uint256 netAmount, uint256 protocolFee)",
  "event PoolCancelled(uint256 indexed poolId, uint256 totalCollateral, uint256 premiumRefunded)",
  "event Withdrawn(uint256 indexed poolId, address indexed participant, uint256 amount)",
];


export const AUTORESOLVER_ABI = [
  // Read
  "function getPolicy(uint256 poolId) view returns (tuple(uint8 triggerType, address chainlinkFeed, address secondaryFeed, int256 threshold, uint256 sustainedPeriod, int256 startPrice, uint256 activatedAt, uint256 waitingPeriod, uint256 deadline, bool resolved, uint256 conditionMetAt))",
  "function getRegisteredPoolCount() view returns (uint256)",
  "function getRegisteredPoolIds() view returns (uint256[])",
  "function disputeResolver() view returns (address)",
  "function maxStaleness() view returns (uint256)",
  // Write (permissionless — anyone can trigger resolution)
  "function checkAndResolve(uint256 poolId)",
  "function batchCheck(uint256[] poolIds)",
  // Events
  "event PolicyRegistered(uint256 indexed poolId, uint8 triggerType, int256 threshold, int256 startPrice)",
  "event ConditionDetected(uint256 indexed poolId, int256 currentPrice, uint256 sustainedUntil)",
  "event ResolutionProposed(uint256 indexed poolId, bool triggered, string reason)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ═══════════════════════════════════════════════════════════════
// STATUS MAPPING
// ═══════════════════════════════════════════════════════════════

/** @deprecated V3 status mapping (has Pending state) */
export const POOL_STATUS = {
  0: "Pending",
  1: "Open",
  2: "Active",
  3: "Resolved",
  4: "Cancelled",
};

/** Status mapping for MutualLumina pools (no Pending state) */
export const LUMINA_POOL_STATUS = {
  0: "Open",
  1: "Active",
  2: "Resolved",
  3: "Cancelled",
};

/** @deprecated V3 status colors */
export const POOL_STATUS_COLORS = {
  0: "#f59e0b", // amber - Pending
  1: "#3b82f6", // blue - Open
  2: "#10b981", // green - Active
  3: "#6366f1", // indigo - Resolved
  4: "#ef4444", // red - Cancelled
};

export const LUMINA_POOL_STATUS_COLORS = {
  0: "#3b82f6", // blue - Open
  1: "#10b981", // green - Active
  2: "#6366f1", // indigo - Resolved
  3: "#ef4444", // red - Cancelled
};

// ═══════════════════════════════════════════════════════════════
// AUTORESOLVER TRIGGER TYPES
// ═══════════════════════════════════════════════════════════════

export const TRIGGER_TYPE = {
  0: "PRICE_BELOW",
  1: "PRICE_ABOVE",
  2: "PRICE_DROP_PCT",
  3: "PRICE_RISE_PCT",
  4: "PRICE_DIVERGENCE",
  5: "GAS_ABOVE",
};

export const TRIGGER_TYPE_DESCRIPTIONS = {
  0: "Price falls below threshold",
  1: "Price rises above threshold",
  2: "Price drops by percentage (bps) from start",
  3: "Price rises by percentage (bps) from start",
  4: "Two price feeds diverge by percentage (bps)",
  5: "L2 gas price exceeds threshold (wei)",
};

/** Chainlink Price Feed addresses on Base Mainnet */
export const CHAINLINK_FEEDS = {
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "BTC/USD": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  "USDC/USD": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  "DAI/USD": "0x591e79239a7d679378eC8c847e5038150364C78F",
  "USDT/USD": "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Determine if a pool belongs to MutualLumina or legacy V3.
 * @param {string} contractAddress - The contract the pool was created on.
 */
export function isLuminaPool(contractAddress) {
  return (
    contractAddress?.toLowerCase() === CONTRACTS.MUTUAL_LUMINA.toLowerCase()
  );
}
