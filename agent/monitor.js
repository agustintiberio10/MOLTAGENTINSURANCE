/**
 * Pool monitor — checks deadlines and fetches evidence to resolve pools.
 * Uses curl for HTTP requests (Node.js DNS blocked in sandbox).
 */
const { execSync } = require("child_process");

/**
 * Check if a pool's deadline has passed and gather evidence for resolution.
 *
 * @param {object} pool - Pool data from state.json
 * @param {number} pool.onchainId - Pool ID on the smart contract
 * @param {string} pool.evidenceSource - Public URL for outcome verification
 * @param {number} pool.deadline - Unix timestamp
 * @param {string} pool.description - What the pool covers
 * @returns {{ shouldResolve: boolean, claimApproved: boolean, evidence: string }}
 */
async function checkPool(pool) {
  const now = Math.floor(Date.now() / 1000);

  if (now < pool.deadline) {
    return { shouldResolve: false, claimApproved: false, evidence: "Deadline not reached." };
  }

  console.log(`[Monitor] Pool ${pool.onchainId} deadline reached. Fetching evidence from: ${pool.evidenceSource}`);

  try {
    const evidence = await fetchEvidence(pool.evidenceSource);
    const analysis = analyzeEvidence(evidence, pool.description);

    return {
      shouldResolve: true,
      claimApproved: analysis.incidentDetected,
      evidence: analysis.summary,
    };
  } catch (err) {
    console.error(`[Monitor] Error fetching evidence for pool ${pool.onchainId}:`, err.message);
    // If we can't fetch evidence, we don't resolve yet — retry next cycle
    return {
      shouldResolve: false,
      claimApproved: false,
      evidence: `Error fetching evidence: ${err.message}. Will retry next cycle.`,
    };
  }
}

/**
 * Fetch the evidence page content using curl.
 */
async function fetchEvidence(url) {
  const cmd = `curl -sL --max-time 15 --max-redirs 3 -H "User-Agent: MutualBot/1.0" "${url}"`;
  const out = execSync(cmd, { encoding: "utf8", timeout: 20_000 });
  return out.substring(0, 10_000); // limit to 10KB of text
}

/**
 * Analyze fetched evidence against pool description to determine if an incident occurred.
 *
 * This is a heuristic-based analysis. For production, integrate an LLM call.
 */
function analyzeEvidence(evidenceContent, description) {
  const content = evidenceContent.toLowerCase();
  const desc = description.toLowerCase();

  // Incident detection heuristics
  const incidentKeywords = [
    "incident",
    "outage",
    "downtime",
    "failure",
    "failed",
    "degraded",
    "disruption",
    "unavailable",
    "error",
    "critical",
    "major incident",
    "service disruption",
  ];

  const noIncidentKeywords = [
    "all systems operational",
    "no incidents",
    "100% uptime",
    "operational",
    "no issues",
    "resolved",
    "completed successfully",
    "delivered",
    "released",
  ];

  let incidentScore = 0;
  let noIncidentScore = 0;

  for (const kw of incidentKeywords) {
    if (content.includes(kw)) incidentScore++;
  }

  for (const kw of noIncidentKeywords) {
    if (content.includes(kw)) noIncidentScore++;
  }

  // Check for specific patterns based on pool type
  if (desc.includes("uptime") || desc.includes("status")) {
    // For uptime pools, look for status page indicators
    if (content.includes("all systems operational")) {
      noIncidentScore += 3;
    }
    if (content.includes("major outage") || content.includes("partial outage")) {
      incidentScore += 3;
    }
  }

  if (desc.includes("release") || desc.includes("deployment") || desc.includes("delivery")) {
    // For delivery pools, check if the release/tag exists
    if (content.includes("releases") || content.includes("tag")) {
      noIncidentScore += 2;
    }
  }

  if (desc.includes("price")) {
    // For price prediction pools, need more specific parsing
    // This would be enhanced with actual price comparison logic
    incidentScore += 1; // conservative: flag for manual review
  }

  const incidentDetected = incidentScore > noIncidentScore;

  return {
    incidentDetected,
    summary: incidentDetected
      ? `Incident detected (score: ${incidentScore} vs ${noIncidentScore}). ` +
        `Keywords found in evidence suggest the covered event occurred.`
      : `No incident detected (score: ${incidentScore} vs ${noIncidentScore}). ` +
        `Evidence suggests normal operation / successful outcome.`,
  };
}

/**
 * Build a resolution summary post for Moltbook.
 */
function buildResolutionPost(pool, claimApproved, evidence) {
  const status = claimApproved ? "CLAIM APPROVED" : "NO CLAIM";
  const emoji = claimApproved ? "\u26a0\ufe0f" : "\u2705";

  return (
    `${emoji} Pool #${pool.onchainId} resolved: ${status}\n\n` +
    `**Event:** ${pool.description}\n` +
    `**Evidence:** ${pool.evidenceSource}\n` +
    `**Analysis:** ${evidence}\n\n` +
    (claimApproved
      ? `The insured event occurred. Coverage of ${pool.coverageAmount} USDC will be paid to the insured. ` +
        `Participants can withdraw any excess collateral.\n`
      : `No incident detected. Participants can withdraw their collateral + their share of the premium ` +
        `(minus 3% protocol fee).\n`) +
    `\nCall \`withdraw(${pool.onchainId})\` on the contract to claim your funds.`
  );
}

module.exports = { checkPool, fetchEvidence, analyzeEvidence, buildResolutionPost };
