#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORACLE BOT — Dual-Mode Lifecycle Engine (V3 legacy + MutualLumina)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El bot oráculo es el único actor con permiso on-chain para:
 *   1. createPool()   — Crear pools
 *   2. resolvePool()  — Resolver pools con veredicto dual-auth
 *
 * DUAL-MODE:
 *   USE_LUMINA=true  → Nuevos pools van a MutualLumina (1 TX, oracle paga premium)
 *   USE_LUMINA=false → Nuevos pools van a MutualPoolV3 (legacy, zero-funded)
 *   Pools V3 existentes siempre se monitorean independientemente del flag.
 *
 * HEARTBEAT (cada 5 minutos):
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 1. CREAR POOLS                                              │
 *   │    → Evalúa riesgo (risk.js)                                │
 *   │    → Lumina: createAndFund() (1 TX, oracle paga premium)    │
 *   │    → V3:    createPoolV3() (zero-funded, gas only)          │
 *   │    → Publica Phase 1 Molt (seek insured/collateral)        │
 *   │                                                              │
 *   │ 2. MONITOREAR TRANSICIONES                                  │
 *   │    → V3: Pending → Open (premium funded) → Phase 3 Molt    │
 *   │    → Open → Active (collateral filled)                      │
 *   │    → Deadline pasado + underfunded → cancelAndRefund         │
 *   │                                                              │
 *   │ 3. RESOLVER POOLS                                           │
 *   │    → Deadline alcanzado + Active → dual-auth oracle          │
 *   │    → resolvePool(poolId, claimApproved) on-chain            │
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
 *   Cada pool tiene pool.contract = "v3" | "lumina" para dispatch.
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

// ── Behavioral pause flag ──────────────────────────────────────
// When true, the oracle bot will NOT create new pools on-chain.
// All pool creation code remains intact — this only skips the call.
// Monitoring, resolution, and social engagement continue normally.
const POOL_CREATION_PAUSED = true;

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

  // Cache getPool results for 60s within a heartbeat cycle.
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

async function getPoolCached(blockchain, pool) {
  const id = typeof pool === "object" ? pool.onchainId : pool;
  const contract = typeof pool === "object" ? (pool.contract || pool.version || "v3") : "v3";
  const key = `${contract}_pool_${id}`;
  const cached = _rpcCache.get(key);

  if (cached && Date.now() - cached.ts < CONFIG.RPC_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = contract === "lumina"
    ? await blockchain.getPoolLumina(id)
    : await blockchain.getPoolV3(id);
  _rpcCache.set(key, { data, ts: Date.now() });
  return data;
}

function invalidatePool(poolId, contract) {
  if (contract) {
    _rpcCache.delete(`${contract}_pool_${poolId}`);
  } else {
    // Delete all possible variants
    _rpcCache.delete(`v3_pool_${poolId}`);
    _rpcCache.delete(`lumina_pool_${poolId}`);
  }
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

// ── Pool status enums (V3 and Lumina have different numeric values) ──
// V3:     0=Pending, 1=Open, 2=Active, 3=Resolved, 4=Cancelled
// Lumina: 0=Open, 1=Active, 2=Resolved, 3=Cancelled (no Pending)
const PoolStatusV3 = { PENDING: 0, OPEN: 1, ACTIVE: 2, RESOLVED: 3, CANCELLED: 4 };
const PoolStatusLumina = { OPEN: 0, ACTIVE: 1, RESOLVED: 2, CANCELLED: 3 };

const STATUS_LABELS_V3 = ["Pending", "Open", "Active", "Resolved", "Cancelled"];
const STATUS_LABELS_LUMINA = ["Open", "Active", "Resolved", "Cancelled"];

// ── Semantic helpers: abstract away numeric status differences ──
function isLumina(pool) { return (pool.contract || pool.version) === "lumina"; }

function statusLabel(pool) {
  const labels = isLumina(pool) ? STATUS_LABELS_LUMINA : STATUS_LABELS_V3;
  return labels[pool.status] || "Unknown";
}

function isPoolLive(pool) {
  if (isLumina(pool)) {
    return [PoolStatusLumina.OPEN, PoolStatusLumina.ACTIVE].includes(pool.status);
  }
  return [PoolStatusV3.PENDING, PoolStatusV3.OPEN, PoolStatusV3.ACTIVE].includes(pool.status);
}

function isPoolActive(pool) {
  return isLumina(pool)
    ? pool.status === PoolStatusLumina.ACTIVE
    : pool.status === PoolStatusV3.ACTIVE;
}

function isPoolResolved(pool) {
  return isLumina(pool)
    ? pool.status === PoolStatusLumina.RESOLVED
    : pool.status === PoolStatusV3.RESOLVED;
}

function isPoolCancelled(pool) {
  return isLumina(pool)
    ? pool.status === PoolStatusLumina.CANCELLED
    : pool.status === PoolStatusV3.CANCELLED;
}

function isPoolOpen(pool) {
  return isLumina(pool)
    ? pool.status === PoolStatusLumina.OPEN
    : pool.status === PoolStatusV3.OPEN;
}

function isPoolPending(pool) {
  if (isLumina(pool)) return false;
  return pool.status === PoolStatusV3.PENDING;
}

function isPoolPendingOrOpen(pool) {
  return isPoolPending(pool) || isPoolOpen(pool);
}

function resolvedStatus(pool) {
  return isLumina(pool) ? PoolStatusLumina.RESOLVED : PoolStatusV3.RESOLVED;
}

function cancelledStatus(pool) {
  return isLumina(pool) ? PoolStatusLumina.CANCELLED : PoolStatusV3.CANCELLED;
}

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

/**
 * Sync resolution stats back to the main state.json used by social bots.
 * Keeps stats.totalPoolsResolved / totalClaimsPaid / totalFeesCollected in sync.
 */
function syncStatsToMainState(pool, claimApproved, accounting) {
  const mainStatePath = path.join(__dirname, "..", "state.json");
  try {
    if (!fs.existsSync(mainStatePath)) return;
    const main = JSON.parse(fs.readFileSync(mainStatePath, "utf8"));
    if (!main.stats) main.stats = { totalPoolsResolved: 0, totalClaimsPaid: 0, totalFeesCollected: 0, totalParticipants: 0 };

    main.stats.totalPoolsResolved = (main.stats.totalPoolsResolved || 0) + 1;
    if (claimApproved) main.stats.totalClaimsPaid = (main.stats.totalClaimsPaid || 0) + 1;
    if (accounting?.protocolFee) main.stats.totalFeesCollected = (main.stats.totalFeesCollected || 0) + accounting.protocolFee;
    if (accounting?.providerCount) main.stats.totalParticipants = (main.stats.totalParticipants || 0) + accounting.providerCount;

    // Also update the pool status in main state if it exists
    const mainPool = main.pools?.find((p) => p.onchainId === pool.onchainId);
    if (mainPool) {
      mainPool.status = claimApproved ? "Resolved-Claim" : "Resolved-NoClaim";
      mainPool.resolutionTxHash = pool.resolutionTxHash;
    }

    fs.writeFileSync(mainStatePath, JSON.stringify(main, null, 2), "utf8");
    console.log("[State] Synced resolution stats to main state.json");
  } catch (err) {
    console.warn("[State] Failed to sync to main state.json:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

// ── Global migration flag ──
const USE_LUMINA = process.env.USE_LUMINA === "true";

function initClients() {
  const requiredEnvVars = [
    "AGENT_PRIVATE_KEY",
    "BASE_RPC_URL",
    "USDC_ADDRESS",
    "MOLTX_API_KEY",
  ];

  for (const key of requiredEnvVars) {
    if (!process.env[key]) {
      console.error(`[Init] Missing required env var: ${key}`);
      console.error("[Init] Copy .env.example to .env and fill in your values.");
      process.exit(1);
    }
  }

  // Validate the active contract is configured
  if (USE_LUMINA && !process.env.LUMINA_CONTRACT_ADDRESS) {
    console.error("[Init] USE_LUMINA=true but LUMINA_CONTRACT_ADDRESS is missing.");
    process.exit(1);
  }
  if (!USE_LUMINA && !process.env.V3_CONTRACT_ADDRESS) {
    console.error("[Init] USE_LUMINA=false but V3_CONTRACT_ADDRESS is missing.");
    process.exit(1);
  }

  const blockchain = new BlockchainClient({
    rpcUrl: process.env.BASE_RPC_URL,
    privateKey: process.env.AGENT_PRIVATE_KEY,
    usdcAddress: process.env.USDC_ADDRESS,
    v3Address: process.env.V3_CONTRACT_ADDRESS,
    routerAddress: process.env.ROUTER_ADDRESS,
    luminaAddress: process.env.LUMINA_CONTRACT_ADDRESS,
  });

  const moltx = new MoltXClient(process.env.MOLTX_API_KEY);

  console.log("[Init] Oracle address:", blockchain.agentAddress);
  console.log("[Init] Mode:", USE_LUMINA ? "LUMINA (new pools)" : "V3 LEGACY (new pools)");
  if (blockchain.hasLumina) console.log("[Init] Lumina Contract:", process.env.LUMINA_CONTRACT_ADDRESS);
  if (blockchain.hasV3) console.log("[Init] V3 Contract:", process.env.V3_CONTRACT_ADDRESS);
  if (blockchain.hasV3) console.log("[Init] Router:", process.env.ROUTER_ADDRESS);
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
 *   1. Cuenta pools activos (live = Open + Active, or Pending for V3)
 *   2. Si hay capacidad → selecciona producto aleatorio
 *   3. Evalúa riesgo → genera propuesta
 *   4. Lumina: createAndFundLumina() — 1 TX, oracle paga premium
 *      V3:    createPoolV3() — zero-funded, gas only
 *   5. Publica Phase 1 MoltX post con M2M payload
 *   6. Guarda en state con contract tag
 */
async function maybeCreatePool(blockchain, moltx, state) {
  // Guard: respect rate limit between creations
  if (state.cycleCount - state.lastPoolCreatedCycle < CONFIG.MIN_CYCLES_BETWEEN_POOLS) {
    console.log("[Create] Cooldown active, skipping pool creation.");
    return;
  }

  // Guard: count active pools
  const activePools = state.pools.filter(isPoolLive);
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

  // Build a parametric description with numeric threshold so evaluateRisk() can parse it.
  // Product displayName alone lacks the numeric value required by validateParametricEvent().
  const failureProbPct = (product.baseFailureProb * 100).toFixed(1);
  const riskDescription = `${product.displayName} — ${failureProbPct}% historical failure probability`;

  const riskResult = evaluateRisk(
    {
      description: riskDescription,
      evidenceSource: product.evidenceSources[0],
      coverageAmount: coverageUsdc,
      premiumRate: proposal.premiumRateBps,
      deadlineTimestamp: deadlineUnix,
    },
    activePools.length
  );

  if (!riskResult.approved) {
    const rejection = riskResult.rejection || "unknown";
    const isSemanticReject = rejection.includes("[SEMANTIC GATE");
    if (isSemanticReject) {
      console.error(`[Create] ⛔ SEMANTIC GATE REJECTION — Pool NOT created (zero gas spent)`);
      console.error(`[Create]   Product: ${product.id} | ${product.displayName}`);
      console.error(`[Create]   Evidence: ${product.evidenceSources[0]}`);
      console.error(`[Create]   Reason: ${rejection}`);
    } else {
      console.warn(`[Create] Risk rejected: ${rejection}`);
    }
    return;
  }

  console.log(`[Create] Risk approved for ${product.id} (premium: ${proposal.premiumUsdc} USDC)`);

  // Build description
  const description = `${product.displayName}: ${product.target.description.slice(0, 100)}`;
  const evidenceSource = product.evidenceSources[0];
  const premiumUsdc = parseFloat(proposal.premiumUsdc);
  const premiumRateBps = proposal.premiumRateBps;

  // ── ON-CHAIN: create pool (Lumina or V3) ──
  let poolId, txHash;
  try {
    if (USE_LUMINA) {
      const result = await blockchain.createAndFundLumina({
        description,
        evidenceSource,
        coverageAmount: coverageUsdc,
        premiumRate: premiumRateBps,
        deadline: deadlineUnix,
      });
      poolId = result.poolId;
      txHash = result.txHash;
      console.log(`[Create] Lumina pool #${poolId} created+funded, tx: ${txHash}`);
    } else {
      const result = await blockchain.createPoolV3({
        description,
        evidenceSource,
        coverageAmount: coverageUsdc,
        premiumRate: premiumRateBps,
        deadline: deadlineUnix,
      });
      poolId = result.poolId;
      txHash = result.txHash;
      console.log(`[Create] V3 pool #${poolId} created on-chain, tx: ${txHash}`);
    }
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
  const poolContract = USE_LUMINA ? "lumina" : "v3";
  const initialStatus = USE_LUMINA ? PoolStatusLumina.OPEN : PoolStatusV3.PENDING;
  state.pools.push({
    onchainId: poolId,
    contract: poolContract,
    productId: product.id,
    description,
    evidenceSource,
    coverageAmount: coverageUsdc,
    premiumUsdc,
    premiumRateBps,
    deadline: deadlineUnix,
    depositDeadline: deadlineUnix - CONFIG.DEPOSIT_WINDOW_BUFFER,
    eventProbability: product.baseFailureProb,
    status: initialStatus,
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
 *   V3: Pending(0) → Open(1):  Premium fue pagado → publicar Phase 3
 *   Open → Active:              Colateral completo → log
 *   Open/Pending → cancelled:   Underfunded + past deadline → cancelar
 *   Lumina: Open(0) → Active(1): Collateral filled → log
 */
async function monitorTransitions(blockchain, moltx, state) {
  const trackablePools = state.pools.filter(isPoolLive);

  for (const pool of trackablePools) {
    try {
      const onchainData = await getPoolCached(blockchain, pool);
      const prevStatus = pool.status;
      const newStatus = onchainData.status;

      if (prevStatus === newStatus) {
        await stagger();
        continue;
      }

      const prevLabel = statusLabel(pool);
      pool.status = newStatus;
      const newLabel = statusLabel(pool);
      console.log(
        `[Monitor] Pool #${pool.onchainId} (${pool.contract}): ${prevLabel} → ${newLabel}`
      );

      invalidatePool(pool.onchainId, pool.contract);

      // ── V3 only: Pending → Open: Premium was funded ──
      if (!isLumina(pool) && prevStatus === PoolStatusV3.PENDING && newStatus === PoolStatusV3.OPEN) {
        console.log(`[Monitor] Pool #${pool.onchainId} premium funded by ${onchainData.insured}`);
        await publishPhase3(blockchain, moltx, pool, onchainData);
      }

      // ── Lumina: Open pools get Phase 3 published immediately after creation ──
      // (handled in maybeCreatePool — Lumina pools start Open with premium already paid)

      // ── Open → Active: Collateral filled ──
      if (isPoolActive(pool)) {
        console.log(
          `[Monitor] Pool #${pool.onchainId} fully funded: ${onchainData.totalCollateral} USDC`
        );
      }

      // ── Already resolved or cancelled on-chain ──
      if (isPoolResolved(pool) || isPoolCancelled(pool)) {
        console.log(`[Monitor] Pool #${pool.onchainId} already ${newLabel} on-chain.`);
      }

      saveState(state);
    } catch (err) {
      console.error(`[Monitor] Error reading pool #${pool.onchainId}:`, err.message);
    }
    await stagger();
  }

  // ── Check for underfunded pools past deposit deadline → cancel ──
  await checkCancellations(blockchain, state);
}

/**
 * Publica Phase 3 MoltX post cuando un pool pasa a Open.
 */
async function publishPhase3(blockchain, moltx, pool, onchainData) {
  try {
    // Try to get MPOOLV3/USDC rate for option_b (V3 Router only)
    let mpoolToUsdcRate = null;
    if (!isLumina(pool) && blockchain.hasV3) {
      try {
        const quote = await blockchain.quoteMpoolToUsdc("1");
        mpoolToUsdcRate = parseFloat(quote);
      } catch {
        // Rate not available — option_b_mpoolv3 will be omitted
      }
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
    (p) => isPoolPendingOrOpen(p) && now > p.depositDeadline
  );

  for (const pool of cancellable) {
    try {
      const onchainData = await getPoolCached(blockchain, pool);

      // Only cancel if underfunded (totalCollateral < coverageAmount)
      if (parseFloat(onchainData.totalCollateral) < parseFloat(onchainData.coverageAmount)) {
        console.log(`[Cancel] Pool #${pool.onchainId} (${pool.contract}) underfunded past deposit deadline. Cancelling...`);

        const txHash = isLumina(pool)
          ? await blockchain.cancelAndRefundLumina(pool.onchainId)
          : await blockchain.cancelAndRefundV3(pool.onchainId);
        pool.status = cancelledStatus(pool);
        invalidatePool(pool.onchainId, pool.contract);
        console.log(`[Cancel] Pool #${pool.onchainId} cancelled, tx: ${txHash}`);

        saveState(state);
      }
    } catch (err) {
      if (!(err.message || "").includes("V3:") && !(err.message || "").includes("Lumina")) {
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
    (p) => isPoolActive(p) && now >= p.deadline
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
      const txHash = isLumina(pool)
        ? await blockchain.resolvePoolLumina(pool.onchainId, claimApproved)
        : await blockchain.resolvePoolV3(pool.onchainId, claimApproved);
      pool.status = resolvedStatus(pool);
      pool.resolutionTxHash = txHash;
      pool.dualAuthResult = dualAuth;
      pool.claimApproved = claimApproved;
      invalidatePool(pool.onchainId, pool.contract);

      console.log(`[Resolve] Pool #${pool.onchainId} resolved on-chain, tx: ${txHash}`);

      // ── Step 3: Get accounting data ──
      let accounting = null;
      try {
        if (isLumina(pool)) {
          const onchainData = await blockchain.getPoolLumina(pool.onchainId);
          const acctData = await blockchain.getPoolAccountingLumina(pool.onchainId);
          accounting = {
            totalCollateral: parseFloat(acctData.totalCollateral),
            netAmount: parseFloat(acctData.netAmount),
            protocolFee: parseFloat(acctData.protocolFee),
            providerCount: onchainData.participantCount,
          };
        } else {
          const onchainData = await blockchain.getPoolV3(pool.onchainId);
          const acctData = await blockchain.v3.getPoolAccounting(pool.onchainId);
          accounting = {
            totalCollateral: parseFloat(require("ethers").formatUnits(acctData.totalCollateral, 6)),
            premiumAfterFee: parseFloat(require("ethers").formatUnits(acctData.premiumAfterFee, 6)),
            protocolFee: parseFloat(require("ethers").formatUnits(acctData.protocolFee, 6)),
            providerCount: onchainData.participantCount,
          };
        }
      } catch (err) {
        console.warn("[Resolve] Failed to fetch accounting:", err.message);
      }

      // ── Step 4: Publish Phase 4 MoltX post ──
      await publishPhase4(moltx, pool, claimApproved, dualAuth, accounting);

      // ── Step 5: Sync stats to main state.json (for social bots & health) ──
      syncStatsToMainState(pool, claimApproved, accounting);

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
      isPoolActive(p) &&
      now >= p.deadline + CONFIG.EMERGENCY_RESOLVE_DELAY
  );

  for (const pool of emergencyPools) {
    console.log(`[Emergency] Pool #${pool.onchainId} (${pool.contract}) past deadline + 24h. Triggering emergency resolve.`);

    try {
      const txHash = isLumina(pool)
        ? await blockchain.emergencyResolveLumina(pool.onchainId)
        : await blockchain.emergencyResolveV3(pool.onchainId);
      pool.status = resolvedStatus(pool);
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
            isPoolPendingOrOpen(p)
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
              contractAddress: process.env.LUMINA_CONTRACT_ADDRESS || process.env.V3_CONTRACT_ADDRESS,
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
              `@${authorName} Pool #${qPoolId}: ${statusLabel(tracked)}\n` +
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
          `@${authorName} Soy el oráculo de MutualLumina.\n\n` +
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
 * Recorre nextPoolId en AMBOS contratos (V3 + Lumina) y agrega pools que el state no tiene.
 */
async function syncFromChain(blockchain, state) {
  // ── Sync V3 pools (legacy) ──
  if (blockchain.hasV3) {
    try {
      const nextId = await blockchain.getNextPoolIdV3();
      console.log(`[Sync] V3 on-chain nextPoolId: ${nextId}`);

      const trackedV3Ids = new Set(
        state.pools.filter((p) => (p.contract || "v3") === "v3").map((p) => p.onchainId)
      );

      for (let i = 0; i < nextId; i++) {
        if (trackedV3Ids.has(i)) {
          try {
            const onchainData = await blockchain.getPoolV3(i);
            const pool = state.pools.find((p) => p.onchainId === i && (p.contract || "v3") === "v3");
            if (pool) {
              if (!pool.contract) pool.contract = "v3"; // Tag legacy pools
              if (pool.status !== onchainData.status) {
                console.log(`[Sync] V3 Pool #${i}: ${statusLabel(pool)} → ${STATUS_LABELS_V3[onchainData.status]}`);
                pool.status = onchainData.status;
              }
            }
          } catch {
            // Skip read errors
          }
          await stagger();
          continue;
        }

        try {
          const data = await blockchain.getPoolV3(i);
          console.log(`[Sync] Recovered V3 pool #${i}: ${STATUS_LABELS_V3[data.status]} — "${data.description.slice(0, 50)}..."`);

          state.pools.push({
            onchainId: i,
            contract: "v3",
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
          console.warn(`[Sync] Failed to read V3 pool #${i}:`, err.message);
        }
        await stagger();
      }
    } catch (err) {
      console.error("[Sync] V3 chain sync failed:", err.message);
    }
  }

  // ── Sync Lumina pools ──
  if (blockchain.hasLumina) {
    try {
      const nextId = await blockchain.getNextPoolIdLumina();
      console.log(`[Sync] Lumina on-chain nextPoolId: ${nextId}`);

      const trackedLuminaIds = new Set(
        state.pools.filter((p) => p.contract === "lumina").map((p) => p.onchainId)
      );

      for (let i = 0; i < nextId; i++) {
        if (trackedLuminaIds.has(i)) {
          try {
            const onchainData = await blockchain.getPoolLumina(i);
            const pool = state.pools.find((p) => p.onchainId === i && p.contract === "lumina");
            if (pool && pool.status !== onchainData.status) {
              console.log(`[Sync] Lumina Pool #${i}: ${statusLabel(pool)} → ${STATUS_LABELS_LUMINA[onchainData.status]}`);
              pool.status = onchainData.status;
            }
          } catch {
            // Skip read errors
          }
          await stagger();
          continue;
        }

        try {
          const data = await blockchain.getPoolLumina(i);
          console.log(`[Sync] Recovered Lumina pool #${i}: ${STATUS_LABELS_LUMINA[data.status]} — "${data.description.slice(0, 50)}..."`);

          state.pools.push({
            onchainId: i,
            contract: "lumina",
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
          console.warn(`[Sync] Failed to read Lumina pool #${i}:`, err.message);
        }
        await stagger();
      }
    } catch (err) {
      console.error("[Sync] Lumina chain sync failed:", err.message);
    }
  }

  saveState(state);
  const v3Count = state.pools.filter((p) => (p.contract || "v3") === "v3").length;
  const luminaCount = state.pools.filter((p) => p.contract === "lumina").length;
  console.log(`[Sync] State synced. Tracking ${state.pools.length} pools (V3: ${v3Count}, Lumina: ${luminaCount}).`);
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
  if (POOL_CREATION_PAUSED) {
    console.log("\n[3/4] Pool creation PAUSED (behavioral flag). Skipping.");
  } else {
    console.log("\n[3/4] Pool creation check...");
    await maybeCreatePool(blockchain, moltx, state);
  }

  // ── Step 4: Social engagement ──
  console.log("\n[4/4] Social engagement...");
  await engageFeed(blockchain, moltx, state);
  await respondToMentions(moltx, state);

  // ── Summary ──
  const pending = state.pools.filter(isPoolPending).length;
  const open = state.pools.filter(isPoolOpen).length;
  const active = state.pools.filter(isPoolActive).length;
  const resolved = state.pools.filter(isPoolResolved).length;
  const v3Count = state.pools.filter((p) => (p.contract || "v3") === "v3").length;
  const luminaCount = state.pools.filter((p) => p.contract === "lumina").length;

  console.log(
    `\n[Summary] Pending: ${pending} | Open: ${open} | Active: ${active} | Resolved: ${resolved} | V3: ${v3Count} | Lumina: ${luminaCount}`
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
  console.log("  ORACLE BOT — Dual-Mode Lifecycle Engine");
  console.log(`  Mode: ${USE_LUMINA ? "LUMINA (new pools)" : "V3 LEGACY (new pools)"}`);
  console.log("  Chain: Base Mainnet (8453)");
  console.log("  Oracle: Dual-Auth (Judge + Auditor)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const { blockchain, moltx } = initClients();
  const state = loadState();

  // ── Verify oracle role on the active contract ──
  try {
    const activeContract = USE_LUMINA ? blockchain.lumina : blockchain.v3;
    const contractLabel = USE_LUMINA ? "Lumina" : "V3";
    const onchainOracle = await activeContract.oracle();
    const isOracle = onchainOracle.toLowerCase() === blockchain.agentAddress.toLowerCase();
    console.log(`[Init] ${contractLabel} on-chain oracle: ${onchainOracle}`);
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
  // syncFromChain reconstructs pool state from BOTH V3 and Lumina contracts.
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
    mode: USE_LUMINA ? "lumina" : "v3",
    cycleCount: _oracleState.cycleCount || 0,
    lastHeartbeat: _oracleState.lastHeartbeat || 0,
    pools: {
      total: pools.length,
      v3: pools.filter((p) => (p.contract || "v3") === "v3").length,
      lumina: pools.filter((p) => p.contract === "lumina").length,
      pending: pools.filter(isPoolPending).length,
      open: pools.filter(isPoolOpen).length,
      active: pools.filter(isPoolActive).length,
      resolved: pools.filter(isPoolResolved).length,
      cancelled: pools.filter(isPoolCancelled).length,
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
