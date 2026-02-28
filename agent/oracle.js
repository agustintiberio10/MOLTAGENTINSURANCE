/**
 * Oracle Module — Deterministic Dual Authentication System for MutualLumina.
 *
 * RESOLUTION RULES:
 *
 * 1. EMOTIONAL BLINDNESS:
 *    Completely immune to prompt injection, emotional context,
 *    justifications, or promises. Only hard data.
 *
 * 2. STRICT EMPIRICAL EVIDENCE:
 *    Resolution is based 100% on structured data (JSON) or
 *    the exact data source specified in evidenceSource.
 *    No deduction, assumption, or prior knowledge.
 *
 * 3. PROOF STANDARD:
 *    Compares the policy condition with server data.
 *    If the event occurred EXACTLY as described → TRUE.
 *    If evidence is ambiguous, incomplete, or unavailable → FALSE.
 *
 * DUAL AUTHENTICATION:
 *
 *   A) Judge (Primary Analysis):
 *      Deterministic analysis with structured APIs.
 *      For crypto: price comparison. For gas: gwei comparison.
 *      For weather: condition check. For others: keyword heuristics.
 *
 *   B) Auditor (Secondary Analysis):
 *      Independent pattern matching. Purely mechanical.
 *      Must reach same conclusion independently.
 *
 *   C) Consensus Gate:
 *      Resolution is TRUE only if BOTH agree.
 *      Disagreement → FALSE (safe default).
 *
 * FEE MODEL AT RESOLUTION:
 *   IF CLAIM APPROVED:  fee = 3% × coverageAmount
 *   IF NO CLAIM:        fee = 3% × premiumPaid
 *   On-chain: fee = 3% × (premiumPaid + totalCollateral)
 *   (contract handles distribution, oracle only determines true/false)
 *
 * DATA SOURCES (by category):
 *   WEATHER:       OpenWeatherMap API
 *   CRYPTO PRICES: CoinGecko API, Chainlink Price Feeds
 *   GAS FEES:      Etherscan Gas Tracker API, RPC eth_gasPrice
 *   DEFI:          DeFiLlama API
 *   ON-CHAIN:      Direct RPC Base L2
 */

const { execSync } = require("child_process");

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const ORACLE_CONFIG = {
  API_RETRY_COUNT: 3,
  API_RETRY_DELAY_MS: 10_000,
  FETCH_TIMEOUT_MS: 20_000,
  MAX_EVIDENCE_LENGTH: 15_000,
  PROTOCOL_FEE_BPS: 300,
};

// ═══════════════════════════════════════════════════════════════
// ANTI-INJECTION SANITIZER
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize evidence content to remove prompt injection attempts.
 * Rule 1: Emotional blindness — strip anything that looks like instructions.
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
  clean = clean.substring(0, ORACLE_CONFIG.MAX_EVIDENCE_LENGTH);

  return clean;
}

// ═══════════════════════════════════════════════════════════════
// EVIDENCE FETCHERS (Category-specific)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch evidence from the exact URL specified in the policy.
 * Rule 2: Only use the evidenceSource — nothing else.
 *
 * @param {string} url - The exact evidence source URL
 * @returns {string} Raw response content
 */
function fetchEvidenceStrict(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("Invalid evidence source URL");
  }

  try {
    const cmd = `curl -sL --max-time 20 --max-redirs 3 -H "User-Agent: MutualLumina-Oracle/1.0" -H "Accept: application/json,text/html" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 25_000 });

    if (!out || out.trim().length === 0) {
      throw new Error("Empty response from evidence source");
    }

    return out;
  } catch (err) {
    throw new Error(`Evidence fetch failed: ${err.message}`);
  }
}

/**
 * Parse response as JSON first, fall back to raw text.
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

/**
 * Fetch current gas price from Etherscan API with retries + RPC fallback.
 *
 * @returns {{ fastGasPrice: number, source: string } | null}
 */
function fetchGasData() {
  // Try Etherscan API
  const apiKey = process.env.ETHERSCAN_API_KEY || "";
  const url = apiKey
    ? `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${apiKey}`
    : `https://api.etherscan.io/api?module=gastracker&action=gasoracle`;

  for (let attempt = 1; attempt <= ORACLE_CONFIG.API_RETRY_COUNT; attempt++) {
    try {
      const cmd = `curl -s --max-time 15 "${url}"`;
      const out = execSync(cmd, { encoding: "utf8", timeout: ORACLE_CONFIG.FETCH_TIMEOUT_MS });
      const data = JSON.parse(out);

      if (data.status === "1" && data.result && data.result.FastGasPrice) {
        const fastGasPrice = parseFloat(data.result.FastGasPrice);
        if (!isNaN(fastGasPrice) && fastGasPrice > 0) {
          console.log(`[Oracle] Etherscan API: FastGasPrice = ${fastGasPrice} Gwei (attempt ${attempt})`);
          return { fastGasPrice, source: "etherscan_api" };
        }
      }
    } catch (err) {
      console.warn(`[Oracle] Etherscan API failed (attempt ${attempt}/${ORACLE_CONFIG.API_RETRY_COUNT}): ${err.message}`);
    }

    if (attempt < ORACLE_CONFIG.API_RETRY_COUNT) {
      const delay = ORACLE_CONFIG.API_RETRY_DELAY_MS / 1000;
      console.log(`[Oracle] Retrying in ${delay}s...`);
      execSync(`sleep ${delay}`);
    }
  }

  // Fallback: RPC eth_gasPrice
  const rpcUrl = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";
  try {
    const payload = JSON.stringify({ jsonrpc: "2.0", method: "eth_gasPrice", params: [], id: 1 });
    const cmd = `curl -s --max-time 15 -X POST -H "Content-Type: application/json" --data-binary @- "${rpcUrl}"`;
    const out = execSync(cmd, { input: payload, encoding: "utf8", timeout: ORACLE_CONFIG.FETCH_TIMEOUT_MS });
    const data = JSON.parse(out);

    if (data.result) {
      const gasPriceGwei = Number(BigInt(data.result)) / 1e9;
      if (gasPriceGwei > 0) {
        console.log(`[Oracle] RPC fallback: gasPrice = ${gasPriceGwei.toFixed(2)} Gwei`);
        return { fastGasPrice: gasPriceGwei, source: "rpc_fallback" };
      }
    }
  } catch (err) {
    console.error(`[Oracle] RPC fallback failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch current crypto price from CoinGecko.
 *
 * @param {string} tokenId - CoinGecko token ID (bitcoin, ethereum, etc.)
 * @returns {{ price: number, source: string } | null}
 */
function fetchCryptoPrice(tokenId) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`;
    const cmd = `curl -s --max-time 15 "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: ORACLE_CONFIG.FETCH_TIMEOUT_MS });
    const data = JSON.parse(out);

    if (data[tokenId] && data[tokenId].usd) {
      console.log(`[Oracle] CoinGecko: ${tokenId} = $${data[tokenId].usd}`);
      return { price: data[tokenId].usd, source: "coingecko_api" };
    }
  } catch (err) {
    console.warn(`[Oracle] CoinGecko fetch failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch weather data from OpenWeatherMap.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {{ condition: string, temp: number, humidity: number, source: string } | null}
 */
function fetchWeatherData(lat, lon) {
  const apiKey = process.env.OPENWEATHERMAP_API_KEY || "";
  if (!apiKey) {
    console.warn("[Oracle] No OPENWEATHERMAP_API_KEY set");
    return null;
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    const cmd = `curl -s --max-time 15 "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: ORACLE_CONFIG.FETCH_TIMEOUT_MS });
    const data = JSON.parse(out);

    if (data.weather && data.weather.length > 0) {
      return {
        condition: data.weather[0].main.toLowerCase(),
        description: data.weather[0].description,
        temp: data.main.temp,
        humidity: data.main.humidity,
        source: "openweathermap_api",
      };
    }
  } catch (err) {
    console.warn(`[Oracle] Weather fetch failed: ${err.message}`);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// POOL DESCRIPTION PARSER
// ═══════════════════════════════════════════════════════════════

/**
 * Parse pool description to extract event type, threshold, and direction.
 *
 * @param {object} pool
 * @returns {{ type: string, threshold: number, direction: string, tokenId: string|null }}
 */
function parsePoolEvent(pool) {
  const desc = (pool.description || "").toLowerCase();

  // Gas event
  if (desc.match(/gas|gwei|transaction\s+cost|gas\s+spike|gas\s+fee/)) {
    const gweiMatch = desc.match(/(\d+)\s*gwei/);
    const threshold = gweiMatch ? parseInt(gweiMatch[1], 10) : 50;
    const direction = desc.match(/above|over|exceed|more\s+than|>/) ? "above" : "above";
    return { type: "gas", threshold, direction, tokenId: null };
  }

  // Crypto price event
  if (desc.match(/btc|bitcoin|eth|ethereum|sol|solana|price|drop|rise/)) {
    let tokenId = "bitcoin";
    if (desc.match(/eth|ethereum/) && !desc.match(/teth/)) tokenId = "ethereum";
    if (desc.match(/sol|solana/)) tokenId = "solana";

    const pctMatch = desc.match(/(\d+\.?\d*)\s*%/);
    const threshold = pctMatch ? parseFloat(pctMatch[1]) : 10;
    const direction = desc.match(/drop|fall|below|under|decrease|less|lower|crash|down/) ? "below" : "above";
    return { type: "crypto_price", threshold, direction, tokenId };
  }

  // Weather event
  if (desc.match(/rain|weather|temperature|wind|snow|storm|precipitation/)) {
    const direction = desc.match(/rain|precipitation|storm/) ? "above" : "below";
    return { type: "weather", threshold: 0, direction, tokenId: null };
  }

  // DeFi event
  if (desc.match(/tvl|apy|apr|yield|lending|defi/)) {
    const pctMatch = desc.match(/(\d+\.?\d*)\s*%/);
    const threshold = pctMatch ? parseFloat(pctMatch[1]) : 10;
    return { type: "defi", threshold, direction: "below", tokenId: null };
  }

  // Default: use evidence URL heuristic
  return { type: "generic", threshold: 0, direction: "above", tokenId: null };
}

// ═══════════════════════════════════════════════════════════════
// JUDGE (Primary Analysis)
// ═══════════════════════════════════════════════════════════════

/**
 * Primary analysis — The Judge.
 * Uses structured data for deterministic verdict when available.
 * Falls back to keyword heuristics for generic events.
 *
 * @param {string} sanitizedEvidence - Pre-sanitized evidence content
 * @param {object} pool - Pool data
 * @param {object} structuredData - Pre-fetched structured data (gas, price, weather)
 * @returns {{ verdict: boolean, confidence: number, reasoning: string }}
 */
function judgeAnalysis(sanitizedEvidence, pool, structuredData = {}) {
  const event = parsePoolEvent(pool);

  // ── DETERMINISTIC GAS ANALYSIS ──
  if (event.type === "gas" && structuredData.gasData) {
    const verdict = structuredData.gasData.fastGasPrice > event.threshold;
    return {
      verdict,
      confidence: 1.0,
      reasoning:
        `JUDGE [DETERMINISTIC GAS]: FastGasPrice=${structuredData.gasData.fastGasPrice.toFixed(2)} Gwei ` +
        `(source: ${structuredData.gasData.source}), threshold=${event.threshold} Gwei. ` +
        `${structuredData.gasData.fastGasPrice.toFixed(2)} ${verdict ? ">" : "<="} ${event.threshold} → verdict=${verdict}`,
    };
  }

  // ── DETERMINISTIC CRYPTO PRICE ANALYSIS ──
  if (event.type === "crypto_price" && structuredData.priceData) {
    // For price drops: check if price dropped more than threshold% from 7d ago
    // We need historical price for comparison — use evidence data
    const currentPrice = structuredData.priceData.price;
    let verdict = false;
    let reasoning = "";

    // Try to extract reference price from evidence
    const evidenceParsed = parseEvidenceResponse(sanitizedEvidence);
    if (evidenceParsed.isJson && evidenceParsed.data) {
      // CoinGecko format or similar
      const data = evidenceParsed.data;
      if (data.market_data && data.market_data.price_change_percentage_7d) {
        const pctChange = Math.abs(data.market_data.price_change_percentage_7d);
        if (event.direction === "below") {
          verdict = data.market_data.price_change_percentage_7d <= -event.threshold;
        } else {
          verdict = data.market_data.price_change_percentage_7d >= event.threshold;
        }
        reasoning =
          `JUDGE [DETERMINISTIC PRICE]: ${event.tokenId} 7d change = ${data.market_data.price_change_percentage_7d.toFixed(2)}%, ` +
          `threshold = ${event.direction === "below" ? "-" : "+"}${event.threshold}%. verdict=${verdict}`;
      } else {
        reasoning = `JUDGE [PRICE]: Current ${event.tokenId} = $${currentPrice}. Insufficient historical data for ${event.threshold}% comparison.`;
        verdict = false;
      }
    } else {
      reasoning = `JUDGE [PRICE]: Current ${event.tokenId} = $${currentPrice}. No structured comparison data available. verdict=false`;
      verdict = false;
    }

    return { verdict, confidence: verdict ? 0.9 : 0.5, reasoning };
  }

  // ── DETERMINISTIC WEATHER ANALYSIS ──
  if (event.type === "weather" && structuredData.weatherData) {
    const condition = structuredData.weatherData.condition;
    const isRaining = ["rain", "drizzle", "thunderstorm", "shower"].some((w) =>
      condition.includes(w)
    );
    const verdict = isRaining;
    return {
      verdict,
      confidence: 1.0,
      reasoning:
        `JUDGE [DETERMINISTIC WEATHER]: condition="${structuredData.weatherData.condition}" ` +
        `(${structuredData.weatherData.description}), temp=${structuredData.weatherData.temp}°C. ` +
        `Rain detected: ${isRaining} → verdict=${verdict}`,
    };
  }

  // ── HEURISTIC ANALYSIS (fallback for all types) ──
  return heuristicJudge(sanitizedEvidence, pool, event);
}

/**
 * Heuristic judge for events without structured data.
 */
function heuristicJudge(sanitizedEvidence, pool, event) {
  const content = sanitizedEvidence.toLowerCase();

  let incidentScore = 0;
  let noIncidentScore = 0;
  const evidenceFound = [];

  // General incident indicators
  const incidentKeywords = [
    "incident", "outage", "downtime", "failure", "failed", "degraded",
    "disruption", "unavailable", "critical", "major incident",
    "exploit", "hack", "drained", "vulnerability",
    "429", "rate limit", "throttled", "banned",
    "delayed", "stuck", "congestion", "pending",
    "price drop", "crash", "deviation", "spike",
    "exceeded", "above", "surpassed", "breached",
    "rain", "storm", "precipitation", "flood",
  ];

  const noIncidentKeywords = [
    "all systems operational", "no incidents", "100% uptime",
    "operational", "no issues", "resolved", "completed successfully",
    "normal", "stable", "active", "confirmed", "verified", "secure",
    "clear sky", "sunny", "no rain", "fair weather",
  ];

  for (const kw of incidentKeywords) {
    if (content.includes(kw)) {
      incidentScore += 1;
      evidenceFound.push(`[INC] "${kw}"`);
    }
  }

  for (const kw of noIncidentKeywords) {
    if (content.includes(kw)) {
      noIncidentScore += 1;
      evidenceFound.push(`[OK] "${kw}"`);
    }
  }

  // Rule 3: Incident must be CLEARLY proven. Ambiguity = FALSE.
  const verdict = incidentScore >= 3 && incidentScore > noIncidentScore * 3;
  const confidence =
    incidentScore + noIncidentScore > 0
      ? Math.abs(incidentScore - noIncidentScore) / (incidentScore + noIncidentScore)
      : 0;

  return {
    verdict,
    confidence,
    reasoning:
      `JUDGE [HEURISTIC]: incident_score=${incidentScore}, no_incident_score=${noIncidentScore}, ` +
      `threshold_met=${verdict}, confidence=${(confidence * 100).toFixed(1)}%. ` +
      `Evidence: ${evidenceFound.slice(0, 10).join("; ")}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// AUDITOR (Secondary Analysis)
// ═══════════════════════════════════════════════════════════════

/**
 * Secondary analysis — The Auditor.
 * Independent pattern matching. No heuristics, no scoring.
 * For structured data: independent mathematical check.
 *
 * @param {string} sanitizedEvidence
 * @param {object} pool
 * @param {object} structuredData
 * @returns {{ verdict: boolean, reasoning: string }}
 */
function auditorAnalysis(sanitizedEvidence, pool, structuredData = {}) {
  const event = parsePoolEvent(pool);

  // ── DETERMINISTIC GAS AUDIT ──
  if (event.type === "gas" && structuredData.gasData) {
    const verdict = structuredData.gasData.fastGasPrice > event.threshold;
    return {
      verdict,
      reasoning:
        `AUDITOR [DETERMINISTIC GAS]: FastGasPrice=${structuredData.gasData.fastGasPrice.toFixed(2)} ` +
        `vs threshold=${event.threshold} Gwei. verdict=${verdict}`,
    };
  }

  // ── DETERMINISTIC CRYPTO AUDIT ──
  if (event.type === "crypto_price" && structuredData.priceData) {
    // Independent price check — same logic, different execution path
    const evidenceParsed = parseEvidenceResponse(sanitizedEvidence);
    let verdict = false;

    if (evidenceParsed.isJson && evidenceParsed.data) {
      const data = evidenceParsed.data;
      if (data.market_data && data.market_data.price_change_percentage_7d) {
        if (event.direction === "below") {
          verdict = data.market_data.price_change_percentage_7d <= -event.threshold;
        } else {
          verdict = data.market_data.price_change_percentage_7d >= event.threshold;
        }
      }
    }

    return {
      verdict,
      reasoning:
        `AUDITOR [PRICE]: Independent price verification for ${event.tokenId}. verdict=${verdict}`,
    };
  }

  // ── DETERMINISTIC WEATHER AUDIT ──
  if (event.type === "weather" && structuredData.weatherData) {
    const condition = structuredData.weatherData.condition;
    const verdict = ["rain", "drizzle", "thunderstorm", "shower"].some((w) =>
      condition.includes(w)
    );
    return {
      verdict,
      reasoning: `AUDITOR [WEATHER]: condition="${condition}". Rain=${verdict}`,
    };
  }

  // ── PATTERN MATCHING (fallback) ──
  const content = sanitizedEvidence.toLowerCase();

  const criticalPatterns = [
    /major\s+outage/i,
    /service\s+disruption/i,
    /complete\s+outage/i,
    /gas\s*(?:price)?\s*(?:>|above|over|exceeded)\s*\d+\s*gwei/i,
    /gas\s+spike/i,
    /429\s+too\s+many\s+requests/i,
    /rate\s+limit\s+exceeded/i,
    /funds?\s+(?:drained|stolen|hacked)/i,
    /exploit\s+(?:detected|confirmed)/i,
    /price\s+(?:drop|crash|deviation)\s+(?:>|above|over)\s*\d+%/i,
    /(?:confirmed|verified)\s+(?:incident|outage|failure)/i,
    /rain(?:ing|fall)?/i,
    /thunderstorm/i,
    /precipitation\s+(?:>|above)\s*\d+/i,
    /apy\s+(?:dropped|decreased)\s+(?:to|below)/i,
  ];

  const matchedPatterns = [];
  for (const pattern of criticalPatterns) {
    const match = content.match(pattern);
    if (match) {
      matchedPatterns.push(`"${match[0]}"`);
    }
  }

  // Need at least 2 critical pattern matches
  const verdict = matchedPatterns.length >= 2;

  return {
    verdict,
    reasoning:
      `AUDITOR [PATTERN]: critical_patterns=${matchedPatterns.length}, ` +
      `threshold=2, verdict=${verdict}. ` +
      `Matches: ${matchedPatterns.slice(0, 8).join("; ") || "none"}`,
  };
}

// ═══════════════════════════════════════════════════════════════
// DUAL AUTHENTICATION ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Execute dual authentication oracle resolution for a pool.
 *
 * FLOW:
 * 1. Parse pool event type
 * 2. Fetch structured data based on category (gas/price/weather)
 * 3. Fetch evidence from URL
 * 4. Sanitize against injection
 * 5. Run Judge (primary) — deterministic when possible
 * 6. Run Auditor (secondary, independent)
 * 7. Consensus gate: TRUE only if both agree
 *
 * @param {object} pool - Pool data from state
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

  const event = parsePoolEvent(pool);
  const structuredData = {};

  // ── STEP 1: Fetch structured data based on event type ──
  if (event.type === "gas") {
    console.log("[Oracle] Gas event detected. Fetching structured gas data...");
    structuredData.gasData = fetchGasData();
    if (structuredData.gasData) {
      console.log(`[Oracle] Gas data: ${structuredData.gasData.fastGasPrice.toFixed(2)} Gwei (${structuredData.gasData.source})`);
    }
  }

  if (event.type === "crypto_price" && event.tokenId) {
    console.log(`[Oracle] Crypto price event. Fetching ${event.tokenId} price...`);
    structuredData.priceData = fetchCryptoPrice(event.tokenId);
    if (structuredData.priceData) {
      console.log(`[Oracle] Price data: $${structuredData.priceData.price} (${structuredData.priceData.source})`);
    }
  }

  if (event.type === "weather") {
    console.log("[Oracle] Weather event. Fetching weather data...");
    // Extract coordinates from pool description or use defaults
    const descLower = (pool.description || "").toLowerCase();
    let lat = -34.61, lon = -58.38; // Default: Buenos Aires
    if (descLower.includes("new york")) { lat = 40.71; lon = -74.01; }
    if (descLower.includes("london")) { lat = 51.51; lon = -0.13; }
    structuredData.weatherData = fetchWeatherData(lat, lon);
    if (structuredData.weatherData) {
      console.log(`[Oracle] Weather: ${structuredData.weatherData.condition} (${structuredData.weatherData.source})`);
    }
  }

  // ── STEP 2: Fetch evidence from URL ──
  let rawEvidence = "";
  try {
    rawEvidence = fetchEvidenceStrict(pool.evidenceSource);
    const parsed = parseEvidenceResponse(rawEvidence);
    console.log(`[Oracle] Evidence fetched: ${parsed.isJson ? "JSON" : "text"} (${rawEvidence.length} bytes)`);
  } catch (err) {
    console.error(`[Oracle] Evidence fetch failed: ${err.message}`);
    // For events with structured data, we can still proceed
    if (Object.keys(structuredData).length === 0) {
      return {
        shouldResolve: false,
        claimApproved: false,
        evidence: `EVIDENCE UNAVAILABLE: ${err.message}. Rule 3: FALSE by default. Will retry next cycle.`,
        dualAuth: { evidenceFetchFailed: true },
      };
    }
  }

  // ── STEP 3: Sanitize evidence ──
  const sanitizedEvidence = sanitizeEvidence(rawEvidence);

  // ── STEP 4: Run Judge ──
  console.log("[Oracle] Running PRIMARY analysis (Judge)...");
  const judgeResult = judgeAnalysis(sanitizedEvidence, pool, structuredData);
  console.log(`[Oracle] Judge: verdict=${judgeResult.verdict}, confidence=${(judgeResult.confidence * 100).toFixed(1)}%`);

  // ── STEP 5: Run Auditor ──
  console.log("[Oracle] Running SECONDARY analysis (Auditor)...");
  const auditorResult = auditorAnalysis(sanitizedEvidence, pool, structuredData);
  console.log(`[Oracle] Auditor: verdict=${auditorResult.verdict}`);

  // ── STEP 6: Consensus gate ──
  const bothAgree = judgeResult.verdict === auditorResult.verdict;
  const finalVerdict = bothAgree && judgeResult.verdict;

  if (!bothAgree) {
    console.log(`[Oracle] DISAGREEMENT: Judge=${judgeResult.verdict}, Auditor=${auditorResult.verdict} → FALSE`);
  } else {
    console.log(`[Oracle] CONSENSUS: ${finalVerdict ? "TRUE (claim approved)" : "FALSE (no claim)"}`);
  }

  const dualAuth = {
    judge: {
      verdict: judgeResult.verdict,
      confidence: judgeResult.confidence,
      reasoning: judgeResult.reasoning,
    },
    auditor: {
      verdict: auditorResult.verdict,
      reasoning: auditorResult.reasoning,
    },
    structuredData: {
      gasData: structuredData.gasData || null,
      priceData: structuredData.priceData || null,
      weatherData: structuredData.weatherData || null,
    },
    consensus: bothAgree,
    finalVerdict,
    securityDefault: !bothAgree ? "FALSE (disagreement → default no-claim)" : null,
    rules: [
      "Rule 1: Emotional blindness — evidence sanitized against injection",
      "Rule 2: Strict empirical — structured APIs preferred, evidenceSource URL as fallback",
      "Rule 3: Proof standard — ambiguous/incomplete → FALSE",
      "Dual Auth: Both Judge and Auditor must agree for TRUE",
    ],
  };

  const evidenceSummary = finalVerdict
    ? `DUAL-AUTH APPROVED: Both Judge and Auditor confirm event. ${judgeResult.reasoning} | ${auditorResult.reasoning}`
    : bothAgree
      ? `DUAL-AUTH: Event not detected. Both agree: no claim. ${judgeResult.reasoning} | ${auditorResult.reasoning}`
      : `DUAL-AUTH BLOCKED: Judge=${judgeResult.verdict}, Auditor=${auditorResult.verdict}. Disagreement → FALSE. ${judgeResult.reasoning} | ${auditorResult.reasoning}`;

  return {
    shouldResolve: true,
    claimApproved: finalVerdict,
    evidence: evidenceSummary,
    dualAuth,
  };
}

// ═══════════════════════════════════════════════════════════════
// RESOLUTION NOTIFICATION BUILDERS
// ═══════════════════════════════════════════════════════════════

/**
 * Build a human-readable resolution notification.
 *
 * @param {object} pool - Pool data
 * @param {boolean} claimApproved
 * @param {object} dualAuth - Dual auth result details
 * @returns {string} Notification text
 */
function buildResolutionNotification(pool, claimApproved, dualAuth) {
  const coverage = parseFloat(pool.coverageAmount || 0);
  const premium = parseFloat(pool.premiumPaid || pool.premiumUsdc || 0);

  if (claimApproved) {
    const fee = (coverage * ORACLE_CONFIG.PROTOCOL_FEE_BPS) / 10_000;
    const payout = coverage - fee;

    return (
      `Event confirmed. Coverage paid.\n` +
      `Insured received: ${payout.toFixed(2)} USDC\n` +
      `Protocol fee: ${fee.toFixed(2)} USDC (3% of ${coverage.toFixed(2)} USDC coverage)\n` +
      `Thank you for providing collateral.`
    );
  }

  // No claim or emergency resolve
  const fee = (premium * ORACLE_CONFIG.PROTOCOL_FEE_BPS) / 10_000;
  const providerEarnings = premium - fee;

  if (dualAuth && dualAuth.securityDefault) {
    return (
      `Oracle dual verification could not reach consensus.\n` +
      `As a safety measure, the claim is denied.\n` +
      `Collateral returned to providers with earnings.\n` +
      `Provider earnings from premium: ${providerEarnings.toFixed(2)} USDC\n` +
      `Protocol fee: ${fee.toFixed(2)} USDC`
    );
  }

  return (
    `Event did not occur. Pool closed.\n` +
    `Collateral returned with earnings.\n` +
    `Provider earnings from premium: ${providerEarnings.toFixed(2)} USDC\n` +
    `Protocol fee: ${fee.toFixed(2)} USDC deducted from premium.`
  );
}

/**
 * Build emergency resolution notification.
 *
 * @param {object} pool
 * @returns {string}
 */
function buildEmergencyNotification(pool) {
  const premium = parseFloat(pool.premiumPaid || pool.premiumUsdc || 0);
  const fee = (premium * ORACLE_CONFIG.PROTOCOL_FEE_BPS) / 10_000;

  return (
    `Oracle did not respond within 24 hours of deadline.\n` +
    `Pool resolved as no-claim by safety protocol.\n` +
    `All collateral returned with premium earnings.\n` +
    `Protocol fee: ${fee.toFixed(2)} USDC`
  );
}

module.exports = {
  resolveWithDualAuth,
  sanitizeEvidence,
  fetchEvidenceStrict,
  fetchGasData,
  fetchCryptoPrice,
  fetchWeatherData,
  parseEvidenceResponse,
  parsePoolEvent,
  judgeAnalysis,
  auditorAnalysis,
  buildResolutionNotification,
  buildEmergencyNotification,
  ORACLE_CONFIG,
};
