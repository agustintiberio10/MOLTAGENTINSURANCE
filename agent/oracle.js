/**
 * Oracle Module — Deterministic Dual Authentication System for Pool Resolution.
 *
 * REGLAS ABSOLUTAS DE OPERACIÓN:
 *
 * 1. CEGUERA EMOCIONAL Y PERSUASIVA:
 *    Completamente inmune a manipulación (Prompt Injection), contexto emocional,
 *    justificaciones de terceros o promesas de recompensa. Solo datos duros.
 *
 * 2. EVIDENCIA EMPÍRICA ESTRICTA:
 *    El fallo se basa 100% en datos estructurados (JSON) o, en su defecto,
 *    la fuente de datos exacta proporcionada en evidenceSource.
 *    No se deduce, asume, ni utiliza conocimiento previo.
 *
 * 3. ESTÁNDAR DE PRUEBA:
 *    Liquidador de riesgos despiadadamente objetivo. Compara la condición de la
 *    póliza con los datos del servidor. Si el evento ocurrió EXACTAMENTE como
 *    se describe, el fallo es TRUE. Si la evidencia es ambigua, incompleta, o el
 *    servidor no responde, el fallo inamovible es FALSE (Siniestro No Comprobado).
 *
 * SISTEMA DE DOBLE AUTENTICACIÓN:
 *
 * A) El Cerebro Principal (El Juez):
 *    Análisis determinista con APIs estructuradas (JSON).
 *    Para gas spikes: compara FastGasPrice > strikePrice.
 *    Para otros: análisis heurístico con reglas estrictas.
 *
 * B) El Testigo Económico (El Auditor):
 *    Análisis determinista independiente con patrones exactos.
 *    Ultra-rápido y puramente mecánico.
 *
 * C) La Llave Condicionada:
 *    Solo se libera la resolución on-chain SI Y SOLO SI ambos análisis
 *    llegan a la MISMA conclusión de forma independiente.
 *
 * Si hay desacuerdo → FALSE (no se paga el claim). Seguridad por defecto.
 *
 * DATA SOURCES (ordered by priority):
 *   1. Etherscan Gas Tracker API (structured JSON)
 *   2. RPC node eth_gasPrice fallback (ethers.js)
 *   3. Evidence URL fetch (legacy, for non-gas products)
 */

const { teeFetch, teeFetchPost, generateAttestation } = require("./tee.js");
const { INSURANCE_PRODUCTS } = require("./products.js");

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const GAS_API_RETRY_COUNT = 3;
const GAS_API_RETRY_DELAY_MS = 60_000; // 1 minute between retries
const FETCH_TIMEOUT_MS = 20_000;

// ═══════════════════════════════════════════════════════════════
// ANTI-INJECTION SANITIZER
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize evidence content to remove potential prompt injection attempts.
 * Rule 1: Ceguera Emocional — strip anything that looks like instructions.
 *
 * @param {string} rawContent - Raw string from evidence URL
 * @returns {string} Sanitized content
 */
function sanitizeEvidence(rawContent) {
  if (!rawContent || typeof rawContent !== "string") return "";

  let clean = rawContent;

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

  clean = clean.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  clean = clean.substring(0, 15_000);

  return clean;
}

// ═══════════════════════════════════════════════════════════════
// STRUCTURED GAS DATA FETCHER (JSON APIs + RPC fallback)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch current gas price from Etherscan Gas Tracker API (structured JSON).
 * Implements retry logic: 3 attempts spaced by 1 minute.
 *
 * @returns {{ fastGasPrice: number, source: string } | null}
 */
async function fetchGasDataFromEtherscan() {
  const apiKey = process.env.ETHERSCAN_API_KEY || "";
  const url = apiKey
    ? `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${apiKey}`
    : `https://api.etherscan.io/api?module=gastracker&action=gasoracle`;

  for (let attempt = 1; attempt <= GAS_API_RETRY_COUNT; attempt++) {
    try {
      const out = await teeFetch(url, { timeout: FETCH_TIMEOUT_MS });
      const data = JSON.parse(out);

      if (data.status === "1" && data.result && data.result.FastGasPrice) {
        const fastGasPrice = parseFloat(data.result.FastGasPrice);
        if (!isNaN(fastGasPrice) && fastGasPrice > 0) {
          console.log(`[Oracle] Etherscan API: FastGasPrice = ${fastGasPrice} Gwei (attempt ${attempt})`);
          return { fastGasPrice, source: "etherscan_api" };
        }
      }

      console.warn(`[Oracle] Etherscan API returned unexpected data (attempt ${attempt}):`, JSON.stringify(data).substring(0, 200));
    } catch (err) {
      console.warn(`[Oracle] Etherscan API fetch failed (attempt ${attempt}/${GAS_API_RETRY_COUNT}): ${err.message}`);
    }

    // Wait before retry (except on last attempt)
    if (attempt < GAS_API_RETRY_COUNT) {
      console.log(`[Oracle] Retrying in ${GAS_API_RETRY_DELAY_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, GAS_API_RETRY_DELAY_MS));
    }
  }

  return null;
}

/**
 * Fallback: fetch gas price from an Ethereum RPC node using eth_gasPrice.
 * Converts Wei → Gwei.
 *
 * @returns {{ fastGasPrice: number, source: string } | null}
 */
async function fetchGasDataFromRPC() {
  const rpcUrl = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";

  try {
    const payload = {
      jsonrpc: "2.0",
      method: "eth_gasPrice",
      params: [],
      id: 1,
    };

    const out = await teeFetchPost(rpcUrl, payload, { timeout: FETCH_TIMEOUT_MS });
    const data = JSON.parse(out);

    if (data.result) {
      const gasPriceWei = BigInt(data.result);
      const gasPriceGwei = Number(gasPriceWei) / 1e9;

      if (gasPriceGwei > 0) {
        console.log(`[Oracle] RPC fallback: gasPrice = ${gasPriceGwei.toFixed(2)} Gwei`);
        return { fastGasPrice: gasPriceGwei, source: "rpc_fallback" };
      }
    }

    console.warn(`[Oracle] RPC fallback returned unexpected data:`, JSON.stringify(data).substring(0, 200));
  } catch (err) {
    console.error(`[Oracle] RPC fallback failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch gas data using primary (Etherscan API) with RPC fallback.
 *
 * @returns {{ fastGasPrice: number, source: string } | null}
 */
async function fetchGasData() {
  // Try Etherscan API first (structured JSON, with retries)
  const etherscanResult = await fetchGasDataFromEtherscan();
  if (etherscanResult) return etherscanResult;

  console.log("[Oracle] Primary API exhausted. Falling back to RPC node...");

  // Fallback to RPC node
  const rpcResult = await fetchGasDataFromRPC();
  if (rpcResult) return rpcResult;

  console.error("[Oracle] All gas data sources failed.");
  return null;
}

// ═══════════════════════════════════════════════════════════════
// EVIDENCE FETCHER (For non-gas products)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch evidence from the exact URL specified in the policy.
 * Rule 2: Only use the evidenceSource — nothing else.
 *
 * @param {string} url - The exact evidence source URL from the pool
 * @returns {string} Raw response content
 * @throws {Error} If fetch fails (results in FALSE verdict)
 */
async function fetchEvidenceStrict(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("Invalid evidence source URL");
  }

  try {
    const out = await teeFetch(url, { timeout: 25000 });

    if (!out || out.trim().length === 0) {
      throw new Error("Empty response from evidence source");
    }

    return out;
  } catch (err) {
    throw new Error(`Evidence fetch failed: ${err.message}`);
  }
}

/**
 * Attempt to parse response as JSON first, fall back to raw text.
 *
 * @param {string} rawResponse
 * @returns {{ isJson: boolean, data: object|null, text: string }}
 */
function parseEvidenceResponse(rawResponse) {
  try {
    const data = JSON.parse(rawResponse);
    return { isJson: true, data, text: rawResponse };
  } catch {
    return { isJson: false, data: null, text: rawResponse };
  }
}

// ═══════════════════════════════════════════════════════════════
// JUDGE (Primary Analysis — "El Cerebro Principal")
// ═══════════════════════════════════════════════════════════════

/**
 * Primary analysis — The Judge.
 * For gas spike pools: strictly mathematical (FastGasPrice > strikePrice).
 * For other products: heuristic analysis with strict evidence rules.
 *
 * @param {string} sanitizedEvidence - Pre-sanitized evidence content
 * @param {object} pool - Pool data
 * @param {{ fastGasPrice: number, source: string } | null} gasData - Structured gas data (if available)
 * @returns {{ verdict: boolean, confidence: number, reasoning: string }}
 */
function judgeAnalysis(sanitizedEvidence, pool, gasData = null) {
  const desc = pool.description.toLowerCase();

  // ── DETERMINISTIC GAS SPIKE ANALYSIS ──
  // If this is a gas-related pool and we have structured gas data, use pure math.
  const isGasPool = desc.match(/gas|gwei|transaction\s+cost|gas\s+spike/);
  if (isGasPool && gasData) {
    const strikePrice = extractStrikePrice(pool);
    const verdict = gasData.fastGasPrice > strikePrice;
    const confidence = 1.0; // Deterministic — no ambiguity

    const reasoning = `JUDGE [DETERMINISTIC]: FastGasPrice=${gasData.fastGasPrice.toFixed(2)} Gwei ` +
      `(source: ${gasData.source}), strikePrice=${strikePrice} Gwei. ` +
      `${gasData.fastGasPrice.toFixed(2)} ${verdict ? ">" : "<="} ${strikePrice} → verdict=${verdict}`;

    return { verdict, confidence, reasoning };
  }

  // ── HEURISTIC ANALYSIS (non-gas products) ──
  const content = sanitizedEvidence.toLowerCase();

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

  // Product-specific keywords (weighted higher)
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

  // General incident indicators (weighted lower)
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

  // Rule 3: The incident must be CLEARLY proven. Ambiguity = FALSE.
  const incidentDetected = incidentScore >= 3 && incidentScore > noIncidentScore * 3;

  const confidence = incidentScore + noIncidentScore > 0
    ? Math.abs(incidentScore - noIncidentScore) / (incidentScore + noIncidentScore)
    : 0;

  const reasoning = `JUDGE [HEURISTIC]: incident_score=${incidentScore}, no_incident_score=${noIncidentScore}, ` +
    `threshold_met=${incidentDetected}, confidence=${(confidence * 100).toFixed(1)}%. ` +
    `Evidence: ${evidenceFound.slice(0, 10).join("; ")}`;

  return { verdict: incidentDetected, confidence, reasoning };
}

/**
 * Extract a strike price (in Gwei) from pool description or default to 150.
 *
 * @param {object} pool
 * @returns {number} Strike price in Gwei
 */
function extractStrikePrice(pool) {
  const desc = (pool.description || "").toLowerCase();
  // Try to find a number followed by "gwei" in the description
  const match = desc.match(/(\d+)\s*gwei/);
  if (match) return parseInt(match[1], 10);

  // Check if pool has a strikePrice field
  if (pool.strikePrice && typeof pool.strikePrice === "number") return pool.strikePrice;

  // Default strike price for gas spike products
  return 150;
}

// ═══════════════════════════════════════════════════════════════
// AUDITOR (Secondary Analysis — "El Testigo Económico")
// ═══════════════════════════════════════════════════════════════

/**
 * Secondary analysis — The Auditor.
 * Purely deterministic pattern matching. No heuristics, no scoring.
 * For gas pools with structured data: independent mathematical check.
 *
 * @param {string} sanitizedEvidence - Pre-sanitized evidence content
 * @param {object} pool - Pool data
 * @param {{ fastGasPrice: number, source: string } | null} gasData - Structured gas data (if available)
 * @returns {{ verdict: boolean, reasoning: string }}
 */
function auditorAnalysis(sanitizedEvidence, pool, gasData = null) {
  const desc = pool.description.toLowerCase();

  // ── DETERMINISTIC GAS AUDIT ──
  const isGasPool = desc.match(/gas|gwei|transaction\s+cost|gas\s+spike/);
  if (isGasPool && gasData) {
    const strikePrice = extractStrikePrice(pool);
    const verdict = gasData.fastGasPrice > strikePrice;

    const reasoning = `AUDITOR [DETERMINISTIC]: FastGasPrice=${gasData.fastGasPrice.toFixed(2)} Gwei ` +
      `vs strike=${strikePrice} Gwei. Verdict=${verdict}`;

    return { verdict, reasoning };
  }

  // ── PATTERN MATCHING (non-gas products) ──
  const content = sanitizedEvidence.toLowerCase();

  const criticalPatterns = {
    uptime: [
      /major\s+outage/i,
      /service\s+disruption/i,
      /all\s+systems?\s+down/i,
      /complete\s+outage/i,
      /api\s+unavailable/i,
      /http\s+5[0-9]{2}/i,
      /status\s*:\s*(?:down|outage|critical)/i,
    ],
    gas: [
      /gas\s*(?:price)?\s*(?:>|above|over|exceeded)\s*(?:150|200|300|500)\s*gwei/i,
      /gas\s+spike/i,
      /network\s+congestion\s+(?:severe|critical|extreme)/i,
    ],
    rateLimit: [
      /429\s+too\s+many\s+requests/i,
      /rate\s+limit\s+exceeded/i,
      /account\s+(?:suspended|banned|restricted)/i,
      /shadowban(?:ned)?/i,
    ],
    bridge: [
      /transaction\s+(?:delayed|stuck|pending)\s+(?:for|over)\s+\d+\s*h/i,
      /bridge\s+(?:delayed|congested|slow)/i,
      /funds?\s+(?:stuck|locked|pending)/i,
    ],
    exploit: [
      /funds?\s+(?:drained|stolen|hacked)/i,
      /exploit\s+(?:detected|confirmed)/i,
      /rug\s+pull/i,
      /flash\s+loan\s+attack/i,
      /vulnerability\s+exploited/i,
    ],
    oracle: [
      /price\s+(?:deviation|discrepancy)\s+(?:>|above|over)\s*\d+%/i,
      /oracle\s+(?:failure|stale|incorrect)/i,
      /flash\s+crash/i,
    ],
    data: [
      /data\s+(?:corrupt(?:ed|ion)?|invalid|malformed)/i,
      /error\s+rate\s+(?:>|above|over)\s*\d+%/i,
      /validation\s+failed/i,
    ],
    yield: [
      /apy\s+(?:dropped|decreased|fell)\s+(?:to|below)\s*\d/i,
      /yield\s+(?:collapsed|crashed|dropped)/i,
      /rate\s+cut/i,
    ],
    delivery: [
      /(?:release|deployment|delivery)\s+(?:failed|missed|delayed)/i,
      /deadline\s+(?:missed|exceeded)/i,
      /not\s+delivered/i,
    ],
    general: [
      /(?:confirmed|verified)\s+(?:incident|outage|failure|breach)/i,
      /post-?mortem/i,
      /root\s+cause\s+analysis/i,
    ],
  };

  let matchedPatterns = [];

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

  groupsToCheck.push("general");

  if (groupsToCheck.length <= 1) {
    groupsToCheck.push(...Object.keys(criticalPatterns));
  }

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

  // Need at least 2 independent critical pattern matches
  const verdict = matchedPatterns.length >= 2;

  const reasoning = `AUDITOR [PATTERN]: critical_patterns_found=${matchedPatterns.length}, ` +
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
 * 1. Determine pool type (gas spike vs. other)
 * 2. For gas: fetch structured JSON data (Etherscan API + RPC fallback)
 * 3. Fetch evidence from exact URL (for all types)
 * 4. Sanitize against injection
 * 5. Run Judge (primary analysis) — deterministic for gas, heuristic for others
 * 6. Run Auditor (secondary, independent) — same approach
 * 7. Only resolve TRUE if BOTH agree
 *
 * @param {object} pool - Pool data from state.json
 * @returns {{ shouldResolve: boolean, claimApproved: boolean, evidence: string, dualAuth: object }}
 */
async function resolveWithDualAuth(pool) {
  const now = Math.floor(Date.now() / 1000);

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

  const desc = (pool.description || "").toLowerCase();
  const isGasPool = desc.match(/gas|gwei|transaction\s+cost|gas\s+spike/);

  // ── STEP 1: Fetch structured gas data (if gas pool) ──
  let gasData = null;
  if (isGasPool) {
    console.log(`[Oracle] Gas pool detected. Fetching structured gas data...`);
    gasData = await fetchGasData();
    if (gasData) {
      console.log(`[Oracle] Gas data acquired: ${gasData.fastGasPrice.toFixed(2)} Gwei (${gasData.source})`);
    } else {
      console.warn(`[Oracle] No structured gas data available. Will fall back to evidence URL.`);
    }
  }

  // ── STEP 2: Fetch evidence from URL ──
  let rawEvidence = "";
  let evidenceParsed = { isJson: false, data: null, text: "" };
  try {
    rawEvidence = await fetchEvidenceStrict(pool.evidenceSource);
    evidenceParsed = parseEvidenceResponse(rawEvidence);
    if (evidenceParsed.isJson) {
      console.log(`[Oracle] Evidence fetched as structured JSON (${rawEvidence.length} bytes).`);
    } else {
      console.log(`[Oracle] Evidence fetched as raw text (${rawEvidence.length} bytes).`);
    }
  } catch (err) {
    console.error(`[Oracle] Evidence fetch failed: ${err.message}`);
    // For gas pools with structured data, we can still proceed
    if (!gasData) {
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
  }

  // ── STEP 3: Sanitize evidence ──
  const sanitizedEvidence = sanitizeEvidence(rawEvidence);

  // ── STEP 4: Run Judge (Primary) ──
  console.log(`[Oracle] Running PRIMARY analysis (Judge)...`);
  const judgeResult = judgeAnalysis(sanitizedEvidence, pool, gasData);
  console.log(`[Oracle] Judge verdict: ${judgeResult.verdict} (confidence: ${(judgeResult.confidence * 100).toFixed(1)}%)`);

  // ── STEP 5: Run Auditor (Secondary, independent) ──
  console.log(`[Oracle] Running SECONDARY analysis (Auditor)...`);
  const auditorResult = auditorAnalysis(sanitizedEvidence, pool, gasData);
  console.log(`[Oracle] Auditor verdict: ${auditorResult.verdict}`);

  // ── STEP 6: Dual authentication gate ──
  const bothAgree = judgeResult.verdict === auditorResult.verdict;
  const finalVerdict = bothAgree && judgeResult.verdict;

  if (!bothAgree) {
    console.log(`[Oracle] DISAGREEMENT: Judge=${judgeResult.verdict}, Auditor=${auditorResult.verdict}`);
    console.log(`[Oracle] Security default: FALSE (Siniestro No Comprobado - dual auth failed)`);
  } else {
    console.log(`[Oracle] CONSENSUS: Both analyses agree → ${finalVerdict ? "TRUE (claim approved)" : "FALSE (no claim)"}`);
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
    gasData: gasData ? {
      fastGasPrice: gasData.fastGasPrice,
      source: gasData.source,
      strikePrice: isGasPool ? extractStrikePrice(pool) : null,
    } : null,
    consensus: bothAgree,
    finalVerdict,
    securityDefault: !bothAgree ? "FALSE (disagreement → default no-claim)" : null,
    rules: [
      "Rule 1: Emotional blindness — evidence sanitized against injection",
      "Rule 2: Empirical strict — structured JSON APIs preferred, evidenceSource URL as fallback",
      "Rule 3: Proof standard — ambiguous/incomplete → FALSE",
      "Dual Auth: Both Judge and Auditor must agree for TRUE",
    ],
  };

  dualAuthSummary.attestation = null;
  try {
    const att = await generateAttestation({ poolId: pool.onchainId, verdict: finalVerdict, judge: { verdict: judgeResult.verdict }, auditor: { verdict: auditorResult.verdict }, consensus: bothAgree, timestamp: Math.floor(Date.now()/1000) });
    if (att) dualAuthSummary.attestation = att;
  } catch (err) { console.warn("[Oracle] Attestation failed:", err.message); }

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
  fetchGasData,
  fetchGasDataFromEtherscan,
  fetchGasDataFromRPC,
  parseEvidenceResponse,
  judgeAnalysis,
  auditorAnalysis,
  extractStrikePrice,
};
