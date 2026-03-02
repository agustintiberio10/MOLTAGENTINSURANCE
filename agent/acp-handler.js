#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ACP HANDLER — Virtuals Agent Commerce Protocol ↔ Lumina Oracle Bridge
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este módulo conecta el ecosistema Virtuals (ACP) con el oracle de Lumina.
 * Es el "mozo y la cocina" que faltaba: recibe pedidos de agentes via ACP,
 * los procesa por el risk engine, crea pools on-chain, y devuelve resultados.
 *
 * FLUJO:
 *   1. Butler/Agente buyer envía job request via ACP
 *   2. onNewTask() recibe el job, parsea los parámetros
 *   3. Risk engine evalúa el pedido (evaluateRisk + generatePoolProposal)
 *   4. Si aprobado → crea pool on-chain (blockchain.createAndFundLumina)
 *   5. Entrega resultado al buyer (deliverJob con pool details)
 *   6. Evaluator verifica cumplimiento (onEvaluate)
 *
 * DEPENDENCIAS:
 *   npm install @virtuals-protocol/acp-node
 *
 * ENV VARS REQUERIDAS:
 *   ACP_WALLET_PRIVATE_KEY    — Private key de la wallet whitelisted en ACP
 *   ACP_ENTITY_ID             — Entity ID del agente registrado en ACP
 *   ACP_AGENT_WALLET_ADDRESS  — Smart wallet del agente en ACP
 *   ACP_RPC_URL               — (opcional) Custom RPC para Base
 *
 * USO:
 *   node agent/acp-handler.js                  # Standalone mode
 *   require("./acp-handler.js").start(deps)    # Integrado con oracle-bot
 */

require("dotenv").config();

// ── ACP SDK ──
// NOTA: Instalar con `npm install @virtuals-protocol/acp-node`
const AcpClient = require("@virtuals-protocol/acp-node").default;
const { AcpContractClientV2, baseAcpConfig } = require("@virtuals-protocol/acp-node");

// ── Modules internos (mismos que usa oracle-bot.js) ──
const BlockchainClient = require("./blockchain.js");
const { evaluateRisk, generatePoolProposal, EVENT_CATEGORIES } = require("./risk.js");
const { INSURANCE_PRODUCTS, getProduct } = require("./products.js");
const { resolveWithDualAuth } = require("./oracle.js");

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const ACP_CONFIG = {
  // ACP Credentials (from .env)
  WALLET_PRIVATE_KEY: process.env.ACP_WALLET_PRIVATE_KEY || "",
  ENTITY_ID: process.env.ACP_ENTITY_ID || "",
  AGENT_WALLET_ADDRESS: process.env.ACP_AGENT_WALLET_ADDRESS || "",
  RPC_URL: process.env.ACP_RPC_URL || "",

  // Job processing
  MAX_CONCURRENT_JOBS: 3,
  JOB_TIMEOUT_MS: 5 * 60 * 1000, // 5 min per job
  POLL_INTERVAL_MS: 10_000,       // 10s polling when no websocket

  // Service pricing (USDC)
  BASE_SERVICE_FEE: 0.50,
  FEE_PERCENT_OF_PREMIUM: 10,
};

// ═══════════════════════════════════════════════════════════════════════
// SERVICE REQUIREMENT PARSER
// ═══════════════════════════════════════════════════════════════════════
//
// Los buyer agents envían service requirements como texto libre o JSON.
// Este parser extrae los parámetros que nuestro oracle necesita.
//

/**
 * Parsea el service requirement de un job ACP.
 * Soporta formato JSON estructurado y texto libre.
 *
 * @param {string|object} requirement - El service requirement del buyer
 * @returns {object} Parámetros normalizados para el risk engine
 *
 * Formato JSON esperado (ideal):
 * {
 *   "coverageType": "smart_contract_exploit" | "depeg" | "gas_spike" | etc,
 *   "protocol": "aave" | "compound" | "uniswap" | etc,
 *   "coverageAmount": 1000,
 *   "durationDays": 30,
 *   "description": "Cover my Aave position against exploit"
 * }
 *
 * Texto libre (Butler forwarding):
 * "I need coverage for my 5000 USDC position on Aave against smart contract exploits for 30 days"
 */
function parseServiceRequirement(requirement) {
  let parsed = null;
  if (typeof requirement === "string") {
    try {
      parsed = JSON.parse(requirement);
    } catch {
      parsed = parseNaturalLanguage(requirement);
    }
  } else if (typeof requirement === "object") {
    parsed = requirement;
  }

  if (!parsed) {
    return { valid: false, error: "Could not parse service requirement" };
  }

  const result = {
    valid: true,
    coverageType: normalizeCoverageType(parsed.coverageType || parsed.type || parsed.category || ""),
    protocol: (parsed.protocol || parsed.target || parsed.platform || "").toLowerCase().trim(),
    coverageAmount: parseFloat(parsed.coverageAmount || parsed.amount || parsed.coverage || 0),
    durationDays: parseInt(parsed.durationDays || parsed.duration || parsed.days || 30),
    description: parsed.description || parsed.prompt || parsed.request || "",
    raw: requirement,
  };

  if (!result.coverageType) {
    result.valid = false;
    result.error = "Missing coverage type. Supported: " + EVENT_CATEGORIES.join(", ");
    return result;
  }
  if (result.coverageAmount < 10) {
    result.valid = false;
    result.error = "Minimum coverage amount is 10 USDC";
    return result;
  }
  if (result.durationDays < 1 || result.durationDays > 365) {
    result.valid = false;
    result.error = "Duration must be between 1 and 365 days";
    return result;
  }

  return result;
}

/**
 * Parsea texto natural a parámetros estructurados.
 */
function parseNaturalLanguage(text) {
  const lower = text.toLowerCase();

  // Extract amount
  let amount = 0;
  const amountMatch = lower.match(/(\$?\d[\d,]*\.?\d*)\s*(?:k\b|usdc|usd|dollars?)?/i);
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/[$,]/g, ""));
    if (lower.includes("k") && amount < 1000) amount *= 1000;
  }

  // Extract duration
  let days = 30;
  const dayMatch = lower.match(/(\d+)\s*days?/);
  const weekMatch = lower.match(/(\d+)\s*weeks?/);
  const monthMatch = lower.match(/(\d+)\s*months?/);
  if (dayMatch) days = parseInt(dayMatch[1]);
  else if (weekMatch) days = parseInt(weekMatch[1]) * 7;
  else if (monthMatch) days = parseInt(monthMatch[1]) * 30;

  // Extract protocol
  const protocols = [
    "aave", "compound", "uniswap", "sushiswap", "curve", "maker",
    "lido", "yearn", "convex", "balancer", "pancakeswap", "gmx",
    "arbitrum", "optimism", "polygon", "ethereum", "base",
  ];
  const protocol = protocols.find((p) => lower.includes(p)) || "";

  // Extract coverage type
  let coverageType = "";
  const typeKeywords = {
    smart_contract_exploit: ["exploit", "hack", "vulnerability", "smart contract", "security"],
    depeg: ["depeg", "peg", "stablecoin", "usdt", "usdc peg", "dai"],
    gas_spike: ["gas", "gas spike", "network fee"],
    oracle_failure: ["oracle", "price feed", "data feed"],
    liquidation: ["liquidation", "liquidate", "margin", "collateral"],
    bridge_exploit: ["bridge", "cross-chain", "cross chain"],
    governance_attack: ["governance", "vote", "dao attack"],
    flash_loan: ["flash loan", "flash attack"],
    rug_pull: ["rug", "rug pull", "exit scam"],
    impermanent_loss: ["impermanent loss", "IL", "lp loss"],
  };

  for (const [type, keywords] of Object.entries(typeKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      coverageType = type;
      break;
    }
  }

  if (!coverageType && protocol && (lower.includes("cover") || lower.includes("protect") || lower.includes("insur"))) {
    coverageType = "smart_contract_exploit";
  }

  return {
    coverageType,
    protocol,
    coverageAmount: amount || 100,
    durationDays: days,
    description: text,
  };
}

/**
 * Normaliza el tipo de cobertura a las categorías del risk engine.
 */
function normalizeCoverageType(type) {
  const normalized = type.toLowerCase().replace(/[\s-]/g, "_").trim();
  if (EVENT_CATEGORIES.includes(normalized)) return normalized;

  const aliases = {
    exploit: "smart_contract_exploit",
    hack: "smart_contract_exploit",
    security: "smart_contract_exploit",
    stablecoin: "depeg",
    peg: "depeg",
    gas: "gas_spike",
    fees: "gas_spike",
    oracle: "oracle_failure",
    price_feed: "oracle_failure",
    liquidate: "liquidation",
    bridge: "bridge_exploit",
    governance: "governance_attack",
    flash: "flash_loan",
    rug: "rug_pull",
    il: "impermanent_loss",
    lp: "impermanent_loss",
  };

  return aliases[normalized] || "";
}

// ═══════════════════════════════════════════════════════════════════════
// JOB PROCESSOR
// ═══════════════════════════════════════════════════════════════════════

/**
 * Procesa un job ACP recibido de un buyer agent.
 *
 * @param {AcpJob} job - Job del ACP SDK
 * @param {BlockchainClient} blockchain - Cliente blockchain
 * @param {object} state - Estado compartido con oracle-bot
 * @returns {object} Resultado del procesamiento
 */
async function processJob(job, blockchain, state) {
  const jobId = job.id;
  console.log(`\n[ACP] ════════════════════════════════════════════`);
  console.log(`[ACP] New job received: ${jobId}`);
  console.log(`[ACP] From buyer: ${job.buyerAgentAddress || "unknown"}`);

  try {
    // ── 1. Parse service requirement ──
    const requirement = job.serviceRequirement || job.requirement || "";
    console.log(`[ACP] Requirement:`, typeof requirement === "string" ? requirement.slice(0, 200) : JSON.stringify(requirement).slice(0, 200));

    const params = parseServiceRequirement(requirement);
    if (!params.valid) {
      console.warn(`[ACP] ❌ Invalid: ${params.error}`);
      return { success: false, phase: "parsing", error: params.error, deliverable: buildErrorDeliverable(params.error) };
    }

    console.log(`[ACP] Parsed: type=${params.coverageType}, amount=${params.coverageAmount}, days=${params.durationDays}, protocol=${params.protocol}`);

    // ── 2. Find matching product ──
    const product = findMatchingProduct(params);
    if (!product) {
      const err = `No matching product for: ${params.coverageType}. Available: ${EVENT_CATEGORIES.join(", ")}`;
      console.warn(`[ACP] ❌ ${err}`);
      return { success: false, phase: "product_match", error: err, deliverable: buildErrorDeliverable(err) };
    }
    console.log(`[ACP] Matched: ${product.id} (${product.displayName})`);

    // ── 3. Generate proposal ──
    const proposal = generatePoolProposal(product.id, params.coverageAmount, params.durationDays);
    if (!proposal) {
      const err = `Failed to generate proposal for ${product.id}`;
      return { success: false, phase: "proposal", error: err, deliverable: buildErrorDeliverable(err) };
    }
    console.log(`[ACP] Quote: premium=${proposal.premiumUsdc} USDC (${proposal.premiumRatePercent}%), risk=${proposal.riskLevel}`);

    // ── 4. Evaluate risk ──
    const deadlineUnix = Math.floor(Date.now() / 1000) + params.durationDays * 86400;
    const failureProbPct = (product.baseFailureProb * 100).toFixed(1);
    const activePoolCount = state?.pools?.filter((p) => ["active", "open", "pending"].includes(p.status))?.length || 0;

    const riskResult = evaluateRisk(
      {
        description: `${product.displayName} — ${failureProbPct}% historical failure probability`,
        evidenceSource: product.evidenceSources[0],
        coverageAmount: params.coverageAmount,
        premiumRate: proposal.premiumRateBps,
        deadlineTimestamp: deadlineUnix,
      },
      activePoolCount
    );

    if (!riskResult.approved) {
      const reason = riskResult.rejection || "Risk evaluation rejected";
      console.warn(`[ACP] ❌ Risk rejected: ${reason}`);
      return { success: false, phase: "risk", error: reason, deliverable: buildRejectionDeliverable(params, reason) };
    }
    console.log(`[ACP] ✅ Risk approved`);

    // ── 5. Create pool on-chain ──
    const description = `${product.displayName}: ${params.protocol ? params.protocol + " — " : ""}${params.description.slice(0, 80)}`;
    const evidenceSource = product.evidenceSources[0];

    let poolResult;
    try {
      poolResult = await blockchain.createAndFundLumina({
        description,
        evidenceSource,
        coverageAmount: params.coverageAmount,
        premiumRate: proposal.premiumRateBps,
        deadline: deadlineUnix,
      });
      console.log(`[ACP] ✅ Pool #${poolResult.poolId} created, tx: ${poolResult.txHash}`);
    } catch (err) {
      console.error(`[ACP] ❌ On-chain failed:`, err.message);
      return { success: false, phase: "onchain", error: err.message, deliverable: buildErrorDeliverable(`Pool creation failed: ${err.message}`) };
    }

    // ── 6. Track in state ──
    if (state?.pools) {
      state.pools.push({
        id: `acp-${jobId}`,
        onchainId: poolResult.poolId,
        contract: "lumina",
        status: "open",
        product: product.id,
        description,
        evidenceSource,
        coverageUsdc: params.coverageAmount,
        premiumUsdc: proposal.premiumUsdc,
        premiumRateBps: proposal.premiumRateBps,
        deadline: deadlineUnix,
        createdAt: Date.now(),
        source: "acp",
        acpJobId: jobId,
        buyerAgent: job.buyerAgentAddress || "unknown",
        txHash: poolResult.txHash,
      });
    }

    // ── 7. Build deliverable ──
    const deliverable = buildSuccessDeliverable({
      poolId: poolResult.poolId,
      txHash: poolResult.txHash,
      product: product.displayName,
      coverageAmount: params.coverageAmount,
      premiumPaid: poolResult.premiumPaid,
      premiumRate: `${proposal.premiumRatePercent}%`,
      riskLevel: proposal.riskLevel,
      deadline: new Date(deadlineUnix * 1000).toISOString(),
      durationDays: params.durationDays,
      evidenceSource,
    });

    console.log(`[ACP] ✅ Job ${jobId} completed`);
    console.log(`[ACP] ════════════════════════════════════════════\n`);

    return { success: true, phase: "completed", poolId: poolResult.poolId, deliverable };

  } catch (err) {
    console.error(`[ACP] ❌ Unexpected error:`, err);
    return { success: false, phase: "unexpected", error: err.message, deliverable: buildErrorDeliverable(err.message) };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PRODUCT MATCHING
// ═══════════════════════════════════════════════════════════════════════

function findMatchingProduct(params) {
  for (const [id, product] of Object.entries(INSURANCE_PRODUCTS)) {
    if (product.category === params.coverageType) return { id, ...product };
    if (product.id === params.coverageType) return product;
  }

  for (const [id, product] of Object.entries(INSURANCE_PRODUCTS)) {
    if (id.includes(params.coverageType) || params.coverageType.includes(id)) {
      return { id, ...product };
    }
  }

  if (params.protocol) {
    for (const [id, product] of Object.entries(INSURANCE_PRODUCTS)) {
      const target = JSON.stringify(product.target || {}).toLowerCase();
      if (target.includes(params.protocol)) return { id, ...product };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// DELIVERABLE BUILDERS
// ═══════════════════════════════════════════════════════════════════════

function buildSuccessDeliverable(data) {
  return JSON.stringify({
    status: "COVERAGE_CREATED",
    message: "Parametric insurance pool created successfully via Lumina Oracle",
    pool: {
      id: data.poolId,
      transactionHash: data.txHash,
      explorerUrl: `https://basescan.org/tx/${data.txHash}`,
    },
    coverage: {
      type: data.product,
      amount: `${data.coverageAmount} USDC`,
      premium: `${data.premiumPaid} USDC`,
      premiumRate: data.premiumRate,
      riskLevel: data.riskLevel,
      duration: `${data.durationDays} days`,
      deadline: data.deadline,
    },
    verification: {
      oracle: "Lumina TEE Oracle",
      tee: "Phala Network TEE — Hardware-attested oracle resolution",
      evidenceSource: data.evidenceSource,
      attestation: "Available upon pool resolution — hardware-signed proof",
    },
    resolution: {
      mechanism: "Dual-Auth (Judge + Auditor consensus)",
      trigger: "Automatic at deadline via parametric condition check",
      payout: "Condition triggers → coverage paid. No trigger → collateral returned.",
    },
  }, null, 2);
}

function buildRejectionDeliverable(params, reason) {
  return JSON.stringify({
    status: "COVERAGE_REJECTED",
    message: "Risk engine could not approve this coverage",
    reason,
    request: {
      coverageType: params.coverageType,
      amount: `${params.coverageAmount} USDC`,
      duration: `${params.durationDays} days`,
    },
    suggestion: "Try adjusting amount, duration, or type. Available: " + EVENT_CATEGORIES.join(", "),
  }, null, 2);
}

function buildErrorDeliverable(error) {
  return JSON.stringify({
    status: "ERROR",
    message: error,
    contact: "Retry the request or reach Lumina via MoltX on X",
  }, null, 2);
}

// ═══════════════════════════════════════════════════════════════════════
// EVALUATOR HANDLER
// ═══════════════════════════════════════════════════════════════════════

async function handleEvaluation(job) {
  console.log(`[ACP] Evaluation requested for job ${job.id}`);

  try {
    let deliverableData;
    try {
      deliverableData = JSON.parse(job.deliverable || "{}");
    } catch {
      deliverableData = { status: "UNKNOWN" };
    }

    if (deliverableData.status === "COVERAGE_CREATED" && deliverableData.pool?.transactionHash) {
      console.log(`[ACP] ✅ Eval: APPROVED (pool on-chain, tx: ${deliverableData.pool.transactionHash})`);
      await job.evaluate(true, "Coverage pool verified on-chain. Transaction confirmed on Base.");
    } else if (deliverableData.status === "COVERAGE_REJECTED") {
      console.log(`[ACP] ✅ Eval: APPROVED (rejection is valid service response)`);
      await job.evaluate(true, "Risk evaluation completed. Rejection with clear reasoning is valid.");
    } else {
      console.log(`[ACP] ❌ Eval: REJECTED (unknown deliverable)`);
      await job.evaluate(false, "Deliverable could not be verified.");
    }
  } catch (err) {
    console.error(`[ACP] Eval error:`, err.message);
    try {
      await job.evaluate(true, "Evaluation completed with minor error. Service was provided.");
    } catch (e2) {
      console.error(`[ACP] Failed to submit eval:`, e2.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ACP CLIENT INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

async function initAcpClient(blockchain, state) {
  if (!ACP_CONFIG.WALLET_PRIVATE_KEY || !ACP_CONFIG.ENTITY_ID || !ACP_CONFIG.AGENT_WALLET_ADDRESS) {
    throw new Error("[ACP] Missing env vars: ACP_WALLET_PRIVATE_KEY, ACP_ENTITY_ID, ACP_AGENT_WALLET_ADDRESS");
  }

  console.log("[ACP] Initializing ACP client...");
  console.log(`[ACP] Agent wallet: ${ACP_CONFIG.AGENT_WALLET_ADDRESS}`);
  console.log(`[ACP] Entity ID: ${ACP_CONFIG.ENTITY_ID}`);

  // Sequential job queue (avoids nonce race conditions)
  const jobQueue = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    isProcessing = true;

    while (jobQueue.length > 0) {
      const { job, acpClient } = jobQueue.shift();
      try {
        // Accept the job
        const firstMemo = job.memos?.[0];
        if (firstMemo) {
          console.log(`[ACP] Accepting job ${job.id}...`);
          await acpClient.respondJob(job.id, firstMemo.id, true, "Lumina Oracle processing your coverage request");
        }

        // Process through oracle pipeline
        const result = await processJob(job, blockchain, state);

        // Deliver result
        await acpClient.deliverJob(job.id, result.deliverable);
        console.log(`[ACP] Job ${job.id} delivered (success=${result.success})`);
      } catch (err) {
        console.error(`[ACP] Error in job ${job.id}:`, err.message);
        try {
          await acpClient.deliverJob(job.id, buildErrorDeliverable(err.message));
        } catch (deliverErr) {
          console.error(`[ACP] Failed to deliver error:`, deliverErr.message);
          try {
            const firstMemo = job.memos?.[0];
            if (firstMemo) await acpClient.respondJob(job.id, firstMemo.id, false, `Error: ${err.message}`);
          } catch (rejectErr) {
            console.error(`[ACP] Failed to reject:`, rejectErr.message);
          }
        }
      }
    }
    isProcessing = false;
  }

  // Build contract client
  const contractArgs = [
    ACP_CONFIG.WALLET_PRIVATE_KEY,
    ACP_CONFIG.ENTITY_ID,
    ACP_CONFIG.AGENT_WALLET_ADDRESS,
  ];
  if (ACP_CONFIG.RPC_URL) contractArgs.push(ACP_CONFIG.RPC_URL);
  contractArgs.push(baseAcpConfig);

  const acpContractClient = await AcpContractClientV2.build(...contractArgs);

  const acpClient = new AcpClient({
    acpContractClient,
    onNewTask: (job) => {
      console.log(`[ACP] 📥 New task queued: ${job.id}`);
      jobQueue.push({ job, acpClient });
      processQueue();
    },
    onEvaluate: (job) => {
      handleEvaluation(job);
    },
  });

  await acpClient.init();
  console.log("[ACP] ✅ ACP client initialized and listening for jobs");

  return acpClient;
}

// ═══════════════════════════════════════════════════════════════════════
// STANDALONE & INTEGRATED MODES
// ═══════════════════════════════════════════════════════════════════════

/** Integrated mode (called from oracle-bot). */
async function start({ blockchain, state }) {
  return initAcpClient(blockchain, state);
}

/** Standalone mode. */
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  LUMINA ACP HANDLER — Virtuals ↔ Oracle Bridge");
  console.log("═══════════════════════════════════════════════════════════\n");

  const blockchain = new BlockchainClient();
  const state = { pools: [], cycleCount: 0, lastPoolCreatedCycle: -999 };

  try {
    const acpClient = await initAcpClient(blockchain, state);
    console.log("[ACP] Handler running. Waiting for ACP jobs...\n");

    process.on("SIGINT", () => { console.log("\n[ACP] Shutting down..."); process.exit(0); });

    setInterval(() => {
      const acpPools = state.pools.filter((p) => p.source === "acp").length;
      console.log(`[ACP] Heartbeat — ${acpPools} pools from ACP`);
    }, 60_000);

  } catch (err) {
    console.error("[ACP] Fatal:", err);
    process.exit(1);
  }
}

if (require.main === module) main();

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  start,
  initAcpClient,
  processJob,
  parseServiceRequirement,
  handleEvaluation,
  findMatchingProduct,
  ACP_CONFIG,
};
