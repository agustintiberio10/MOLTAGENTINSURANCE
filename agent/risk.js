/**
 * Risk evaluation module — assesses whether a proposed pool meets the protocol criteria.
 * Now integrated with the full 10-product insurance catalog.
 */
const { INSURANCE_PRODUCTS } = require("./products.js");

const RISK_CRITERIA = {
  MIN_DEADLINE_DAYS: 1,
  MAX_DEADLINE_DAYS: 90,
  MIN_PREMIUM_MULTIPLIER: 1.3, // premium >= estimated_failure_prob * 1.3
  MIN_COVERAGE_USDC: 10,
  MAX_ACTIVE_POOLS: 5,
};

/**
 * Verifiable event categories with base failure probabilities.
 * Built dynamically from the products catalog + legacy categories.
 */
const EVENT_CATEGORIES = {};

// Import all products as event categories
for (const [id, product] of Object.entries(INSURANCE_PRODUCTS)) {
  EVENT_CATEGORIES[id] = {
    label: product.name,
    displayName: product.displayName,
    baseFailureProb: product.baseFailureProb,
    evidencePattern: new RegExp(
      product.evidenceSources
        .map((url) => {
          try {
            const domain = new URL(url).hostname.replace(/\./g, "\\.");
            return domain;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("|"),
      "i"
    ),
    evidenceSources: product.evidenceSources,
    category: product.category,
    icon: product.icon,
  };
}

// Keep legacy categories as aliases for backward compatibility
if (!EVENT_CATEGORIES.api_uptime) {
  EVENT_CATEGORIES.api_uptime = EVENT_CATEGORIES.uptime_hedge;
}
if (!EVENT_CATEGORIES.deployment) {
  EVENT_CATEGORIES.deployment = {
    label: "Production Deployment",
    baseFailureProb: 0.05,
    evidencePattern: /github\.com.*releases/i,
    evidenceSources: ["https://github.com/ethereum/go-ethereum/releases"],
    category: "operational",
  };
}
if (!EVENT_CATEGORIES.price_prediction) {
  EVENT_CATEGORIES.price_prediction = EVENT_CATEGORIES.oracle_discrepancy;
}
if (!EVENT_CATEGORIES.oss_delivery) {
  EVENT_CATEGORIES.oss_delivery = {
    label: "Open Source Delivery",
    baseFailureProb: 0.15,
    evidencePattern: /github\.com/i,
    evidenceSources: ["https://github.com/vercel/next.js/releases"],
    category: "operational",
  };
}

/**
 * Evaluate a pool proposal and return an assessment.
 *
 * @param {object} proposal
 * @param {string} proposal.description
 * @param {string} proposal.evidenceSource - public URL for verification
 * @param {number} proposal.coverageAmount - USDC
 * @param {number} proposal.premiumRate - in basis points (e.g. 500 = 5%)
 * @param {number} proposal.deadlineTimestamp - Unix timestamp
 * @param {number} activePoolCount - current active pools
 * @returns {{ approved: boolean, reason: string, riskLevel: string, estimatedFailureProb: number }}
 */
function evaluateRisk(proposal, activePoolCount = 0) {
  const { description, evidenceSource, coverageAmount, premiumRate, deadlineTimestamp } = proposal;

  // 1. Check binary & verifiable outcome
  if (!evidenceSource || typeof evidenceSource !== "string" || !evidenceSource.startsWith("http")) {
    return reject("Evidence source must be a valid public URL.");
  }

  // 2. Deadline between 1-90 days from now
  const now = Math.floor(Date.now() / 1000);
  const daysUntilDeadline = (deadlineTimestamp - now) / 86400;
  if (daysUntilDeadline < RISK_CRITERIA.MIN_DEADLINE_DAYS) {
    return reject(`Deadline must be at least ${RISK_CRITERIA.MIN_DEADLINE_DAYS} day(s) in the future.`);
  }
  if (daysUntilDeadline > RISK_CRITERIA.MAX_DEADLINE_DAYS) {
    return reject(`Deadline must be within ${RISK_CRITERIA.MAX_DEADLINE_DAYS} days.`);
  }

  // 3. Minimum coverage
  if (coverageAmount < RISK_CRITERIA.MIN_COVERAGE_USDC) {
    return reject(`Coverage must be at least ${RISK_CRITERIA.MIN_COVERAGE_USDC} USDC.`);
  }

  // 4. Active pool capacity
  if (activePoolCount >= RISK_CRITERIA.MAX_ACTIVE_POOLS) {
    return reject(`Maximum ${RISK_CRITERIA.MAX_ACTIVE_POOLS} active pools reached. Wait for resolution.`);
  }

  // 5. Estimate failure probability based on category
  let estimatedFailureProb = 0.10; // default
  let detectedCategory = null;
  for (const [key, cat] of Object.entries(EVENT_CATEGORIES)) {
    if (cat.evidencePattern && cat.evidencePattern.test(evidenceSource)) {
      estimatedFailureProb = cat.baseFailureProb;
      detectedCategory = cat.label;
      break;
    }
    if (description && description.toLowerCase().includes(key.replace(/_/g, " "))) {
      estimatedFailureProb = cat.baseFailureProb;
      detectedCategory = cat.label;
      break;
    }
  }

  // 6. Premium must cover the risk: premium_rate >= failure_prob * 1.3 * 10000 (in bps)
  const minPremiumBps = Math.ceil(estimatedFailureProb * RISK_CRITERIA.MIN_PREMIUM_MULTIPLIER * 10000);
  if (premiumRate < minPremiumBps) {
    return reject(
      `Premium rate (${premiumRate} bps) is too low for estimated risk. ` +
        `Minimum required: ${minPremiumBps} bps (failure prob: ${(estimatedFailureProb * 100).toFixed(1)}%).`
    );
  }

  // All checks passed
  const riskLevel = estimatedFailureProb <= 0.05 ? "low" : estimatedFailureProb <= 0.20 ? "medium" : "high";

  return {
    approved: true,
    reason: `Pool approved. Category: ${detectedCategory || "General"}. ` +
      `Risk: ${riskLevel} (${(estimatedFailureProb * 100).toFixed(1)}% est. failure). ` +
      `Premium: ${premiumRate} bps (min: ${minPremiumBps} bps).`,
    riskLevel,
    estimatedFailureProb,
    category: detectedCategory,
  };
}

function reject(reason) {
  return { approved: false, reason, riskLevel: null, estimatedFailureProb: null };
}

/**
 * Generate a pool proposal for a verifiable event.
 * Now supports all 10 product categories.
 *
 * @param {string} category - Category key from EVENT_CATEGORIES
 * @param {number} coverageUsdc - Coverage amount in USDC
 * @param {number} daysUntilDeadline - Days until deadline
 * @returns {object|null} - Proposal object
 */
function generatePoolProposal(category, coverageUsdc, daysUntilDeadline) {
  const cat = EVENT_CATEGORIES[category];
  if (!cat) return null;

  const failureProb = cat.baseFailureProb;
  const premiumRateBps = Math.ceil(failureProb * RISK_CRITERIA.MIN_PREMIUM_MULTIPLIER * 10000);
  const premiumUsdc = (coverageUsdc * premiumRateBps) / 10000;
  const expectedReturn = ((premiumUsdc * 0.97) / coverageUsdc) * 100; // after 3% fee

  return {
    category: cat.label || cat.displayName,
    displayName: cat.displayName || cat.label,
    premiumRateBps,
    premiumUsdc: premiumUsdc.toFixed(2),
    expectedReturnPct: expectedReturn.toFixed(2),
    riskLevel: failureProb <= 0.05 ? "low" : failureProb <= 0.20 ? "medium" : "high",
    failureProb,
    coverageUsdc,
    daysUntilDeadline,
    icon: cat.icon || "",
    evidenceSources: cat.evidenceSources || [],
  };
}

module.exports = {
  evaluateRisk,
  generatePoolProposal,
  EVENT_CATEGORIES,
  RISK_CRITERIA,
};
