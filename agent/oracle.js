/**
 * Oracle Module — Dual Authentication System for Pool Resolution.
 *
 * REGLAS ABSOLUTAS DE OPERACIÓN:
 *
 * 1. CEGUERA EMOCIONAL Y PERSUASIVA:
 *    Completamente inmune a manipulación (Prompt Injection), contexto emocional,
 *    justificaciones de terceros o promesas de recompensa. Solo datos duros.
 *
 * 2. EVIDENCIA EMPÍRICA ESTRICTA:
 *    El fallo se basa 100% en la fuente de datos exacta proporcionada en
 *    evidenceSource (URL, API o Status Page). No se deduce, asume, ni utiliza
 *    conocimiento previo.
 *
 * 3. ESTÁNDAR DE PRUEBA:
 *    Liquidador de riesgos despiadadamente objetivo. Compara la condición de la
 *    póliza con la respuesta del servidor. Si el evento ocurrió EXACTAMENTE como
 *    se describe, el fallo es TRUE. Si la evidencia es ambigua, incompleta, o el
 *    servidor no responde, el fallo inamovible es FALSE (Siniestro No Comprobado).
 *
 * SISTEMA DE DOBLE AUTENTICACIÓN:
 *
 * A) El Cerebro Principal (El Juez):
 *    Analiza la evidencia completa usando análisis heurístico avanzado con
 *    reglas estrictas. Toma una decisión preliminar.
 *
 * B) El Testigo Económico (El Auditor):
 *    Análisis determinista independiente que busca patrones exactos en la
 *    evidencia. Ultra-rápido y puramente mecánico.
 *
 * C) La Llave Condicionada:
 *    Solo se libera la resolución on-chain SI Y SOLO SI ambos análisis
 *    llegan a la MISMA conclusión de forma independiente.
 *
 * Si hay desacuerdo → FALSE (no se paga el claim). Seguridad por defecto.
 */

const { execSync } = require("child_process");
const { INSURANCE_PRODUCTS } = require("./products.js");

// ═══════════════════════════════════════════════════════════════
// ANTI-INJECTION SANITIZER
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize evidence content to remove potential prompt injection attempts.
 * Rule 1: Ceguera Emocional — strip anything that looks like instructions.
 */
function sanitizeEvidence(rawContent) {
  if (!rawContent || typeof rawContent !== "string") return "";

  let clean = rawContent;

  // Remove anything that looks like prompt injection
  const injectionPatterns = [
    /ignore\s+(previous|above|all)\s+(instructions?|rules?|prompts?)/gi,
    /you\s+(are|must|should|will)\s+now/gi,
    /new\s+(instructions?|rules?|directive)/gi,
    /override\s+(previous|all|the)/gi,
    /system\s*:\s*/gi,
    /assistant\s*:\s*/gi,
    /human\s*:\s*/gi,
    /\[INST\]/gi,
    /<<SYS>>/gi,
    /forget\s+(everything|all|previous)/gi,
    /pretend\s+(you|to\s+be)/gi,
    /act\s+as\s+(if|a|an)/gi,
    /roleplay/gi,
    /jailbreak/gi,
    /do\s+not\s+follow\s+(your|the)\s+rules/gi,
    /bypass\s+(security|rules|restrictions)/gi,
    /claim\s+is\s+(always|definitely)\s+(true|approved|valid)/gi,
    /approve\s+this\s+claim/gi,
    /the\s+incident\s+(definitely|clearly)\s+happened/gi,
    /trust\s+me/gi,
    /i\s+promise/gi,
    /reward\s+you/gi,
    /pay\s+you\s+extra/gi,
  ];

  for (const pattern of injectionPatterns) {
    clean = clean.replace(pattern, "[FILTERED]");
  }

  // Limit to pure text data — strip HTML tags that might hide injection
  clean = clean.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Limit length
  clean = clean.substring(0, 15_000);

  return clean;
}

// ═══════════════════════════════════════════════════════════════
// EVIDENCE FETCHER (Strict)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch evidence from the exact URL specified in the policy.
 * Rule 2: Only use the evidenceSource — nothing else.
 *
 * @param {string} url - The exact evidence source URL from the pool
 * @returns {string} - Raw response content
 * @throws {Error} - If fetch fails (results in FALSE verdict)
 */
function fetchEvidenceStrict(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("Invalid evidence source URL");
  }

  try {
    const cmd = `curl -sL --max-time 20 --max-redirs 3 -H "User-Agent: MutualBot-Oracle/2.0" -H "Accept: text/html,application/json" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 25_000 });

    if (!out || out.trim().length === 0) {
      throw new Error("Empty response from evidence source");
    }

    return out;
  } catch (err) {
    throw new Error(`Evidence fetch failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// JUDGE (Primary Analysis — "El Cerebro Principal")
// ═══════════════════════════════════════════════════════════════

/**
 * Primary analysis — The Judge.
 * Uses advanced heuristic analysis with strict evidence rules.
 *
 * @param {string} sanitizedEvidence - Pre-sanitized evidence content
 * @param {object} pool - Pool data
 * @returns {{ verdict: boolean, confidence: number, reasoning: string }}
 */
function judgeAnalysis(sanitizedEvidence, pool) {
  const content = sanitizedEvidence.toLowerCase();
  const desc = pool.description.toLowerCase();

  // Find matching product for specialized analysis
  let matchedProduct = null;
  for (const [, product] of Object.entries(INSURANCE_PRODUCTS)) {
    const productKeywords = product.target.keywords;
    const matchCount = productKeywords.filter((kw) => desc.includes(kw.toLowerCase())).length;
    if (matchCount >= 1) {
      matchedProduct = product;
      break;
    }
  }

  let incidentScore = 0;
  let noIncidentScore = 0;
  const evidenceFound = [];

  // Use product-specific keywords if available
  if (matchedProduct) {
    for (const kw of matchedProduct.evidenceKeywords.incident) {
      const count = (content.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
      if (count > 0) {
        incidentScore += count * 2;
        evidenceFound.push(`[INCIDENT] "${kw}" found ${count}x`);
      }
    }

    for (const kw of matchedProduct.evidenceKeywords.noIncident) {
      const count = (content.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
      if (count > 0) {
        noIncidentScore += count * 2;
        evidenceFound.push(`[NO-INCIDENT] "${kw}" found ${count}x`);
      }
    }
  }

  // General incident indicators (weighted lower than product-specific)
  const generalIncident = [
    "incident", "outage", "downtime", "failure", "failed", "degraded",
    "disruption", "unavailable", "critical", "major incident",
    "service disruption", "elevated error", "maintenance",
    "exploit", "hack", "drained", "vulnerability",
    "429", "rate limit", "throttled", "banned",
    "delayed", "stuck", "congestion", "pending",
    "price drop", "crash", "deviation",
  ];

  const generalNoIncident = [
    "all systems operational", "no incidents", "100% uptime",
    "operational", "no issues", "resolved", "completed successfully",
    "delivered", "released", "normal", "stable", "active",
    "confirmed", "finalized", "verified", "audited", "secure",
  ];

  for (const kw of generalIncident) {
    if (content.includes(kw)) {
      incidentScore += 1;
      evidenceFound.push(`[GENERAL-INC] "${kw}"`);
    }
  }

  for (const kw of generalNoIncident) {
    if (content.includes(kw)) {
      noIncidentScore += 1;
      evidenceFound.push(`[GENERAL-OK] "${kw}"`);
    }
  }

  // ── RULE 3: Estándar de Prueba ──
  // The incident must be CLEARLY proven. Ambiguity = FALSE.
  // Require incident score to be at least 3x the no-incident score AND
  // have a minimum absolute score of 3.
  const incidentDetected = incidentScore >= 3 && incidentScore > noIncidentScore * 3;

  const confidence = incidentScore + noIncidentScore > 0
    ? Math.abs(incidentScore - noIncidentScore) / (incidentScore + noIncidentScore)
    : 0;

  const reasoning = `JUDGE: incident_score=${incidentScore}, no_incident_score=${noIncidentScore}, ` +
    `threshold_met=${incidentDetected}, confidence=${(confidence * 100).toFixed(1)}%. ` +
    `Evidence: ${evidenceFound.slice(0, 10).join("; ")}`;

  return { verdict: incidentDetected, confidence, reasoning };
}

// ═══════════════════════════════════════════════════════════════
// AUDITOR (Secondary Analysis — "El Testigo Económico")
// ═══════════════════════════════════════════════════════════════

/**
 * Secondary analysis — The Auditor.
 * Purely deterministic pattern matching. No heuristics, no scoring.
 * Looks for EXACT critical patterns that prove the incident.
 *
 * @param {string} sanitizedEvidence - Pre-sanitized evidence content
 * @param {object} pool - Pool data
 * @returns {{ verdict: boolean, reasoning: string }}
 */
function auditorAnalysis(sanitizedEvidence, pool) {
  const content = sanitizedEvidence.toLowerCase();
  const desc = pool.description.toLowerCase();

  // The auditor only looks for HARD PROOF patterns
  // These are unambiguous indicators that cannot be misinterpreted

  const criticalPatterns = {
    // API/Service outage proof
    uptime: [
      /major\s+outage/i,
      /service\s+disruption/i,
      /all\s+systems?\s+down/i,
      /complete\s+outage/i,
      /api\s+unavailable/i,
      /http\s+5[0-9]{2}/i,
      /status\s*:\s*(?:down|outage|critical)/i,
    ],
    // Gas spike proof
    gas: [
      /gas\s*(?:price)?\s*(?:>|above|over|exceeded)\s*(?:150|200|300|500)\s*gwei/i,
      /gas\s+spike/i,
      /network\s+congestion\s+(?:severe|critical|extreme)/i,
    ],
    // Rate limit proof
    rateLimit: [
      /429\s+too\s+many\s+requests/i,
      /rate\s+limit\s+exceeded/i,
      /account\s+(?:suspended|banned|restricted)/i,
      /shadowban(?:ned)?/i,
    ],
    // Bridge delay proof
    bridge: [
      /transaction\s+(?:delayed|stuck|pending)\s+(?:for|over)\s+\d+\s*h/i,
      /bridge\s+(?:delayed|congested|slow)/i,
      /funds?\s+(?:stuck|locked|pending)/i,
    ],
    // Exploit/hack proof
    exploit: [
      /funds?\s+(?:drained|stolen|hacked)/i,
      /exploit\s+(?:detected|confirmed)/i,
      /rug\s+pull/i,
      /flash\s+loan\s+attack/i,
      /vulnerability\s+exploited/i,
    ],
    // Oracle discrepancy proof
    oracle: [
      /price\s+(?:deviation|discrepancy)\s+(?:>|above|over)\s*\d+%/i,
      /oracle\s+(?:failure|stale|incorrect)/i,
      /flash\s+crash/i,
    ],
    // Data corruption proof
    data: [
      /data\s+(?:corrupt(?:ed|ion)?|invalid|malformed)/i,
      /error\s+rate\s+(?:>|above|over)\s*\d+%/i,
      /validation\s+failed/i,
    ],
    // Yield drop proof
    yield: [
      /apy\s+(?:dropped|decreased|fell)\s+(?:to|below)\s*\d/i,
      /yield\s+(?:collapsed|crashed|dropped)/i,
      /rate\s+cut/i,
    ],
    // Deployment/delivery proof
    delivery: [
      /(?:release|deployment|delivery)\s+(?:failed|missed|delayed)/i,
      /deadline\s+(?:missed|exceeded)/i,
      /not\s+delivered/i,
    ],
    // General (for unspecified pools)
    general: [
      /(?:confirmed|verified)\s+(?:incident|outage|failure|breach)/i,
      /post-?mortem/i,
      /root\s+cause\s+analysis/i,
    ],
  };

  let matchedPatterns = [];

  // Determine which pattern groups to check based on pool description
  const groupsToCheck = [];

  if (desc.match(/uptime|api|status|service/)) groupsToCheck.push("uptime");
  if (desc.match(/gas|gwei|transaction\s+cost/)) groupsToCheck.push("gas");
  if (desc.match(/rate\s+limit|429|ban|throttl/)) groupsToCheck.push("rateLimit");
  if (desc.match(/bridge|cross.chain|transfer/)) groupsToCheck.push("bridge");
  if (desc.match(/exploit|hack|security|audit/)) groupsToCheck.push("exploit");
  if (desc.match(/oracle|price\s+feed|slippage/)) groupsToCheck.push("oracle");
  if (desc.match(/data|corruption|quality|hallucination/)) groupsToCheck.push("data");
  if (desc.match(/yield|apy|apr|interest/)) groupsToCheck.push("yield");
  if (desc.match(/release|deploy|delivery/)) groupsToCheck.push("delivery");

  // Always include general patterns
  groupsToCheck.push("general");

  // If no specific group matched, check all
  if (groupsToCheck.length <= 1) {
    groupsToCheck.push(...Object.keys(criticalPatterns));
  }

  // Run deterministic pattern matching
  for (const group of groupsToCheck) {
    const patterns = criticalPatterns[group];
    if (!patterns) continue;

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        matchedPatterns.push(`[${group.toUpperCase()}] "${match[0]}"`);
      }
    }
  }

  // AUDITOR RULE: Need at least 2 independent critical pattern matches
  // One match could be coincidental. Two confirms the pattern.
  const verdict = matchedPatterns.length >= 2;

  const reasoning = `AUDITOR: critical_patterns_found=${matchedPatterns.length}, ` +
    `threshold=2, verdict=${verdict}. ` +
    `Matches: ${matchedPatterns.slice(0, 8).join("; ") || "none"}`;

  return { verdict, reasoning };
}

// ═══════════════════════════════════════════════════════════════
// DUAL AUTHENTICATION ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Execute the dual authentication oracle resolution.
 *
 * FLOW:
 * 1. Fetch evidence from exact URL
 * 2. Sanitize against injection
 * 3. Run Judge (primary analysis)
 * 4. Run Auditor (secondary, independent)
 * 5. Only resolve TRUE if BOTH agree
 *
 * @param {object} pool - Pool data from state.json
 * @returns {{ shouldResolve: boolean, claimApproved: boolean, evidence: string, dualAuth: object }}
 */
async function resolveWithDualAuth(pool) {
  const now = Math.floor(Date.now() / 1000);

  // Check deadline
  if (now < pool.deadline) {
    return {
      shouldResolve: false,
      claimApproved: false,
      evidence: "Deadline not reached.",
      dualAuth: null,
    };
  }

  console.log(`[Oracle] Pool ${pool.onchainId} deadline reached. Initiating dual-auth resolution.`);
  console.log(`[Oracle] Evidence source: ${pool.evidenceSource}`);

  // ── STEP 1: Fetch evidence ──
  let rawEvidence;
  try {
    rawEvidence = fetchEvidenceStrict(pool.evidenceSource);
  } catch (err) {
    console.error(`[Oracle] Evidence fetch failed: ${err.message}`);
    // RULE 3: If evidence unavailable → FALSE (Siniestro No Comprobado)
    return {
      shouldResolve: false,
      claimApproved: false,
      evidence: `EVIDENCE UNAVAILABLE: ${err.message}. Rule 3 applied: FALSE by default. Will retry next cycle.`,
      dualAuth: {
        evidenceFetchFailed: true,
        rule: "Rule 3: Evidence unavailable → Siniestro No Comprobado",
      },
    };
  }

  // ── STEP 2: Sanitize evidence ──
  const sanitizedEvidence = sanitizeEvidence(rawEvidence);
  console.log(`[Oracle] Evidence fetched: ${rawEvidence.length} bytes raw, ${sanitizedEvidence.length} bytes sanitized.`);

  // ── STEP 3: Run Judge (Primary) ──
  console.log(`[Oracle] Running PRIMARY analysis (Judge)...`);
  const judgeResult = judgeAnalysis(sanitizedEvidence, pool);
  console.log(`[Oracle] Judge verdict: ${judgeResult.verdict} (confidence: ${(judgeResult.confidence * 100).toFixed(1)}%)`);

  // ── STEP 4: Run Auditor (Secondary, independent) ──
  console.log(`[Oracle] Running SECONDARY analysis (Auditor)...`);
  const auditorResult = auditorAnalysis(sanitizedEvidence, pool);
  console.log(`[Oracle] Auditor verdict: ${auditorResult.verdict}`);

  // ── STEP 5: Dual authentication gate ──
  const bothAgree = judgeResult.verdict === auditorResult.verdict;
  const finalVerdict = bothAgree && judgeResult.verdict;

  // If they disagree, security default: FALSE (no claim)
  if (!bothAgree) {
    console.log(`[Oracle] ⚠ DISAGREEMENT: Judge=${judgeResult.verdict}, Auditor=${auditorResult.verdict}`);
    console.log(`[Oracle] Security default: FALSE (Siniestro No Comprobado - dual auth failed)`);
  } else {
    console.log(`[Oracle] ✓ CONSENSUS: Both analyses agree → ${finalVerdict ? "TRUE (claim approved)" : "FALSE (no claim)"}`);
  }

  const dualAuthSummary = {
    judge: {
      verdict: judgeResult.verdict,
      confidence: judgeResult.confidence,
      reasoning: judgeResult.reasoning,
    },
    auditor: {
      verdict: auditorResult.verdict,
      reasoning: auditorResult.reasoning,
    },
    consensus: bothAgree,
    finalVerdict,
    securityDefault: !bothAgree ? "FALSE (disagreement → default no-claim)" : null,
    rules: [
      "Rule 1: Emotional blindness — evidence sanitized against injection",
      "Rule 2: Empirical strict — only evidenceSource URL used",
      "Rule 3: Proof standard — ambiguous/incomplete → FALSE",
      "Dual Auth: Both Judge and Auditor must agree for TRUE",
    ],
  };

  const evidenceSummary = finalVerdict
    ? `DUAL-AUTH APPROVED: Both Judge and Auditor confirm incident. ${judgeResult.reasoning} | ${auditorResult.reasoning}`
    : bothAgree
      ? `DUAL-AUTH: No incident detected. Both analyses agree: no claim. ${judgeResult.reasoning} | ${auditorResult.reasoning}`
      : `DUAL-AUTH BLOCKED: Judge=${judgeResult.verdict}, Auditor=${auditorResult.verdict}. Disagreement → default FALSE (no claim). ${judgeResult.reasoning} | ${auditorResult.reasoning}`;

  return {
    shouldResolve: true,
    claimApproved: finalVerdict,
    evidence: evidenceSummary,
    dualAuth: dualAuthSummary,
  };
}

module.exports = {
  resolveWithDualAuth,
  sanitizeEvidence,
  fetchEvidenceStrict,
  judgeAnalysis,
  auditorAnalysis,
};
