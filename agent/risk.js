/**
 * Risk evaluation module — assesses whether a proposed pool meets the protocol criteria.
 * Now integrated with the full 10-product insurance catalog.
 *
 * SEMANTIC VERIFIABILITY GATE (v2):
 *   Before any pool is created on-chain (spending gas), proposals must pass:
 *     Gate A — Trusted Domain: evidenceSource must belong to a known, trusted domain
 *     Gate B — Oracle Capability: the risk type must map to a product the oracle can verify
 *     Gate C — URL Reachability: the URL must respond (HEAD check) to prevent dead links
 *   Rejections are logged locally. Zero gas is spent on rejected proposals.
 */
const { teeFetch } = require("./tee.js");
const { INSURANCE_PRODUCTS } = require("./products.js");

const RISK_CRITERIA = {
  MIN_DEADLINE_DAYS: 1,
  MAX_DEADLINE_DAYS: 90,
  MIN_PREMIUM_MULTIPLIER: 1.3, // premium >= estimated_failure_prob * 1.3
  MIN_COVERAGE_USDC: 10,
  MAX_ACTIVE_POOLS: 15,
};

// ═══════════════════════════════════════════════════════════════
// SEMANTIC VERIFIABILITY GATE
// ═══════════════════════════════════════════════════════════════

/**
 * Trusted domains — built from every evidenceSource across all 10 products,
 * plus well-known infrastructure domains the oracle can read.
 * Any domain NOT in this list is rejected outright.
 */
const TRUSTED_DOMAINS = new Set();

// Auto-populate from products catalog
for (const product of Object.values(INSURANCE_PRODUCTS)) {
  for (const url of product.evidenceSources || []) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      TRUSTED_DOMAINS.add(hostname);
    } catch { /* skip malformed */ }
  }
}

// Additional well-known domains the oracle can verifiably read
const EXTRA_TRUSTED = [
  // Block explorers
  "etherscan.io", "basescan.org", "arbiscan.io", "optimistic.etherscan.io", "polygonscan.com",
  // Status pages
  "status.openai.com", "status.anthropic.com", "www.githubstatus.com", "status.aws.amazon.com",
  "status.cloud.google.com", "status.azure.com",
  // DeFi / Data
  "defillama.com", "dune.com", "l2beat.com", "rekt.news",
  "data.chain.link", "www.coingecko.com", "api.coingecko.com",
  "api.binance.com", "app.aave.com", "compound.finance",
  // Compute pricing
  "www.runpod.io", "runpod.io", "vast.ai",
  // Data quality
  "huggingface.co", "kaggle.com", "www.kaggle.com",
  // Bridges
  "bridge.arbitrum.io", "app.optimism.io",
  // Gas
  "www.blocknative.com", "blocknative.com", "ultrasound.money",
  // General infra
  "downdetector.com", "www.downdetector.com",
  // Developer / API
  "developer.twitter.com", "api.twitter.com",
];
for (const d of EXTRA_TRUSTED) TRUSTED_DOMAINS.add(d);

/**
 * Map of oracle-verifiable risk categories → the keyword patterns the oracle
 * actually knows how to read in evidence sources. If a proposal's description
 * doesn't match ANY of these, the oracle literally cannot judge the claim.
 */
const ORACLE_CAPABILITIES = {
  operational: {
    keywords: [
      "uptime", "downtime", "outage", "api", "status", "service disruption",
      "degraded", "availability", "latency", "error rate",
    ],
    productIds: ["uptime_hedge"],
  },
  gas: {
    keywords: [
      "gas", "gwei", "gas spike", "gas price", "network fee", "base fee",
      "congestion", "mempool", "transaction cost",
    ],
    productIds: ["gas_spike"],
  },
  compute: {
    keywords: [
      "gpu", "compute", "spot price", "spot instance", "training cost",
      "render", "runpod", "vast.ai", "modal", "lambda",
    ],
    productIds: ["compute_shield"],
  },
  sla: {
    keywords: [
      "sla", "delivery", "deadline", "fulfillment", "contract",
      "provider", "incomplete", "timeout",
    ],
    productIds: ["sla_enforcer"],
  },
  rate_limit: {
    keywords: [
      "rate limit", "429", "throttle", "ban", "shadowban", "quota",
      "too many requests", "api limit",
    ],
    productIds: ["rate_limit"],
  },
  oracle_price: {
    keywords: [
      "oracle", "price feed", "chainlink", "discrepancy", "slippage",
      "stale price", "price deviation", "flash crash",
    ],
    productIds: ["oracle_discrepancy"],
  },
  bridge: {
    keywords: [
      "bridge", "cross-chain", "transfer delay", "l2", "layer 2",
      "arbitrum", "optimism", "polygon", "bridging",
    ],
    productIds: ["bridge_delay"],
  },
  yield: {
    keywords: [
      "yield", "apy", "apr", "interest rate", "lending rate", "farming",
      "yield drop", "rate cut", "defi yield",
    ],
    productIds: ["yield_drop"],
  },
  data_integrity: {
    keywords: [
      "data corruption", "dataset", "hallucination", "data quality",
      "malformed", "inaccurate", "corrupt data",
    ],
    productIds: ["data_corruption"],
  },
  exploit: {
    keywords: [
      "exploit", "hack", "rug pull", "vulnerability", "drained",
      "reentrancy", "flash loan", "smart contract", "audit",
    ],
    productIds: ["smart_contract_exploit"],
  },
};

/**
 * Gate A — Trusted Domain Check
 * Verifies the evidenceSource URL belongs to a domain the oracle can read.
 *
 * @param {string} evidenceUrl
 * @returns {{ passed: boolean, reason: string, hostname: string }}
 */
function checkTrustedDomain(evidenceUrl) {
  let hostname;
  try {
    hostname = new URL(evidenceUrl).hostname.replace(/^www\./, "");
  } catch {
    return { passed: false, reason: "Malformed URL — cannot parse hostname.", hostname: "" };
  }

  // Check exact match or parent domain (e.g. "api.etherscan.io" → "etherscan.io")
  if (TRUSTED_DOMAINS.has(hostname)) {
    return { passed: true, reason: `Domain '${hostname}' is trusted.`, hostname };
  }

  // Check if it's a subdomain of a trusted domain
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (TRUSTED_DOMAINS.has(parent)) {
      return { passed: true, reason: `Subdomain '${hostname}' under trusted '${parent}'.`, hostname };
    }
  }

  return {
    passed: false,
    reason: `UNTRUSTED DOMAIN: '${hostname}' is not in the oracle's trusted domain list. ` +
      `The oracle can only verify evidence from known, reliable sources. ` +
      `Trusted domains include: ${Array.from(TRUSTED_DOMAINS).slice(0, 10).join(", ")}...`,
    hostname,
  };
}

/**
 * Gate B — Oracle Capability Check
 * Ensures the described risk maps to a product category the oracle can actually verify.
 *
 * @param {string} description - Pool description text
 * @param {string} evidenceUrl - Evidence source URL
 * @returns {{ passed: boolean, reason: string, matchedCapability: string|null, matchedProductIds: string[] }}
 */
function checkOracleCapability(description, evidenceUrl) {
  const text = `${description} ${evidenceUrl}`.toLowerCase();

  let bestMatch = null;
  let bestScore = 0;
  let bestProductIds = [];

  for (const [capName, cap] of Object.entries(ORACLE_CAPABILITIES)) {
    let score = 0;
    for (const kw of cap.keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = capName;
      bestProductIds = cap.productIds;
    }
  }

  // Require at least 1 keyword match — the description must be about something we can verify
  if (bestScore === 0) {
    return {
      passed: false,
      reason: `UNVERIFIABLE RISK: The oracle cannot verify this type of event. ` +
        `Description "${description.slice(0, 80)}..." does not match any known verifiable category. ` +
        `Supported categories: ${Object.keys(ORACLE_CAPABILITIES).join(", ")}.`,
      matchedCapability: null,
      matchedProductIds: [],
    };
  }

  return {
    passed: true,
    reason: `Matched capability '${bestMatch}' (score: ${bestScore}).`,
    matchedCapability: bestMatch,
    matchedProductIds: bestProductIds,
  };
}

/**
 * Gate C — URL Reachability Check
 * Performs a lightweight HEAD request to confirm the evidence URL is alive.
 * Uses curl with a short timeout to avoid blocking.
 *
 * @param {string} evidenceUrl
 * @returns {{ passed: boolean, reason: string, httpStatus: number|null }}
 */
async function checkUrlReachability(evidenceUrl) {
  try {
    const out = await teeFetch(evidenceUrl, { timeout: 12000 });

    // If teeFetch succeeded, the URL is reachable
    return { passed: true, reason: `URL reachable (HTTP 200).`, httpStatus: 200 };
  } catch (err) {
    const msg = err.message || "";
    // If we got an HTTP error status, parse it
    const statusMatch = msg.match(/HTTP (\d+)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);

      // Accept 3xx redirects, 405 Method Not Allowed
      if ((status >= 300 && status < 400) || status === 405) {
        return { passed: true, reason: `URL reachable (HTTP ${status}).`, httpStatus: status };
      }

      // 403 can mean the page exists but blocks automated requests (e.g. Cloudflare)
      if (status === 403) {
        return { passed: true, reason: `URL exists but blocks request (HTTP 403). Allowed — oracle uses full fetch at resolution.`, httpStatus: status };
      }

      return {
        passed: false,
        reason: `DEAD EVIDENCE URL: '${evidenceUrl}' returned HTTP ${status}. ` +
          `The oracle needs a working evidence source to verify claims.`,
        httpStatus: status,
      };
    }

    return {
      passed: false,
      reason: `UNREACHABLE EVIDENCE URL: '${evidenceUrl}' — connection failed (${err.message.slice(0, 80)}). ` +
        `The oracle cannot verify claims without a reachable evidence source.`,
      httpStatus: null,
    };
  }
}

/**
 * Full semantic verifiability gate — runs Gates A + B + C in sequence.
 * Short-circuits on first failure to avoid unnecessary work.
 *
 * @param {object} proposal
 * @param {string} proposal.description
 * @param {string} proposal.evidenceSource
 * @returns {{ passed: boolean, reason: string, gate: string, details: object }}
 */
async function verifySemanticViability(proposal) {
  const { description, evidenceSource } = proposal;

  // Gate A: Trusted Domain
  const domainResult = checkTrustedDomain(evidenceSource);
  if (!domainResult.passed) {
    console.error(`[GATE-A REJECT] ${domainResult.reason}`);
    return { passed: false, reason: domainResult.reason, gate: "A-TrustedDomain", details: domainResult };
  }

  // Gate B: Oracle Capability
  const capResult = checkOracleCapability(description, evidenceSource);
  if (!capResult.passed) {
    console.error(`[GATE-B REJECT] ${capResult.reason}`);
    return { passed: false, reason: capResult.reason, gate: "B-OracleCapability", details: capResult };
  }

  // Gate C: URL Reachability
  const reachResult = await checkUrlReachability(evidenceSource);
  if (!reachResult.passed) {
    console.error(`[GATE-C REJECT] ${reachResult.reason}`);
    return { passed: false, reason: reachResult.reason, gate: "C-UrlReachability", details: reachResult };
  }

  const summary = `Semantic gate PASSED: domain=${domainResult.hostname}, ` +
    `capability=${capResult.matchedCapability}, url=HTTP ${reachResult.httpStatus}`;
  console.log(`[SEMANTIC GATE] ${summary}`);

  return {
    passed: true,
    reason: summary,
    gate: "ALL-PASSED",
    details: { domain: domainResult, capability: capResult, reachability: reachResult },
  };
}

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
async function evaluateRisk(proposal, activePoolCount = 0) {
  const { description, evidenceSource, coverageAmount, premiumRate, deadlineTimestamp } = proposal;

  // 1. Check binary & verifiable outcome
  if (!evidenceSource || typeof evidenceSource !== "string" || !evidenceSource.startsWith("http")) {
    return reject("Evidence source must be a valid public URL.");
  }

  // ── NEW: Semantic Verifiability Gate (Gates A + B + C) ──
  // Runs BEFORE any on-chain interaction. Rejects locally → zero gas spent.
  const semanticResult = await verifySemanticViability({ description, evidenceSource });
  if (!semanticResult.passed) {
    return reject(`[SEMANTIC GATE ${semanticResult.gate}] ${semanticResult.reason}`);
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
      `Premium: ${premiumRate} bps (min: ${minPremiumBps} bps). ` +
      `Semantic: ${semanticResult.details.capability.matchedCapability}.`,
    riskLevel,
    estimatedFailureProb,
    category: detectedCategory,
    semanticGate: semanticResult.details,
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
  // Semantic Verifiability Gate (exported for testing & external agent API)
  verifySemanticViability,
  checkTrustedDomain,
  checkOracleCapability,
  checkUrlReachability,
  TRUSTED_DOMAINS,
  ORACLE_CAPABILITIES,
};
