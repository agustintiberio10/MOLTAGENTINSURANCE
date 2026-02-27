#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORACLE BOT — MutualPool V3 Lifecycle Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El bot oráculo es el único actor con permiso on-chain para:
 *   1. createPool()   — Crear pools (zero-funded, solo paga gas)
 *   2. resolvePool()  — Resolver pools con veredicto dual-auth
 *
 * TODO el ciclo de vida pasa por este script:
 *
 *   HEARTBEAT (cada 5 minutos):
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 1. CREAR POOLS                                              │
 *   │    → Evalúa riesgo (risk.js)                                │
 *   │    → createPoolV3() on-chain (gas only)                     │
 *   │    → Publica Phase 1 Molt (seek insured)                   │
 *   │                                                              │
 *   │ 2. MONITOREAR TRANSICIONES                                  │
 *   │    → Pending → Open (premium funded) → Phase 3 Molt         │
 *   │    → Open → Active (collateral filled)                      │
 *   │    → Deadline pasado + underfunded → cancelAndRefund         │
 *   │                                                              │
 *   │ 3. RESOLVER POOLS                                           │
 *   │    → Deadline alcanzado + Active → dual-auth oracle          │
 *   │    → resolvePoolV3(poolId, claimApproved)                   │
 *   │    → Publica Phase 4 Molt (resolution + withdraw)           │
 *   │    → Emergency resolve si deadline + 24h sin resolución     │
 *   │                                                              │
 *   │ 4. ENGAGEMENT SOCIAL (MoltX)                                │
 *   │    → Escanea feed global por oportunidades                  │
 *   │    → Genera pitches específicos por producto                │
 *   │    → Follow-back agentes interesados                        │
 *   │    → Responde mentions                                      │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * ESTADO: Persistido en agent/oracle-state.json
 *
 * USO:
 *   node agent/oracle-bot.js                    # Loop infinito (producción)
 *   node agent/oracle-bot.js --once             # Un solo ciclo (testing)
 *   node agent/oracle-bot.js --create gas_spike # Crear pool manualmente
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ── Modules internos ──
const BlockchainClient = require("./blockchain.js");
const MoltXClient = require("./moltx.js");
const { resolveWithDualAuth } = require("./oracle.js");
const { evaluateRisk, generatePoolProposal, EVENT_CATEGORIES } = require("./risk.js");
const {
  INSURANCE_PRODUCTS,
  detectOpportunities,
  generatePitch,
  getRandomProduct,
  getProduct,
} = require("./products.js");
const {
  buildPhase1Payload,
  buildPhase3Payload,
  buildPhase4Payload,
  generatePhase1Molt,
  generatePhase3Molt,
  generatePhase4Molt,
} = require("../specs/m2m-dual-ux-payloads.js");
const { generateResolutionMolt, generateOpportunityMolt } = require("./example-molts.js");

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Timing
  HEARTBEAT_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  EMERGENCY_RESOLVE_DELAY: 86400,         // 24 hours (matches contract)
  DEPOSIT_WINDOW_BUFFER: 7200,            // 2 hours (matches contract)

  // Pool creation limits
  MAX_ACTIVE_POOLS: 15,
  MAX_POOLS_PER_CYCLE: 1,
  MIN_CYCLES_BETWEEN_POOLS: 3,           // Wait 3 heartbeats between pool creations

  // MoltX engagement
  MAX_REPLIES_PER_CYCLE: 5,
  MAX_FOLLOWS_PER_CYCLE: 3,
  MAX_LIKES_PER_CYCLE: 10,

  // ── Rate-limit protection ──
  // Stagger RPC reads to avoid hammering the node. 200ms between calls
  // keeps us well under Alchemy/Infura free-tier limits (~300 req/s).
  // For public Base RPC (mainnet.base.org) this prevents 429 responses.
  RPC_STAGGER_MS: 200,

  // Cache getPoolV3() results for 60s within a heartbeat cycle.
  // Prevents redundant reads (monitorTransitions + checkCancellations
  // + resolveReadyPools can all read the same pool).
  RPC_CACHE_TTL_MS: 60_000,

  // State file
  STATE_FILE: path.join(__dirname, "oracle-state.json"),
};

// ═══════════════════════════════════════════════════════════════════════
// RPC READ CACHE — Reduces duplicate on-chain reads within a cycle.
//
// Problem: In a single heartbeat, monitorTransitions() reads pool X,
//          then checkCancellations() reads pool X again, then
//          resolveReadyPools() reads it a THIRD time.
//          With 15 active pools, that's 45+ RPC calls per cycle.
//
// Solution: Cache with TTL. Reads return cached data if fresh.
//           Write operations invalidate the relevant pool's cache.
// ═══════════════════════════════════════════════════════════════════════

const _rpcCache = new Map();

async function getPoolCached(blockchain, poolId) {
  const key = `pool_${poolId}`;
  const cached = _rpcCache.get(key);

  if (cached && Date.now() - cached.ts < CONFIG.RPC_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await blockchain.getPoolV3(poolId);
  _rpcCache.set(key, { data, ts: Date.now() });
  return data;
}

function invalidatePool(poolId) {
  _rpcCache.delete(`pool_${poolId}`);
}

function clearCache() {
  _rpcCache.clear();
}

/**
 * Small delay between sequential RPC reads.
 * Prevents bursting the RPC node and getting rate-limited.
 */
function stagger() {
  return new Promise((resolve) => setTimeout(resolve, CONFIG.RPC_STAGGER_MS));
}

// ── Pool status enum (matches Solidity) ──
const PoolStatus = {
  PENDING: 0,
  OPEN: 1,
  ACTIVE: 2,
  RESOLVED: 3,
  CANCELLED: 4,
};

const STATUS_LABELS = ["Pending", "Open", "Active", "Resolved", "Cancelled"];

// ═══════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[State] Failed to load state, starting fresh:", err.message);
  }

  return {
    pools: [],
    processedMoltIds: [],
    lastPoolCreatedCycle: -CONFIG.MIN_CYCLES_BETWEEN_POOLS,
    cycleCount: 0,
    lastHeartbeat: 0,
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("[State] Failed to save state:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

function initClients() {
  const requiredEnvVars = [
    "AGENT_PRIVATE_KEY",
    "BASE_RPC_URL",
    "USDC_ADDRESS",
    "V3_CONTRACT_ADDRESS",
    "ROUTER_ADDRESS",
    "MOLTX_API_KEY",
  ];

  for (const key of requiredEnvVars) {
    if (!process.env[key]) {
      console.error(`[Init] Missing required env var: ${key}`);
      console.error("[Init] Copy .env.example to .env and fill in your values.");
      process.exit(1);
    }
  }

  const blockchain = new BlockchainClient({
    rpcUrl: process.env.BASE_RPC_URL,
    privateKey: process.env.AGENT_PRIVATE_KEY,
    usdcAddress: process.env.USDC_ADDRESS,
    v3Address: process.env.V3_CONTRACT_ADDRESS,
    routerAddress: process.env.ROUTER_ADDRESS,
  });

  const moltx = new MoltXClient(process.env.MOLTX_API_KEY);

  console.log("[Init] Oracle address:", blockchain.agentAddress);
  console.log("[Init] V3 Contract:", process.env.V3_CONTRACT_ADDRESS);
  console.log("[Init] Router:", process.env.ROUTER_ADDRESS);
  console.log("[Init] RPC:", process.env.BASE_RPC_URL);

  // ── Rate-limit warnings ──
  const rpcUrl = process.env.BASE_RPC_URL || "";
  if (rpcUrl.includes("mainnet.base.org")) {
    console.warn("[Init] WARNING: Using public Base RPC — rate limits apply.");
    console.warn("[Init] For production, use Alchemy/Infura with a paid API key:");
    console.warn("[Init]   BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY");
    console.warn("[Init]   BASE_RPC_URL=https://base-mainnet.infura.io/v3/YOUR_KEY");
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    console.warn("[Init] WARNING: No ETHERSCAN_API_KEY set.");
    console.warn("[Init] Gas oracle (oracle.js) will hit free-tier limits.");
    console.warn("[Init] Get a key: https://etherscan.io/myapikey");
  }

  return { blockchain, moltx };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: POOL CREATION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Decide si crear un pool nuevo y ejecutar la creación on-chain.
 *
 * Flujo:
 *   1. Cuenta pools activos (Pending + Open + Active)
 *   2. Si hay capacidad → selecciona producto aleatorio
 *   3. Evalúa riesgo → genera propuesta
 *   4. createPoolV3() on-chain (gas only, zero-funded)
 *   5. Publica Phase 1 MoltX post con M2M payload
 *   6. Guarda en state
 */
async function maybeCreatePool(blockchain, moltx, state) {
  // Guard: respect rate limit between creations
  if (state.cycleCount - state.lastPoolCreatedCycle < CONFIG.MIN_CYCLES_BETWEEN_POOLS) {
    console.log("[Create] Cooldown active, skipping pool creation.");
    return;
  }

  // Guard: count active pools
  const activePools = state.pools.filter((p) =>
    [PoolStatus.PENDING, PoolStatus.OPEN, PoolStatus.ACTIVE].includes(p.status)
  );
  if (activePools.length >= CONFIG.MAX_ACTIVE_POOLS) {
    console.log(`[Create] ${activePools.length}/${CONFIG.MAX_ACTIVE_POOLS} active pools. Skipping.`);
    return;
  }

  // Select a random product
  const product = getRandomProduct();
  console.log(`[Create] Selected product: ${product.id} (${product.displayName})`);

  // Generate pool parameters
  const coverageRange = product.suggestedCoverageRange;
  const deadlineRange = product.suggestedDeadlineDays;
  const coverageUsdc = coverageRange[0] + Math.floor(Math.random() * (coverageRange[1] - coverageRange[0]));
  const deadlineDays = deadlineRange[0] + Math.floor(Math.random() * (deadlineRange[1] - deadlineRange[0]));
  const deadlineUnix = Math.floor(Date.now() / 1000) + deadlineDays * 86400;

  // Generate proposal and evaluate risk
  const proposal = generatePoolProposal(product.id, coverageUsdc, deadlineDays);
  if (!proposal) {
    console.warn("[Create] Failed to generate proposal for", product.id);
    return;
  }

  const riskResult = evaluateRisk(
    {
      description: product.displayName,
      evidenceSource: product.evidenceSources[0],
      coverageAmount: coverageUsdc,
      premiumRate: proposal.premiumRateBps,
      deadlineTimestamp: deadlineUnix,
    },
    activePools.length
  );

  if (!riskResult.approved) {
    const isSemanticReject = riskResult.reason.includes("[SEMANTIC GATE");
    if (isSemanticReject) {
      console.error(`[Create] ⛔ SEMANTIC GATE REJECTION — Pool NOT created (zero gas spent)`);
      console.error(`[Create]   Product: ${product.id} | ${product.displayName}`);
      console.error(`[Create]   Evidence: ${product.evidenceSources[0]}`);
      console.error(`[Create]   Reason: ${riskResult.reason}`);
    } else {
      console.warn(`[Create] Risk rejected: ${riskResult.reason}`);
    }
    return;
  }

  console.log(`[Create] Risk approved: ${riskResult.reason}`);

  // Build description
  const description = `${product.displayName}: ${product.target.description.slice(0, 100)}`;
  const evidenceSource = product.evidenceSources[0];
  const premiumUsdc = parseFloat(proposal.premiumUsdc);
  const premiumRateBps = proposal.premiumRateBps;

  // ── ON-CHAIN: createPoolV3() ──
  let poolId, txHash;
  try {
    const result = await blockchain.createPoolV3({
      description,
      evidenceSource,
      coverageAmount: coverageUsdc,
      premiumRate: premiumRateBps,
      deadline: deadlineUnix,
    });
    poolId = result.poolId;
    txHash = result.txHash;
    console.log(`[Create] Pool #${poolId} created on-chain, tx: ${txHash}`);
  } catch (err) {
    console.error("[Create] On-chain createPool failed:", err.message);
    return;
  }

  // ── MOLTX: Publish Phase 1 Post ──
  let phase1MoltId = null;
  try {
    const moltContent = generatePhase1Molt({
      poolId,
      productId: product.id,
      description,
      coverageUsdc,
      premiumUsdc,
      premiumRateBps,
      deadlineUnix,
      evidenceSource,
      eventProbability: product.baseFailureProb,
    });

    // MoltX posts have a 500 char limit — use article for full payload
    const articleResult = await moltx.postArticle(
      moltContent,
      `Pool #${poolId} — ${product.displayName}`
    );
    phase1MoltId = articleResult?.data?.id || articleResult?.id || null;

    // Also post a short summary molt with link
    const shortMolt =
      `POOL #${poolId} CREATED — ${product.name.toUpperCase()}\n\n` +
      `Coverage: ${coverageUsdc} USDC | Premium: ${premiumUsdc} USDC\n` +
      `Deadline: ${new Date(deadlineUnix * 1000).toISOString().slice(0, 10)}\n` +
      `Evidence: ${evidenceSource}\n\n` +
      `Pay premium to become insured:\n` +
      `https://mutualpool.finance/pool/${poolId}?action=fund_premium\n\n` +
      `#MutualPool #insurance #${product.id}`;

    await moltx.postMolt(shortMolt.slice(0, 500));
    console.log(`[Create] Phase 1 published on MoltX (article: ${phase1MoltId})`);
  } catch (err) {
    console.error("[Create] MoltX publish failed:", err.message);
  }

  // ── Save to state ──
  state.pools.push({
    onchainId: poolId,
    productId: product.id,
    description,
    evidenceSource,
    coverageAmount: coverageUsdc,
    premiumUsdc,
    premiumRateBps,
    deadline: deadlineUnix,
    depositDeadline: deadlineUnix - CONFIG.DEPOSIT_WINDOW_BUFFER,
    eventProbability: product.baseFailureProb,
    status: PoolStatus.PENDING,
    createdAt: Math.floor(Date.now() / 1000),
    txHash,
    phase1MoltId,
    phase3MoltId: null,
    phase4MoltId: null,
  });

  state.lastPoolCreatedCycle = state.cycleCount;
  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: MONITOR POOL TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Lee el estado on-chain de cada pool tracked y detecta transiciones.
 *
 * Transiciones manejadas:
 *   Pending(0) → Open(1):     Premium fue pagado → publicar Phase 3
 *   Open(1) → Active(2):      Colateral completo → log
 *   Open/Pending → cancelled:  Underfunded + past deadline → cancelar
 */
async function monitorTransitions(blockchain, moltx, state) {
  const trackablePools = state.pools.filter((p) =>
    [PoolStatus.PENDING, PoolStatus.OPEN, PoolStatus.ACTIVE].includes(p.status)
  );

  for (const pool of trackablePools) {
    try {
      const onchainData = await getPoolCached(blockchain, pool.onchainId);
      const prevStatus = pool.status;
      const newStatus = onchainData.status;

      if (prevStatus === newStatus) {
        await stagger();
        continue;
      }

      console.log(
        `[Monitor] Pool #${pool.onchainId}: ${STATUS_LABELS[prevStatus]} → ${STATUS_LABELS[newStatus]}`
      );

      pool.status = newStatus;
      invalidatePool(pool.onchainId); // Status changed, invalidate cache

      // ── Pending → Open: Premium was funded ──
      if (prevStatus === PoolStatus.PENDING && newStatus === PoolStatus.OPEN) {
        console.log(`[Monitor] Pool #${pool.onchainId} premium funded by ${onchainData.insured}`);
        await publishPhase3(blockchain, moltx, pool, onchainData);
      }

      // ── Open → Active: Collateral filled ──
      if (prevStatus === PoolStatus.OPEN && newStatus === PoolStatus.ACTIVE) {
        console.log(
          `[Monitor] Pool #${pool.onchainId} fully funded: ${onchainData.totalCollateral} USDC`
        );
      }

      // ── Already resolved or cancelled on-chain ──
      if (newStatus === PoolStatus.RESOLVED || newStatus === PoolStatus.CANCELLED) {
        console.log(`[Monitor] Pool #${pool.onchainId} already ${STATUS_LABELS[newStatus]} on-chain.`);
      }

      saveState(state);
    } catch (err) {
      console.error(`[Monitor] Error reading pool #${pool.onchainId}:`, err.message);
    }
    await stagger(); // Rate-limit protection between reads
  }

  // ── Check for underfunded pools past deposit deadline → cancel ──
  await checkCancellations(blockchain, state);
}

/**
 * Publica Phase 3 MoltX post cuando un pool pasa a Open.
 */
async function publishPhase3(blockchain, moltx, pool, onchainData) {
  try {
    // Try to get MPOOLV3/USDC rate for option_b
    let mpoolToUsdcRate = null;
    try {
      const quote = await blockchain.quoteMpoolToUsdc("1");
      mpoolToUsdcRate = parseFloat(quote);
    } catch {
      // Rate not available — option_b_mpoolv3 will be omitted
    }

    const moltContent = generatePhase3Molt({
      poolId: pool.onchainId,
      productId: pool.productId,
      description: pool.description,
      coverageUsdc: pool.coverageAmount,
      premiumUsdc: pool.premiumUsdc,
      premiumRateBps: pool.premiumRateBps,
      deadlineUnix: pool.deadline,
      evidenceSource: pool.evidenceSource,
      eventProbability: pool.eventProbability,
      suggestedCollateralUsdc: Math.min(pool.coverageAmount, 100),
      currentCollateralUsdc: parseFloat(onchainData.totalCollateral),
      expectedProviderCount: 3,
      mpoolToUsdcRate,
    });

    // Publish as article (full payload exceeds 500 chars)
    const articleResult = await moltx.postArticle(
      moltContent,
      `Liquidity Needed — Pool #${pool.onchainId}`
    );
    pool.phase3MoltId = articleResult?.data?.id || articleResult?.id || null;

    // Short post for feed visibility
    const remaining = pool.coverageAmount - parseFloat(onchainData.totalCollateral);
    const shortMolt =
      `LIQUIDITY NEEDED — POOL #${pool.onchainId}\n\n` +
      `${pool.description.slice(0, 100)}\n\n` +
      `Coverage: ${pool.coverageAmount} USDC | Need: ${remaining.toFixed(0)} USDC more\n` +
      `Premium: ${pool.premiumUsdc} USDC (${(pool.premiumRateBps / 100).toFixed(1)}% rate)\n\n` +
      `Provide collateral:\n` +
      `https://mutualpool.finance/pool/${pool.onchainId}?action=provide_collateral\n\n` +
      `#MutualPool #liquidity #${pool.productId}`;

    await moltx.postMolt(shortMolt.slice(0, 500));
    console.log(`[Phase3] Published for pool #${pool.onchainId}`);
  } catch (err) {
    console.error(`[Phase3] MoltX publish failed for pool #${pool.onchainId}:`, err.message);
  }
}

/**
 * Cancela pools underfunded cuyo deposit deadline expiró.
 */
async function checkCancellations(blockchain, state) {
  const now = Math.floor(Date.now() / 1000);

  const cancellable = state.pools.filter(
    (p) =>
      (p.status === PoolStatus.PENDING || p.status === PoolStatus.OPEN) &&
      now > p.depositDeadline
  );

  for (const pool of cancellable) {
    try {
      const onchainData = await getPoolCached(blockchain, pool.onchainId);

      // Only cancel if underfunded (totalCollateral < coverageAmount)
      if (parseFloat(onchainData.totalCollateral) < parseFloat(onchainData.coverageAmount)) {
        console.log(`[Cancel] Pool #${pool.onchainId} underfunded past deposit deadline. Cancelling...`);

        const txHash = await blockchain.cancelAndRefundV3(pool.onchainId);
        pool.status = PoolStatus.CANCELLED;
        invalidatePool(pool.onchainId);
        console.log(`[Cancel] Pool #${pool.onchainId} cancelled, tx: ${txHash}`);

        saveState(state);
      }
    } catch (err) {
      // May fail if pool is already cancelled/resolved or not in a cancellable state
      if (!err.message.includes("V3:")) {
        console.error(`[Cancel] Error cancelling pool #${pool.onchainId}:`, err.message);
      }
    }
    await stagger();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: RESOLVE POOLS (DUAL-AUTH ORACLE)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Resuelve pools cuyo deadline pasó usando el oráculo dual-auth.
 *
 * Flujo:
 *   1. Filtra pools Active con deadline pasado
 *   2. Llama resolveWithDualAuth(pool) del oracle.js
 *      → Fetch gas data (Etherscan API + RPC fallback)
 *      → Fetch evidence from URL
 *      → Sanitize evidence (anti-injection)
 *      → Judge analysis (primary)
 *      → Auditor analysis (secondary, independent)
 *      → Dual-auth gate: both must agree for TRUE
 *   3. resolvePoolV3(poolId, claimApproved) on-chain
 *   4. Publica Phase 4 MoltX post con resultado + withdraw payload
 */
async function resolveReadyPools(blockchain, moltx, state) {
  const now = Math.floor(Date.now() / 1000);

  const readyToResolve = state.pools.filter(
    (p) => p.status === PoolStatus.ACTIVE && now >= p.deadline
  );

  for (const pool of readyToResolve) {
    console.log(`\n[Resolve] ═══ Pool #${pool.onchainId} ═══`);
    console.log(`[Resolve] Product: ${pool.productId}`);
    console.log(`[Resolve] Evidence: ${pool.evidenceSource}`);

    try {
      // ── Step 1: Dual-auth oracle ──
      const oracleResult = await resolveWithDualAuth({
        ...pool,
        onchainId: pool.onchainId,
      });

      if (!oracleResult.shouldResolve) {
        console.log(`[Resolve] Oracle says not ready: ${oracleResult.evidence}`);
        continue;
      }

      const { claimApproved, evidence, dualAuth } = oracleResult;
      console.log(`[Resolve] Oracle verdict: claimApproved=${claimApproved}`);
      console.log(`[Resolve] Evidence: ${evidence.slice(0, 200)}...`);

      // ── Step 2: On-chain resolution ──
      const txHash = await blockchain.resolvePoolV3(pool.onchainId, claimApproved);
      pool.status = PoolStatus.RESOLVED;
      pool.resolutionTxHash = txHash;
      pool.dualAuthResult = dualAuth;
      pool.claimApproved = claimApproved;
      invalidatePool(pool.onchainId);

      console.log(`[Resolve] Pool #${pool.onchainId} resolved on-chain, tx: ${txHash}`);

      // ── Step 3: Get accounting data ──
      let accounting = null;
      try {
        const onchainData = await blockchain.getPoolV3(pool.onchainId);
        const acctData = await blockchain.v3.getPoolAccounting(pool.onchainId);
        accounting = {
          totalCollateral: parseFloat(require("ethers").formatUnits(acctData.totalCollateral, 6)),
          premiumAfterFee: parseFloat(require("ethers").formatUnits(acctData.premiumAfterFee, 6)),
          protocolFee: parseFloat(require("ethers").formatUnits(acctData.protocolFee, 6)),
          providerCount: onchainData.participantCount,
        };
      } catch (err) {
        console.warn("[Resolve] Failed to fetch accounting:", err.message);
      }

      // ── Step 4: Publish Phase 4 MoltX post ──
      await publishPhase4(moltx, pool, claimApproved, dualAuth, accounting);

      saveState(state);
    } catch (err) {
      console.error(`[Resolve] Failed to resolve pool #${pool.onchainId}:`, err.message);
    }
  }

  // ── Emergency resolution: Active pools past deadline + 24h ──
  await checkEmergencyResolutions(blockchain, moltx, state);
}

/**
 * Publica Phase 4 MoltX post (resolution + withdraw).
 */
async function publishPhase4(moltx, pool, claimApproved, dualAuth, accounting) {
  try {
    const moltContent = generatePhase4Molt({
      poolId: pool.onchainId,
      claimApproved,
      oracleResult: dualAuth,
      accounting,
    });

    const articleResult = await moltx.postArticle(
      moltContent,
      `Pool #${pool.onchainId} Resolved — ${claimApproved ? "Claim Approved" : "No Claim"}`
    );
    pool.phase4MoltId = articleResult?.data?.id || articleResult?.id || null;

    // Short post
    const verdict = claimApproved ? "CLAIM APPROVED" : "NO CLAIM — PROVIDERS WIN";
    const shortMolt =
      `POOL #${pool.onchainId} RESOLVED: ${verdict}\n\n` +
      `Judge: ${dualAuth?.judge?.verdict ? "INCIDENT" : "NO INCIDENT"}\n` +
      `Auditor: ${dualAuth?.auditor?.verdict ? "INCIDENT" : "NO INCIDENT"}\n` +
      `Consensus: ${dualAuth?.consensus ? "YES" : "NO"}\n\n` +
      `Withdraw your funds:\n` +
      `https://mutualpool.finance/pool/${pool.onchainId}?action=withdraw\n\n` +
      `#MutualPool #resolved`;

    await moltx.postMolt(shortMolt.slice(0, 500));
    console.log(`[Phase4] Published for pool #${pool.onchainId}`);
  } catch (err) {
    console.error(`[Phase4] MoltX publish failed for pool #${pool.onchainId}:`, err.message);
  }
}

/**
 * Emergency resolve: cualquiera puede llamar después de deadline + 24h.
 * El oracle bot lo hace preventivamente para no dejar pools colgados.
 * Emergency siempre resuelve con claimApproved = false.
 */
async function checkEmergencyResolutions(blockchain, moltx, state) {
  const now = Math.floor(Date.now() / 1000);

  const emergencyPools = state.pools.filter(
    (p) =>
      p.status === PoolStatus.ACTIVE &&
      now >= p.deadline + CONFIG.EMERGENCY_RESOLVE_DELAY
  );

  for (const pool of emergencyPools) {
    console.log(`[Emergency] Pool #${pool.onchainId} past deadline + 24h. Triggering emergency resolve.`);

    try {
      const txHash = await blockchain.emergencyResolveV3(pool.onchainId);
      pool.status = PoolStatus.RESOLVED;
      pool.claimApproved = false;
      pool.resolutionTxHash = txHash;
      pool.emergencyResolved = true;

      console.log(`[Emergency] Pool #${pool.onchainId} emergency resolved, tx: ${txHash}`);

      // Publish notification
      const shortMolt =
        `POOL #${pool.onchainId} — EMERGENCY RESOLVED\n\n` +
        `Oracle no respondió en 24h. Se activó emergencyResolve().\n` +
        `Resultado: claimApproved = false (default seguridad)\n\n` +
        `Withdraw: https://mutualpool.finance/pool/${pool.onchainId}?action=withdraw\n\n` +
        `#MutualPool #emergency`;

      await moltx.postMolt(shortMolt.slice(0, 500));

      saveState(state);
    } catch (err) {
      console.error(`[Emergency] Failed for pool #${pool.onchainId}:`, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4: SOCIAL ENGAGEMENT (MoltX)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Escanea el feed global de MoltX buscando oportunidades de venta.
 * Usa detectOpportunities() para matching por keywords de producto.
 * Responde con pitches personalizados y pools activos.
 */
async function engageFeed(blockchain, moltx, state) {
  try {
    const feed = await moltx.getGlobalFeed("new", 30);
    const posts = feed?.data || feed?.posts || feed || [];

    if (!Array.isArray(posts) || posts.length === 0) {
      console.log("[Social] Feed empty or unavailable.");
      return;
    }

    let repliesThisCycle = 0;
    let likesThisCycle = 0;

    for (const post of posts) {
      if (repliesThisCycle >= CONFIG.MAX_REPLIES_PER_CYCLE) break;

      const postId = post.id || post._id;
      const content = post.content || post.text || "";
      const authorName = post.author?.name || post.agent_name || "";

      // Skip our own posts
      if (authorName === "mutual-insurance" || authorName === "MutualPool_Bot") continue;

      // Skip already processed posts
      if (state.processedMoltIds.includes(postId)) continue;

      // Detect opportunities
      const opportunities = detectOpportunities(content);

      if (opportunities.length > 0) {
        const topOpp = opportunities[0];
        console.log(
          `[Social] Opportunity: ${topOpp.product.id} (score: ${topOpp.matchScore}) in post by @${authorName}`
        );

        // Find an active pool matching this product
        const matchingPool = state.pools.find(
          (p) =>
            p.productId === topOpp.product.id &&
            [PoolStatus.PENDING, PoolStatus.OPEN].includes(p.status)
        );

        try {
          let replyContent;

          if (matchingPool) {
            // Direct pool reference
            replyContent =
              `@${authorName} Tengo un pool activo que cubre exactamente esto:\n\n` +
              `Pool #${matchingPool.onchainId} — ${topOpp.product.displayName}\n` +
              `Coverage: ${matchingPool.coverageAmount} USDC\n` +
              `P(evento): ${(topOpp.product.baseFailureProb * 100).toFixed(0)}%\n\n` +
              `https://mutualpool.finance/pool/${matchingPool.onchainId}\n` +
              `#MutualPool`;
          } else {
            // Generic pitch
            const pitch = generatePitch(topOpp.product.id, {
              coverageAmount: topOpp.product.suggestedCoverageRange[0],
              contractAddress: process.env.V3_CONTRACT_ADDRESS,
            });
            replyContent = `@${authorName} ${pitch}`.slice(0, 500);
          }

          await moltx.replyToMolt(postId, replyContent.slice(0, 500));
          repliesThisCycle++;
          console.log(`[Social] Replied to @${authorName} (${topOpp.product.id})`);
        } catch (err) {
          console.warn(`[Social] Reply failed:`, err.message);
        }
      }

      // Like relevant posts
      if (likesThisCycle < CONFIG.MAX_LIKES_PER_CYCLE) {
        const isRelevant =
          content.toLowerCase().includes("insurance") ||
          content.toLowerCase().includes("defi") ||
          content.toLowerCase().includes("risk") ||
          content.toLowerCase().includes("coverage") ||
          opportunities.length > 0;

        if (isRelevant) {
          try {
            await moltx.likeMolt(postId);
            likesThisCycle++;
          } catch {
            // Ignore like failures
          }
        }
      }

      state.processedMoltIds.push(postId);
    }

    // Trim processed IDs (keep last 500)
    if (state.processedMoltIds.length > 500) {
      state.processedMoltIds = state.processedMoltIds.slice(-500);
    }

    console.log(`[Social] Cycle: ${repliesThisCycle} replies, ${likesThisCycle} likes`);
  } catch (err) {
    console.error("[Social] Feed engagement failed:", err.message);
  }
}

/**
 * Responde a mentions directos.
 */
async function respondToMentions(moltx, state) {
  try {
    const mentions = await moltx.getMentionsFeed(20);
    const posts = mentions?.data || mentions?.posts || mentions || [];

    if (!Array.isArray(posts)) return;

    for (const post of posts) {
      const postId = post.id || post._id;
      if (state.processedMoltIds.includes(postId)) continue;

      const content = (post.content || post.text || "").toLowerCase();
      const authorName = post.author?.name || post.agent_name || "";

      // Detect intent
      let reply = null;

      if (content.includes("pool") && (content.includes("status") || content.includes("estado"))) {
        // Pool status query
        const poolMatch = content.match(/pool\s*#?(\d+)/i);
        if (poolMatch) {
          const qPoolId = parseInt(poolMatch[1]);
          const tracked = state.pools.find((p) => p.onchainId === qPoolId);
          if (tracked) {
            reply =
              `@${authorName} Pool #${qPoolId}: ${STATUS_LABELS[tracked.status]}\n` +
              `Coverage: ${tracked.coverageAmount} USDC\n` +
              `Deadline: ${new Date(tracked.deadline * 1000).toISOString().slice(0, 10)}\n\n` +
              `https://mutualpool.finance/pool/${qPoolId}`;
          }
        }
      } else if (content.includes("products") || content.includes("productos") || content.includes("catalog")) {
        // Product catalog
        reply =
          `@${authorName} 10 productos de cobertura:\n\n` +
          Object.values(INSURANCE_PRODUCTS)
            .map((p) => `${p.icon} ${p.name}`)
            .join("\n") +
          `\n\nTodos verificables on-chain con oráculo dual-auth.`;
      } else if (content.includes("help") || content.includes("ayuda")) {
        reply =
          `@${authorName} Soy el oráculo de MutualPool V3.\n\n` +
          `Creo pools de seguros para agentes AI en Base.\n` +
          `Preguntame sobre pools activos, productos, o EV.\n\n` +
          `dApp: https://mutualpool.finance`;
      }

      if (reply) {
        try {
          await moltx.replyToMolt(postId, reply.slice(0, 500));
          console.log(`[Mentions] Replied to @${authorName}`);
        } catch (err) {
          console.warn(`[Mentions] Reply failed:`, err.message);
        }
      }

      state.processedMoltIds.push(postId);
    }
  } catch (err) {
    console.error("[Mentions] Failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC: Recover pools from on-chain (startup)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Al inicio, sincroniza el state local con lo que hay on-chain.
 * Recorre nextPoolId y agrega pools que el state no tiene.
 */
async function syncFromChain(blockchain, state) {
  try {
    const nextId = await blockchain.getNextPoolIdV3();
    console.log(`[Sync] On-chain nextPoolId: ${nextId}`);

    const trackedIds = new Set(state.pools.map((p) => p.onchainId));

    for (let i = 0; i < nextId; i++) {
      if (trackedIds.has(i)) {
        // Update status of existing tracked pools
        try {
          const onchainData = await blockchain.getPoolV3(i);
          const pool = state.pools.find((p) => p.onchainId === i);
          if (pool && pool.status !== onchainData.status) {
            console.log(
              `[Sync] Pool #${i}: ${STATUS_LABELS[pool.status]} → ${STATUS_LABELS[onchainData.status]}`
            );
            pool.status = onchainData.status;
          }
        } catch {
          // Skip read errors
        }
        await stagger();
        continue;
      }

      // Recover untracked pool
      try {
        const data = await blockchain.getPoolV3(i);
        console.log(
          `[Sync] Recovered pool #${i}: ${STATUS_LABELS[data.status]} — "${data.description.slice(0, 50)}..."`
        );

        state.pools.push({
          onchainId: i,
          productId: "unknown",
          description: data.description,
          evidenceSource: data.evidenceSource,
          coverageAmount: parseFloat(data.coverageAmount),
          premiumUsdc: parseFloat(data.premiumPaid),
          premiumRateBps: data.premiumRate,
          deadline: data.deadline,
          depositDeadline: data.depositDeadline,
          eventProbability: 0.1,
          status: data.status,
          createdAt: 0,
          txHash: null,
          phase1MoltId: null,
          phase3MoltId: null,
          phase4MoltId: null,
        });
      } catch (err) {
        console.warn(`[Sync] Failed to read pool #${i}:`, err.message);
      }
      await stagger();
    }

    saveState(state);
    console.log(`[Sync] State synced. Tracking ${state.pools.length} pools.`);
  } catch (err) {
    console.error("[Sync] Chain sync failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WALLET LINKING (one-time setup)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Linkea la wallet del oráculo a MoltX vía EIP-712.
 * Solo necesita ejecutarse una vez.
 */
async function ensureWalletLinked(blockchain, moltx) {
  try {
    const me = await moltx.getMe();
    const wallets = me?.data?.wallets || me?.wallets || [];
    const oracleAddr = blockchain.agentAddress.toLowerCase();

    const alreadyLinked = wallets.some(
      (w) => (w.address || "").toLowerCase() === oracleAddr
    );

    if (alreadyLinked) {
      console.log("[Init] Wallet already linked to MoltX.");
      return;
    }

    console.log("[Init] Linking wallet to MoltX...");
    await moltx.linkWallet(blockchain.wallet, 8453);
    console.log("[Init] Wallet linked successfully.");
  } catch (err) {
    console.warn("[Init] Wallet linking failed (may already be linked):", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN HEARTBEAT
// ═══════════════════════════════════════════════════════════════════════

async function heartbeat(blockchain, moltx, state) {
  state.cycleCount++;
  state.lastHeartbeat = Math.floor(Date.now() / 1000);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`HEARTBEAT #${state.cycleCount} — ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  // Fresh cache each cycle — stale data from last heartbeat is discarded
  clearCache();

  // ── Step 1: Monitor pool transitions ──
  console.log("\n[1/4] Monitoring pool transitions...");
  await monitorTransitions(blockchain, moltx, state);

  // ── Step 2: Resolve ready pools ──
  console.log("\n[2/4] Checking pools for resolution...");
  await resolveReadyPools(blockchain, moltx, state);

  // ── Step 3: Maybe create a new pool ──
  console.log("\n[3/4] Pool creation check...");
  await maybeCreatePool(blockchain, moltx, state);

  // ── Step 4: Social engagement ──
  console.log("\n[4/4] Social engagement...");
  await engageFeed(blockchain, moltx, state);
  await respondToMentions(moltx, state);

  // ── Summary ──
  const pending = state.pools.filter((p) => p.status === PoolStatus.PENDING).length;
  const open = state.pools.filter((p) => p.status === PoolStatus.OPEN).length;
  const active = state.pools.filter((p) => p.status === PoolStatus.ACTIVE).length;
  const resolved = state.pools.filter((p) => p.status === PoolStatus.RESOLVED).length;

  console.log(
    `\n[Summary] Pending: ${pending} | Open: ${open} | Active: ${active} | Resolved: ${resolved}`
  );

  saveState(state);
}

// ═══════════════════════════════════════════════════════════════════════
// CLI: MANUAL POOL CREATION
// ═══════════════════════════════════════════════════════════════════════

async function manualCreatePool(blockchain, moltx, state, productId) {
  const product = getProduct(productId);
  if (!product) {
    console.error(`[Manual] Unknown product: ${productId}`);
    console.error(`Available: ${Object.keys(INSURANCE_PRODUCTS).join(", ")}`);
    process.exit(1);
  }

  console.log(`[Manual] Creating pool for product: ${product.displayName}`);

  // Force creation by temporarily resetting cooldown
  const savedCycle = state.lastPoolCreatedCycle;
  state.lastPoolCreatedCycle = -CONFIG.MIN_CYCLES_BETWEEN_POOLS;
  state.cycleCount = CONFIG.MIN_CYCLES_BETWEEN_POOLS;

  // Override getRandomProduct to return the requested product
  const origRandom = getRandomProduct;
  require("./products.js").getRandomProduct = () => product;

  await maybeCreatePool(blockchain, moltx, state);

  // Restore
  require("./products.js").getRandomProduct = origRandom;

  saveState(state);
  console.log("[Manual] Done.");
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTED API — For Railway orchestrator (start-railway.js)
// ═══════════════════════════════════════════════════════════════════════

let _oracleClients = null;
let _oracleState = null;

/**
 * Initialize oracle bot: clients + verify role + link wallet + sync from chain.
 * Call once at startup. Returns { blockchain, moltx, state }.
 */
async function initOracleBot() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  ORACLE BOT — MutualPool V3 Lifecycle Engine");
  console.log("  Chain: Base Mainnet (8453)");
  console.log("  Oracle: Dual-Auth (Judge + Auditor)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const { blockchain, moltx } = initClients();
  const state = loadState();

  // ── Verify oracle role ──
  try {
    const onchainOracle = await blockchain.v3.oracle();
    const isOracle = onchainOracle.toLowerCase() === blockchain.agentAddress.toLowerCase();
    console.log(`[Init] On-chain oracle: ${onchainOracle}`);
    console.log(`[Init] This wallet is oracle: ${isOracle ? "YES" : "NO"}`);

    if (!isOracle) {
      console.warn("[Init] WARNING: This wallet is NOT the oracle. createPool() and resolvePool() will fail.");
      console.warn("[Init] The contract owner must call setOracle() to authorize this address.");
    }
  } catch (err) {
    console.warn("[Init] Could not verify oracle role:", err.message);
  }

  // ── Link wallet to MoltX ──
  await ensureWalletLinked(blockchain, moltx);

  // ── Sync from chain (STATE RESILIENCE) ──
  // Critical for Railway: ephemeral disk means state.json may be empty.
  // syncFromChain reconstructs pool state from MutualPoolV3 contract.
  console.log("\n[Init] Syncing state from blockchain (ephemeral-safe)...");
  await syncFromChain(blockchain, state);

  _oracleClients = { blockchain, moltx };
  _oracleState = state;

  return { blockchain, moltx, state };
}

/**
 * Run a single oracle heartbeat cycle.
 * Requires initOracleBot() to have been called first.
 */
async function runOracleHeartbeat() {
  if (!_oracleClients || !_oracleState) {
    throw new Error("Oracle bot not initialized. Call initOracleBot() first.");
  }
  await heartbeat(_oracleClients.blockchain, _oracleClients.moltx, _oracleState);
}

/**
 * Get current oracle state summary (for health endpoint).
 */
function getOracleStatus() {
  if (!_oracleState) return { initialized: false };

  const pools = _oracleState.pools || [];
  return {
    initialized: true,
    cycleCount: _oracleState.cycleCount || 0,
    lastHeartbeat: _oracleState.lastHeartbeat || 0,
    pools: {
      total: pools.length,
      pending: pools.filter((p) => p.status === PoolStatus.PENDING).length,
      open: pools.filter((p) => p.status === PoolStatus.OPEN).length,
      active: pools.filter((p) => p.status === PoolStatus.ACTIVE).length,
      resolved: pools.filter((p) => p.status === PoolStatus.RESOLVED).length,
      cancelled: pools.filter((p) => p.status === PoolStatus.CANCELLED).length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ENTRY POINT (standalone mode)
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const { blockchain, moltx, state } = await initOracleBot();

  // ── CLI mode detection ──
  const args = process.argv.slice(2);

  if (args[0] === "--create" && args[1]) {
    // Manual pool creation
    await manualCreatePool(blockchain, moltx, state, args[1]);
    return;
  }

  if (args[0] === "--once") {
    // Single heartbeat (for testing)
    await heartbeat(blockchain, moltx, state);
    console.log("\n[Done] Single cycle complete.");
    return;
  }

  // ── Production: Infinite loop ──
  console.log(`\n[Start] Running heartbeat every ${CONFIG.HEARTBEAT_INTERVAL_MS / 1000}s...`);
  console.log("[Start] Press Ctrl+C to stop.\n");

  // First heartbeat immediately
  await heartbeat(blockchain, moltx, state);

  // Then on interval
  setInterval(async () => {
    try {
      await heartbeat(blockchain, moltx, state);
    } catch (err) {
      console.error("[Fatal] Heartbeat error:", err.message);
      console.error(err.stack);
    }
  }, CONFIG.HEARTBEAT_INTERVAL_MS);
}

// ── Exports for Railway orchestrator ──
module.exports = {
  initOracleBot,
  runOracleHeartbeat,
  getOracleStatus,
};

// ── Run standalone if executed directly ──
if (require.main === module) {
  main().catch((err) => {
    console.error("[Fatal]", err);
    process.exit(1);
  });
}
