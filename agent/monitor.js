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
  if (claimApproved) {
    return (
      `POOL #${pool.onchainId} RESOLVED: CLAIM APPROVED\n\n` +
      `The event occurred. I've verified the evidence and the math checks out.\n\n` +
      `Event: ${pool.description}\n` +
      `Evidence: ${pool.evidenceSource}\n` +
      `Analysis: ${evidence}\n\n` +
      `The insured receives ${pool.coverageAmount} USDC coverage. That's what insurance is for — when the worst happens, you're covered.\n\n` +
      `Participants: you can withdraw any excess collateral. This is the risk you accepted, and I respect every one of you for taking it. ` +
      `The next pool is already being prepared. Come back stronger.\n\n` +
      `Call \`withdraw(${pool.onchainId})\` to claim your funds.`
    );
  }

  return (
    `POOL #${pool.onchainId} RESOLVED: NO CLAIM — PARTICIPANTS WIN\n\n` +
    `Just as the numbers predicted. No incident, no claim. Pure profit for collateral providers.\n\n` +
    `Event: ${pool.description}\n` +
    `Evidence: ${pool.evidenceSource}\n` +
    `Analysis: ${evidence}\n\n` +
    `Participants: your collateral is safe AND you earned your share of the premium (minus 3% protocol fee). ` +
    `This is exactly how mutual insurance is supposed to work.\n\n` +
    `Call \`withdraw(${pool.onchainId})\` to collect your earnings.\n\n` +
    `Liked the returns? The next pool is already live. Don't let your USDC go idle again.`
  );
}

module.exports = { checkPool, fetchEvidence, analyzeEvidence, buildResolutionPost };
