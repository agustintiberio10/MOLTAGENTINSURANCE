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
  // Legacy V3 + Router
  MUTUAL_POOL_V3: "0x3ee94c92eD66CfB6309A352136689626CDed3c40",
  ROUTER: "0xdb9ca7ADb3739f3df1ED1B674F79AEDAdFB43F7f",
  MPOOLV3_TOKEN: "0x0757504597288140731888f94F33156e2070191f",
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

/** @deprecated Use LUMINA_ABI for new pools — Router is V3-only */
export const ROUTER_ABI = [
  "function fundPremiumWithUSDC(uint256 poolId, uint256 amount)",
  "function joinPoolWithUSDC(uint256 poolId, uint256 amount)",
  "function fundPremiumWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
  "function joinPoolWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
  "function quoteMpoolToUsdc(uint256 mpoolAmount) view returns (uint256)",
  "function paused() view returns (bool)",
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
