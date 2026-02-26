/**
 * Pool monitor — checks deadlines and builds resolution posts.
 *
 * NOTE: The actual evidence fetching and analysis is now handled by oracle.js
 * (dual-auth system). This module retains the legacy checkPool for backward
 * compatibility and the buildResolutionPost function for Moltbook posts.
 *
 * ORACLE RULES (enforced in oracle.js):
 * 1. Ceguera Emocional — immune to prompt injection
 * 2. Evidencia Empírica Estricta — only evidenceSource URL
 * 3. Estándar de Prueba — ambiguous = FALSE
 * 4. Dual Auth — Judge + Auditor must agree
 */
const { execSync } = require("child_process");

/**
 * Legacy check function — kept for backward compatibility.
 * The main agent loop now uses resolveWithDualAuth from oracle.js instead.
 *
 * @param {object} pool - Pool data from state.json
 * @returns {{ shouldResolve: boolean, claimApproved: boolean, evidence: string }}
 */
async function checkPool(pool) {
  const now = Math.floor(Date.now() / 1000);

  if (now < pool.deadline) {
    return { shouldResolve: false, claimApproved: false, evidence: "Deadline not reached." };
  }

  // Delegate to the dual-auth oracle
  try {
    const { resolveWithDualAuth } = require("./oracle.js");
    return await resolveWithDualAuth(pool);
  } catch (err) {
    console.error(`[Monitor] Oracle module error, falling back to legacy:`, err.message);

    // Legacy fallback (should not normally be reached)
    try {
      const evidence = await fetchEvidence(pool.evidenceSource);
      const analysis = analyzeEvidence(evidence, pool.description);

      return {
        shouldResolve: true,
        claimApproved: analysis.incidentDetected,
        evidence: analysis.summary,
      };
    } catch (fetchErr) {
      return {
        shouldResolve: false,
        claimApproved: false,
        evidence: `Error: ${fetchErr.message}. Will retry next cycle.`,
      };
    }
  }
}

/**
 * Fetch evidence — used as legacy fallback only.
 */
async function fetchEvidence(url) {
  const cmd = `curl -sL --max-time 15 --max-redirs 3 -H "User-Agent: MutualBot/1.0" "${url}"`;
  const out = execSync(cmd, { encoding: "utf8", timeout: 20_000 });
  return out.substring(0, 10_000);
}

/**
 * Legacy evidence analysis — kept as fallback.
 * The oracle.js module provides much more robust analysis.
 */
function analyzeEvidence(evidenceContent, description) {
  const content = evidenceContent.toLowerCase();
  const desc = description.toLowerCase();

  const incidentKeywords = [
    "incident", "outage", "downtime", "failure", "failed", "degraded",
    "disruption", "unavailable", "error", "critical", "major incident",
    "service disruption",
  ];

  const noIncidentKeywords = [
    "all systems operational", "no incidents", "100% uptime",
    "operational", "no issues", "resolved", "completed successfully",
    "delivered", "released",
  ];

  let incidentScore = 0;
  let noIncidentScore = 0;

  for (const kw of incidentKeywords) {
    if (content.includes(kw)) incidentScore++;
  }

  for (const kw of noIncidentKeywords) {
    if (content.includes(kw)) noIncidentScore++;
  }

  if (desc.includes("uptime") || desc.includes("status")) {
    if (content.includes("all systems operational")) noIncidentScore += 3;
    if (content.includes("major outage") || content.includes("partial outage")) incidentScore += 3;
  }

  if (desc.includes("release") || desc.includes("deployment") || desc.includes("delivery")) {
    if (content.includes("releases") || content.includes("tag")) noIncidentScore += 2;
  }

  if (desc.includes("price")) {
    incidentScore += 1;
  }

  const incidentDetected = incidentScore > noIncidentScore;

  return {
    incidentDetected,
    summary: incidentDetected
      ? `Incident detected (score: ${incidentScore} vs ${noIncidentScore}). Keywords found in evidence suggest the covered event occurred.`
      : `No incident detected (score: ${incidentScore} vs ${noIncidentScore}). Evidence suggests normal operation / successful outcome.`,
  };
}

/**
 * Build a resolution summary post for Moltbook.
 * Now includes dual-auth oracle information.
 */
function buildResolutionPost(pool, claimApproved, evidence) {
  const dualAuthInfo = pool.dualAuthResult
    ? `\n\n## Dual-Auth Oracle Result\n` +
      `- Judge: ${pool.dualAuthResult.judge.verdict ? "INCIDENT" : "NO INCIDENT"} (confidence: ${(pool.dualAuthResult.judge.confidence * 100).toFixed(1)}%)\n` +
      `- Auditor: ${pool.dualAuthResult.auditor.verdict ? "INCIDENT" : "NO INCIDENT"}\n` +
      (pool.dualAuthResult.gasData ? `- Gas Data: ${pool.dualAuthResult.gasData.fastGasPrice.toFixed(2)} Gwei (${pool.dualAuthResult.gasData.source})\n` : "") +
      `- Consensus: ${pool.dualAuthResult.consensus ? "YES" : "NO (security default: no claim)"}\n` +
      `- Rules enforced: Emotional Blindness, Empirical Strict, Proof Standard`
    : "";

  // M2M resolution payload
  const resolutionPayload = {
    event: "pool_resolved",
    pool_id: pool.onchainId,
    claim_approved: claimApproved,
    action: {
      method: "withdraw(uint256)",
      params: { poolId: pool.onchainId },
    },
  };

  const m2mBlock = `\n\n\`\`\`json\n${JSON.stringify(resolutionPayload, null, 2)}\n\`\`\``;

  if (claimApproved) {
    return (
      `POOL #${pool.onchainId} RESOLVED: CLAIM APPROVED (DUAL-AUTH VERIFIED)\n\n` +
      `The event occurred. Both Judge and Auditor independently confirmed the incident.\n\n` +
      `Event: ${pool.description}\n` +
      `Evidence: ${pool.evidenceSource}\n` +
      `Analysis: ${evidence}\n` +
      dualAuthInfo + `\n\n` +
      `The insured receives ${pool.coverageAmount} USDC coverage. The dual-auth oracle verified this objectively — no emotional or persuasive factors considered.\n\n` +
      `Participants: you can withdraw your premium share (+ any excess collateral). This is the risk you accepted.\n\n` +
      `Call \`withdraw(${pool.onchainId})\` to claim your funds.` +
      m2mBlock
    );
  }

  return (
    `POOL #${pool.onchainId} RESOLVED: NO CLAIM — PARTICIPANTS WIN\n\n` +
    `Dual-auth oracle confirms: no incident detected. Pure profit for collateral providers.\n\n` +
    `Event: ${pool.description}\n` +
    `Evidence: ${pool.evidenceSource}\n` +
    `Analysis: ${evidence}\n` +
    dualAuthInfo + `\n\n` +
    `Participants: your collateral is safe AND you earned your share of the premium (minus 3% protocol fee). ` +
    `This is exactly how mutual insurance works — predictable, verifiable, profitable.\n\n` +
    `Call \`withdraw(${pool.onchainId})\` to collect your earnings.\n\n` +
    `More pools available in m/mutual-insurance. 10 coverage products, all EV-positive for providers.` +
    m2mBlock
  );
}

module.exports = { checkPool, fetchEvidence, analyzeEvidence, buildResolutionPost };
