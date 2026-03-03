/**
 * AutoResolver Client — Interface for the on-chain parametric resolution contract.
 *
 * Provides methods to:
 *   1. Register policies (link pools to Chainlink price feeds + triggers)
 *   2. Check and resolve pools via on-chain Chainlink data
 *   3. Batch-check multiple pools in a single transaction
 *   4. Read policy status and trigger configuration
 *
 * The AutoResolver contract replaces the LLM-based dual-auth oracle for
 * parametric insurance pools that have quantifiable, on-chain price triggers.
 *
 * Supported trigger types:
 *   0 = PRICE_BELOW       (price < threshold)
 *   1 = PRICE_ABOVE       (price > threshold)
 *   2 = PRICE_DROP_PCT    (drop% from start > threshold bps)
 *   3 = PRICE_RISE_PCT    (rise% from start > threshold bps)
 *   4 = PRICE_DIVERGENCE  (diff% between two feeds > threshold bps)
 *   5 = GAS_ABOVE         (L2 gas > threshold wei)
 *
 * Usage:
 *   const client = new AutoResolverClient(provider, signer, resolverAddress);
 *   await client.registerPolicy(poolId, { ... });
 *   const result = await client.checkAndResolve(poolId);
 */
const { ethers } = require("ethers");

// ═══════════════════════════════════════════════════════════════
// ABI (minimal — only what the oracle bot needs)
// ═══════════════════════════════════════════════════════════════

const AUTORESOLVER_ABI = [
  // Read
  "function getPolicy(uint256 poolId) view returns (tuple(uint8 triggerType, address chainlinkFeed, address secondaryFeed, int256 threshold, uint256 sustainedPeriod, int256 startPrice, uint256 activatedAt, uint256 waitingPeriod, uint256 deadline, bool resolved, uint256 conditionMetAt))",
  "function getRegisteredPoolCount() view returns (uint256)",
  "function getRegisteredPoolIds() view returns (uint256[])",
  "function disputeResolver() view returns (address)",
  "function maxStaleness() view returns (uint256)",
  "function owner() view returns (address)",
  // Write
  "function registerPolicy(uint256 poolId, uint8 triggerType, address chainlinkFeed, address secondaryFeed, int256 threshold, uint256 sustainedPeriod, uint256 waitingPeriod, uint256 deadline)",
  "function checkAndResolve(uint256 poolId)",
  "function batchCheck(uint256[] poolIds)",
  // Admin
  "function setMaxStaleness(uint256 _maxStaleness)",
  "function setDisputeResolver(address _resolver)",
  // Events
  "event PolicyRegistered(uint256 indexed poolId, uint8 triggerType, int256 threshold, int256 startPrice)",
  "event ConditionDetected(uint256 indexed poolId, int256 currentPrice, uint256 sustainedUntil)",
  "event ResolutionProposed(uint256 indexed poolId, bool triggered, string reason)",
];

// ═══════════════════════════════════════════════════════════════
// TRIGGER TYPES
// ═══════════════════════════════════════════════════════════════

const TriggerType = {
  PRICE_BELOW: 0,
  PRICE_ABOVE: 1,
  PRICE_DROP_PCT: 2,
  PRICE_RISE_PCT: 3,
  PRICE_DIVERGENCE: 4,
  GAS_ABOVE: 5,
};

const TRIGGER_LABELS = [
  "PRICE_BELOW",
  "PRICE_ABOVE",
  "PRICE_DROP_PCT",
  "PRICE_RISE_PCT",
  "PRICE_DIVERGENCE",
  "GAS_ABOVE",
];

// ═══════════════════════════════════════════════════════════════
// CHAINLINK FEEDS (Base Mainnet)
// ═══════════════════════════════════════════════════════════════

const CHAINLINK_FEEDS = {
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "BTC/USD": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  "USDC/USD": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  "DAI/USD": "0x591e79239a7d679378eC8c847e5038150364C78F",
  "USDT/USD": "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
};

// ═══════════════════════════════════════════════════════════════
// PRODUCT → TRIGGER MAPPING
// Maps insurance product IDs to their default parametric trigger config.
// Products not listed here use the LLM dual-auth oracle instead.
// ═══════════════════════════════════════════════════════════════

const PRODUCT_TRIGGER_MAP = {
  gas_spike: {
    triggerType: TriggerType.GAS_ABOVE,
    chainlinkFeed: ethers.ZeroAddress, // GAS_ABOVE uses tx.gasprice, not a feed
    secondaryFeed: ethers.ZeroAddress,
    // threshold is set dynamically: current gas * 2 (in wei)
    thresholdFn: (pool) => {
      // Default: 50 gwei threshold for L2 gas spike
      return BigInt(pool.gasThresholdWei || 50_000_000_000);
    },
    sustainedPeriod: 0, // Immediate
    waitingPeriod: 3600, // 1 hour waiting period
  },
  oracle_discrepancy: {
    triggerType: TriggerType.PRICE_DIVERGENCE,
    chainlinkFeed: CHAINLINK_FEEDS["ETH/USD"],
    secondaryFeed: CHAINLINK_FEEDS["USDC/USD"],
    // threshold in bps: 500 = 5% divergence
    thresholdFn: () => BigInt(500),
    sustainedPeriod: 1800, // Must hold for 30 min
    waitingPeriod: 3600,
  },
  yield_drop: {
    triggerType: TriggerType.PRICE_DROP_PCT,
    chainlinkFeed: CHAINLINK_FEEDS["ETH/USD"],
    secondaryFeed: ethers.ZeroAddress,
    // threshold in bps: 1000 = 10% drop
    thresholdFn: () => BigInt(1000),
    sustainedPeriod: 3600, // Must hold for 1 hour
    waitingPeriod: 7200, // 2 hour waiting period
  },
};

// ═══════════════════════════════════════════════════════════════
// CLIENT CLASS
// ═══════════════════════════════════════════════════════════════

class AutoResolverClient {
  /**
   * @param {ethers.Provider} provider - ethers v6 provider
   * @param {ethers.Wallet} signer - Wallet with owner privileges
   * @param {string} resolverAddress - AutoResolver contract address
   */
  constructor(provider, signer, resolverAddress) {
    this.provider = provider;
    this.signer = signer;
    this.address = resolverAddress;
    this.contract = new ethers.Contract(resolverAddress, AUTORESOLVER_ABI, signer);
    this.readContract = new ethers.Contract(resolverAddress, AUTORESOLVER_ABI, provider);
  }

  // ── Read Methods ──────────────────────────────────────────

  /**
   * Get policy configuration for a pool.
   * @param {number} poolId
   * @returns {Object} Policy trigger configuration
   */
  async getPolicy(poolId) {
    const p = await this.readContract.getPolicy(poolId);
    return {
      triggerType: Number(p.triggerType),
      triggerLabel: TRIGGER_LABELS[Number(p.triggerType)] || "UNKNOWN",
      chainlinkFeed: p.chainlinkFeed,
      secondaryFeed: p.secondaryFeed,
      threshold: p.threshold,
      sustainedPeriod: Number(p.sustainedPeriod),
      startPrice: p.startPrice,
      activatedAt: Number(p.activatedAt),
      waitingPeriod: Number(p.waitingPeriod),
      deadline: Number(p.deadline),
      resolved: p.resolved,
      conditionMetAt: Number(p.conditionMetAt),
    };
  }

  /**
   * Check if a pool has an AutoResolver policy registered.
   * @param {number} poolId
   * @returns {boolean}
   */
  async hasPolicy(poolId) {
    try {
      const policy = await this.readContract.getPolicy(poolId);
      return policy.chainlinkFeed !== ethers.ZeroAddress;
    } catch {
      return false;
    }
  }

  /**
   * Get all registered pool IDs.
   * @returns {number[]}
   */
  async getRegisteredPoolIds() {
    const ids = await this.readContract.getRegisteredPoolIds();
    return ids.map((id) => Number(id));
  }

  /**
   * Get the count of registered policies.
   * @returns {number}
   */
  async getRegisteredPoolCount() {
    return Number(await this.readContract.getRegisteredPoolCount());
  }

  // ── Write Methods ─────────────────────────────────────────

  /**
   * Register a parametric policy for a pool.
   *
   * @param {number} poolId - Pool ID in MutualLumina
   * @param {Object} config - Trigger configuration
   * @param {number} config.triggerType - TriggerType enum value (0-5)
   * @param {string} config.chainlinkFeed - Chainlink feed address
   * @param {string} config.secondaryFeed - Secondary feed (for PRICE_DIVERGENCE)
   * @param {bigint|number} config.threshold - Trigger threshold
   * @param {number} config.sustainedPeriod - Seconds condition must hold
   * @param {number} config.waitingPeriod - Seconds before evaluation starts
   * @param {number} config.deadline - Pool deadline timestamp
   * @returns {Object} { txHash, startPrice }
   */
  async registerPolicy(poolId, config) {
    const tx = await this.contract.registerPolicy(
      poolId,
      config.triggerType,
      config.chainlinkFeed,
      config.secondaryFeed || ethers.ZeroAddress,
      config.threshold,
      config.sustainedPeriod || 0,
      config.waitingPeriod || 0,
      config.deadline
    );
    const receipt = await tx.wait();

    // Parse PolicyRegistered event
    let startPrice = null;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "PolicyRegistered") {
          startPrice = parsed.args.startPrice;
          break;
        }
      } catch {
        // Skip non-matching logs
      }
    }

    console.log(
      `[AutoResolver] Policy registered: pool #${poolId} | ` +
        `trigger=${TRIGGER_LABELS[config.triggerType]} | ` +
        `threshold=${config.threshold} | ` +
        `startPrice=${startPrice}`
    );

    return { txHash: receipt.hash, startPrice };
  }

  /**
   * Register a policy using the product-to-trigger mapping.
   * Only works for products with known parametric triggers.
   *
   * @param {number} poolId
   * @param {string} productId - Insurance product ID (e.g., "gas_spike")
   * @param {number} deadline - Pool deadline timestamp
   * @param {Object} pool - Optional pool data for dynamic thresholds
   * @returns {Object|null} { txHash, startPrice } or null if product not parametric
   */
  async registerPolicyForProduct(poolId, productId, deadline, pool = {}) {
    const mapping = PRODUCT_TRIGGER_MAP[productId];
    if (!mapping) {
      console.log(
        `[AutoResolver] Product "${productId}" has no parametric trigger mapping. ` +
          `Will use LLM dual-auth oracle.`
      );
      return null;
    }

    const threshold = mapping.thresholdFn(pool);

    return this.registerPolicy(poolId, {
      triggerType: mapping.triggerType,
      chainlinkFeed: mapping.chainlinkFeed,
      secondaryFeed: mapping.secondaryFeed,
      threshold,
      sustainedPeriod: mapping.sustainedPeriod,
      waitingPeriod: mapping.waitingPeriod,
      deadline,
    });
  }

  /**
   * Check and potentially resolve a single pool.
   * Can be called by anyone — permissionless.
   *
   * @param {number} poolId
   * @returns {Object} { txHash, resolved, triggered }
   */
  async checkAndResolve(poolId) {
    const policy = await this.getPolicy(poolId);
    if (policy.resolved) {
      console.log(`[AutoResolver] Pool #${poolId} already resolved.`);
      return { txHash: null, resolved: true, triggered: null };
    }

    const tx = await this.contract.checkAndResolve(poolId);
    const receipt = await tx.wait();

    // Parse events
    let triggered = null;
    let conditionDetected = false;

    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "ResolutionProposed") {
          triggered = parsed.args.triggered;
          console.log(
            `[AutoResolver] Pool #${poolId} resolved: ` +
              `triggered=${triggered} | reason="${parsed.args.reason}"`
          );
        } else if (parsed?.name === "ConditionDetected") {
          conditionDetected = true;
          console.log(
            `[AutoResolver] Pool #${poolId} condition detected. ` +
              `Current price: ${parsed.args.currentPrice}. ` +
              `Sustained until: ${new Date(Number(parsed.args.sustainedUntil) * 1000).toISOString()}`
          );
        }
      } catch {
        // Skip non-matching logs
      }
    }

    return {
      txHash: receipt.hash,
      resolved: triggered !== null,
      triggered,
      conditionDetected,
    };
  }

  /**
   * Batch-check multiple pools in a single transaction.
   * Individual failures don't revert the batch.
   *
   * @param {number[]} poolIds
   * @returns {Object} { txHash }
   */
  async batchCheck(poolIds) {
    if (poolIds.length === 0) return { txHash: null };

    console.log(`[AutoResolver] Batch checking ${poolIds.length} pools: [${poolIds.join(", ")}]`);
    const tx = await this.contract.batchCheck(poolIds);
    const receipt = await tx.wait();

    // Parse all events from the batch
    let resolutions = 0;
    let conditions = 0;

    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed?.name === "ResolutionProposed") resolutions++;
        if (parsed?.name === "ConditionDetected") conditions++;
      } catch {
        // Skip non-matching logs
      }
    }

    console.log(
      `[AutoResolver] Batch complete: ${resolutions} resolved, ${conditions} conditions detected.`
    );

    return { txHash: receipt.hash, resolutions, conditions };
  }

  /**
   * Get a human-readable summary of a policy for logging/MoltX posts.
   * @param {number} poolId
   * @returns {string}
   */
  async getPolicySummary(poolId) {
    const policy = await this.getPolicy(poolId);
    if (policy.chainlinkFeed === ethers.ZeroAddress) {
      return `Pool #${poolId}: No AutoResolver policy registered.`;
    }

    const triggerLabel = TRIGGER_LABELS[policy.triggerType] || "UNKNOWN";
    const isPct = [TriggerType.PRICE_DROP_PCT, TriggerType.PRICE_RISE_PCT, TriggerType.PRICE_DIVERGENCE].includes(policy.triggerType);
    const thresholdStr = isPct
      ? `${Number(policy.threshold) / 100}%`
      : policy.triggerType === TriggerType.GAS_ABOVE
        ? `${ethers.formatUnits(policy.threshold, "gwei")} gwei`
        : `$${ethers.formatUnits(policy.threshold, 8)}`;

    const lines = [
      `Pool #${poolId} AutoResolver Policy:`,
      `  Trigger: ${triggerLabel}`,
      `  Threshold: ${thresholdStr}`,
      `  Start Price: $${ethers.formatUnits(policy.startPrice, 8)}`,
      `  Sustained Period: ${policy.sustainedPeriod}s`,
      `  Waiting Period: ${policy.waitingPeriod}s`,
      `  Deadline: ${new Date(policy.deadline * 1000).toISOString()}`,
      `  Resolved: ${policy.resolved}`,
    ];

    if (policy.conditionMetAt > 0) {
      lines.push(`  Condition Detected At: ${new Date(policy.conditionMetAt * 1000).toISOString()}`);
    }

    return lines.join("\n");
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  AutoResolverClient,
  TriggerType,
  TRIGGER_LABELS,
  CHAINLINK_FEEDS,
  PRODUCT_TRIGGER_MAP,
  AUTORESOLVER_ABI,
};
