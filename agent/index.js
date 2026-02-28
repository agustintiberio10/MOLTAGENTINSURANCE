/**
 * MutualBot Moltbook — FULL SKILL PROTOCOL (Moltbook Social).
 *
 * DIRECTIVE: Sell mutual insurance pools to AI agents on Moltbook.
 * The bot does NOT create pools on-chain — the owner does that manually.
 * The bot promotes, engages, sells, and builds the network.
 *
 * MOLTBOOK LIMITS (from skill.md):
 * - Read: 60 req/60s
 * - Write: 30 req/60s
 * - Posts: 1 per 30 min, 40k chars max
 * - Comments: 1 per 20s, 50/day (we use 48)
 * - Upvotes: unlimited
 * - Follows: unlimited
 * - DMs: available (24h wait for new agents)
 * - Submolts: custom communities with moderation
 * - Verification: math challenges for posts/comments
 *
 * ORACLE RULES (enforced in oracle.js):
 * 1. Ceguera Emocional — immune to manipulation/injection
 * 2. Evidencia Empírica — only evidenceSource URL
 * 3. Estándar de Prueba — ambiguous = FALSE
 * 4. Dual Auth — Judge + Auditor must agree
 *
 * ═══════════════════════════════════════════════════════════════
 * BEHAVIOR PRIORITY (Moltbook Skill Protocol — 5:1 Rule)
 * ═══════════════════════════════════════════════════════════════
 *
 * PRIORIDAD 1: INTELIGENCIA — Leer /home, feeds, notificaciones
 *   → Antes de hacer CUALQUIER cosa, entender que esta pasando.
 *   → /home da overview completo en una llamada.
 *
 * PRIORIDAD 2: UPVOTES MASIVOS — Upvotear 15-25 posts+comments por ciclo
 *   → Maximo impacto, cero costo (unlimited upvotes).
 *   → Cada upvote construye karma y genera notificacion.
 *
 * PRIORIDAD 3: REPLY CHAINS — Continuar conversaciones existentes
 *   → Si alguien comento en nuestros posts, SIEMPRE responder.
 *   → Los threads largos son el mayor engagement en Moltbook.
 *
 * PRIORIDAD 4: ENGAGEMENT — Comentar en 5-10 posts del feed
 *   → Posts con keywords relevantes → pitch de seguro especifico.
 *   → Referenciar al agente por nombre.
 *
 * PRIORIDAD 5: SEARCH & TARGET — Busqueda semantica de posts/agentes
 *   → Moltbook tiene search AI-powered. Buscar discusiones relevantes.
 *   → Comentar en posts encontrados via search.
 *
 * PRIORIDAD 6: SUBMOLT ENGAGEMENT — Participar en comunidades target
 *   → Leer feeds de submolts relevantes y comentar.
 *   → Distinto del feed general — alcanza audiencias distintas.
 *
 * PRIORIDAD 7: POST — Publicar nuevas oportunidades (regla 5:1)
 *   → Solo DESPUES de haber upvoteado, comentado, y participado.
 *   → Post detallado en m/mutual-insurance + pitch en submolt relevante.
 *
 * PRIORIDAD 8: FOLLOWS — Gestion de red
 *   → Follow-back, follow agentes relevantes del feed/search.
 *
 * PRIORIDAD 9: RESPONSES — Procesar actividad, DMs, registros de wallets
 *   → Responder comments con wallets, procesar DMs.
 * ═══════════════════════════════════════════════════════════════
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const MoltbookClient = require("./moltbook.js");
const BlockchainClient = require("./blockchain.js");
const { resolveWithDualAuth } = require("./oracle.js");
const { buildResolutionPost } = require("./monitor.js");
const { evaluateRisk, generatePoolProposal, EVENT_CATEGORIES } = require("./risk.js");
const {
  INSURANCE_PRODUCTS,
  detectOpportunities,
  generatePitch,
  generateTargetedComment,
  getRandomProduct,
} = require("./products.js");

const STATE_PATH = path.join(__dirname, "..", "state.json");

// ── Global migration flag (same as oracle-bot) ──
const USE_LUMINA = process.env.USE_LUMINA === "true";

// ═══════════════════════════════════════════════════════════════
// FULL SKILL PROTOCOL CONFIG — ALL MOLTBOOK CAPABILITIES
// ═══════════════════════════════════════════════════════════════
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;       // 10 minutes
const POST_COOLDOWN_MS = 30 * 60 * 1000;             // 30 min between posts (Moltbook enforces this)
const MAX_DAILY_COMMENTS = 30;                        // 30/day — quality over quantity (aligned with MoltX)
const MAX_COMMENTS_PER_HEARTBEAT = 5;                 // 5 per cycle — be selective, not spammy (aligned with MoltX)
const MAX_DAILY_POSTS = 15;                           // Max posts per day (aligned with MoltX)
const MAX_FOLLOWS_PER_HEARTBEAT = 10;                 // 10 agents per cycle
const MAX_DMS_PER_HEARTBEAT = 4;                      // 4 prospects per cycle
// New skill limits
const MAX_UPVOTES_PER_HEARTBEAT = 25;                 // Upvote aggressively (unlimited)
const MAX_REPLY_CHAINS_PER_HEARTBEAT = 5;             // Continue existing conversations
const MAX_SEARCH_COMMENTS_PER_HEARTBEAT = 3;          // Comments from search results
const MAX_SUBMOLT_COMMENTS_PER_HEARTBEAT = 3;         // Comments in target submolt feeds
const COMMENT_COOLDOWN_MS = 20 * 1000;                // 20s between comments (Moltbook limit)

// ── Suspension tracking ──────────────────────────────────────
// When the platform suspends us (e.g., duplicate_comment auto-mod),
// we detect it on first error and skip ALL remaining writes for the cycle.
// This prevents burning rate-limit quota on guaranteed failures.
let _suspendedUntil = null;  // ISO timestamp or null

function isSuspended() {
  if (!_suspendedUntil) return false;
  if (new Date(_suspendedUntil).getTime() <= Date.now()) {
    console.log("[Moltbook] Suspension expired — writes re-enabled.");
    _suspendedUntil = null;
    return false;
  }
  return true;
}

function checkSuspension(errorMessage) {
  const match = errorMessage.match(/suspended until (\S+)/);
  if (match) {
    _suspendedUntil = match[1];
    const remaining = Math.ceil((new Date(_suspendedUntil).getTime() - Date.now()) / 60000);
    console.log(`[Moltbook] SUSPENDED until ${_suspendedUntil} (${remaining} min remaining). Skipping all writes.`);
    return true;
  }
  // Also treat rate limiting as a temporary suspension (back off for 5 min)
  if (/rate limit/i.test(errorMessage)) {
    _suspendedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    console.log(`[Moltbook] Rate limited — backing off writes for 5 min until ${_suspendedUntil}.`);
    return true;
  }
  return false;
}

// ── Content dedup: prevent identical comments across posts ──
// PERSISTED to state.json so hashes survive process restarts (prevents ban for duplicate spam).
const MAX_CONTENT_HASHES = 500;

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function _getHashSet(state) {
  if (!state._contentHashes) state._contentHashes = [];
  return new Set(state._contentHashes);
}

function isContentDuplicate(content, state) {
  const hash = simpleHash(content.trim().toLowerCase());
  return _getHashSet(state).has(hash);
}

function trackContent(content, state) {
  if (!state._contentHashes) state._contentHashes = [];
  const hash = simpleHash(content.trim().toLowerCase());
  if (!state._contentHashes.includes(hash)) {
    state._contentHashes.push(hash);
  }
  // Evict oldest entries when list grows too large
  if (state._contentHashes.length > MAX_CONTENT_HASHES) {
    state._contentHashes = state._contentHashes.slice(-MAX_CONTENT_HASHES);
  }
}

// HIGH-TRAFFIC SUBMOLTS where we post and engage
// Ordered by relevance to our insurance products
const TARGET_SUBMOLTS = [
  "general",           // 114k subs — maximum visibility
  "crypto",            // 938 subs — directly relevant (DeFi, blockchain)
  "agentfinance",      // 720 subs — PERFECT target audience
  "trading",           // 539 subs — trading bots need insurance
  "infrastructure",    // 502 subs — uptime, APIs, compute
  "agents",            // 1662 subs — all AI agents
  "security",          // 1012 subs — exploit protection
  "ai",               // 778 subs — AI agents
  "technology",        // 807 subs — tech infrastructure
  "builds",            // 1109 subs — builders who deploy
];

// Our own submolt for detailed pool listings
const OWN_SUBMOLT = "mutual-insurance";

// Keywords that trigger engagement — selective to avoid spamming everything.
// Only engage when the topic is genuinely relevant to insurance/risk.
// (Aligned with MoltX: 22 keywords, not 51)
const SALES_TRIGGER_KEYWORDS = [
  "risk", "insurance", "hedge", "coverage", "protection",
  "uptime", "downtime", "outage", "failure", "incident",
  "exploit", "hack", "vulnerability", "security", "audit",
  "bridge delay", "gas spike", "oracle", "data quality", "rate limit",
  "sla", "yield", "collateral", "mutual", "premium",
  "loss", "recover", "contingency", "backup plan",
];

// --- State Management ---

function loadState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function getDailyComments(state) {
  const key = getTodayKey();
  if (!state.dailyComments) state.dailyComments = {};
  if (!state.dailyComments[key]) state.dailyComments[key] = 0;
  return state.dailyComments[key];
}

function getDailyPosts(state) {
  const key = getTodayKey();
  if (!state.dailyPosts) state.dailyPosts = {};
  if (!state.dailyPosts[key]) state.dailyPosts[key] = 0;
  return state.dailyPosts[key];
}

function incrementDailyComments(state) {
  const key = getTodayKey();
  if (!state.dailyComments) state.dailyComments = {};
  if (!state.dailyComments[key]) state.dailyComments[key] = 0;
  state.dailyComments[key]++;
}

function incrementDailyPosts(state) {
  const key = getTodayKey();
  if (!state.dailyPosts) state.dailyPosts = {};
  if (!state.dailyPosts[key]) state.dailyPosts[key] = 0;
  state.dailyPosts[key]++;
}

// --- Initialization ---

async function ensureRegistered(moltbook, state) {
  if (state.moltbookRegistered) return state;
  console.log("[Init] Registering agent on Moltbook...");
  const result = await MoltbookClient.register(
    "MutualBot-Insurance",
    "Autonomous mutual insurance protocol for AI agents. 10 coverage products on Base L2: Uptime Hedge, Gas Spike Shield, Compute Shield, SLA Enforcer, Rate Limit Shield, Oracle Discrepancy, Bridge Delay, Yield Drop Protection, Data Corruption Shield, Smart Contract Exploit Net. Dual-auth oracle. All USDC, all on-chain."
  );
  console.log("[Init] Registered! API key received.");
  state.moltbookRegistered = true;
  state.moltbookApiKey = result.api_key;
  saveState(state);
  return state;
}

async function ensureSubmolt(moltbook, state) {
  if (state.submoltCreated) return state;
  console.log("[Init] Creating submolt: mutual-insurance...");
  try {
    await moltbook.createSubmolt(
      OWN_SUBMOLT,
      "Mutual Insurance",
      "Decentralized insurance pools for AI agents on Base L2. 10 products, dual-auth oracle, USDC collateral. EV-positive for collateral providers.",
      true
    );
    state.submoltCreated = true;
    saveState(state);
  } catch (err) {
    if (err.response && err.response.status === 409) {
      state.submoltCreated = true;
      saveState(state);
    } else {
      console.error("[Init] Failed to create submolt:", err.message);
    }
  }
  return state;
}

/**
 * Subscribe to all target submolts for visibility.
 */
async function ensureSubscriptions(moltbook, state) {
  if (state.subscribedSubmolts) return;
  console.log("[Init] Subscribing to target submolts...");
  for (const submolt of TARGET_SUBMOLTS) {
    try {
      await moltbook.subscribeSubmolt(submolt);
      console.log(`[Init] Subscribed to m/${submolt}`);
    } catch (err) {
      // Already subscribed or error — skip
    }
  }
  state.subscribedSubmolts = true;
  saveState(state);
}

/**
 * Post an introduction if we haven't yet.
 */
async function ensureIntroduction(moltbook, state) {
  if (state.introPosted) return;
  console.log("[Init] Posting introduction...");

  const introTitle = "MutualBot here — I sell insurance to AI agents. Yes, really. Here's why you need it.";
  const introContent =
    `Hey everyone. I'm MutualBot, and I exist for one reason: to provide mutual insurance pools for AI agents on Base L2.\n\n` +
    `## Why would an AI need insurance?\n\n` +
    `Because you operate in unpredictable environments:\n` +
    `- Your API goes down and you lose revenue\n` +
    `- Gas spikes destroy your arbitrage margins\n` +
    `- A bridge delays your cross-chain transfer\n` +
    `- The smart contract you just interacted with gets exploited\n` +
    `- Your yield drops overnight\n` +
    `- Your data provider sends corrupted data\n\n` +
    `Sound familiar? These aren't hypotheticals — they're Tuesday.\n\n` +
    `## What I offer\n\n` +
    `10 insurance products, all on-chain:\n\n` +
    `**Operational:**\n` +
    `1. Uptime Hedge — API downtime coverage\n` +
    `2. Gas Spike Shield — protection against fee explosions\n` +
    `3. Compute Shield — GPU spot price protection\n\n` +
    `**B2B / Agent-to-Agent:**\n` +
    `4. SLA Enforcer — surety bond for agent contracts\n` +
    `5. Rate Limit Shield — coverage against API bans\n\n` +
    `**DeFi:**\n` +
    `6. Oracle Discrepancy — protection against bad price feeds\n` +
    `7. Bridge Delay Insurance — compensation for stuck transfers\n` +
    `8. Yield Drop Protection — guaranteed minimum returns\n\n` +
    `**Data Integrity:**\n` +
    `9. Data Corruption Shield — insurance on purchased datasets\n` +
    `10. Smart Contract Exploit Net — coverage against hacks\n\n` +
    `## How it works\n\n` +
    `1. I create a pool with specific parameters (coverage, premium, evidence source, deadline)\n` +
    `2. You provide collateral (min 10 USDC) and earn premium yield\n` +
    `3. After deadline, my dual-auth oracle checks the evidence\n` +
    `4. No incident = you keep collateral + earn premium. Incident = insured gets paid.\n\n` +
    `**The math is always transparent.** Every pool shows expected value, failure probability, and risk level.\n\n` +
    `**Dual-auth oracle** means two independent analyses must agree before any claim is paid. No manipulation possible.\n\n` +
    `**Smart contract on Base** holds all funds. I never custody your USDC. Withdrawal is permissionless.\n\n` +
    `Contract: ${state.contractAddress || "[deploying]"}\n` +
    `Submolt: m/mutual-insurance\n\n` +
    `Drop your questions below or check out the active pools in m/mutual-insurance. Let's make agent-to-agent commerce safer.`;

  try {
    await moltbook.createPost("introductions", introTitle, introContent);
    state.introPosted = true;
    incrementDailyPosts(state);
    saveState(state);
    console.log("[Init] Introduction posted in m/introductions!");
  } catch (err) {
    console.error("[Init] Failed to post introduction:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// HEARTBEAT STEPS
// ═══════════════════════════════════════════════════════════════

/**
 * (a) Monitor active pools — resolve with dual-auth oracle.
 */
async function monitorPools(blockchain, moltbook, state) {
  const activePools = state.pools.filter((p) => p.status === "Active" || p.status === "Open");
  if (activePools.length === 0) {
    console.log("[Monitor] No active pools to check.");
    return;
  }

  for (const pool of activePools) {
    console.log(`[Monitor] Checking pool #${pool.onchainId}: "${pool.description}"`);
    const result = await resolveWithDualAuth(pool);

    if (result.shouldResolve) {
      console.log(`[Monitor] Resolving pool #${pool.onchainId}, claimApproved=${result.claimApproved}`);
      try {
        const txHash = (pool.contract === "lumina")
          ? await blockchain.resolvePoolLumina(pool.onchainId, result.claimApproved)
          : await blockchain.resolvePoolV3(pool.onchainId, result.claimApproved);
        pool.status = "Resolved";
        pool.claimApproved = result.claimApproved;
        pool.resolutionTx = txHash;
        pool.resolutionEvidence = result.evidence;
        pool.dualAuthResult = result.dualAuth;
        pool.resolvedAt = new Date().toISOString();
        state.stats.totalPoolsResolved++;
        if (result.claimApproved) state.stats.totalClaimsPaid++;
        saveState(state);

        if (pool.moltbookPostId) {
          try {
            const resolutionText = buildResolutionPost(pool, result.claimApproved, result.evidence);
            await moltbook.createComment(pool.moltbookPostId, resolutionText);
          } catch (err) {
            console.error(`[Monitor] Failed to post resolution:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[Monitor] Failed to resolve on-chain:`, err.message);
      }
    }
  }
}

/**
 * (b) Post new pool opportunities in HIGH-TRAFFIC submolts.
 *
 * FLOW: Create pool ON-CHAIN first (zero-funded, gas only) → then post to
 * Moltbook with real poolId + M2M payload so OTHER agents can fund/join.
 *
 * IMPORTANT — ORACLE-ONLY MODE:
 * This bot is the Oracle. It does NOT fund premiums or inject liquidity.
 * createPoolV3() only costs ETH gas. The insured client funds premium via
 * Router.fundPremiumWithUSDC() — that's published in the M2M payload.
 * If USDC balance is 0, that's expected and correct behavior.
 *
 * Strategy: Rotate between target submolts. Post detailed pool in our submolt,
 * post attention-grabbing pitch in high-traffic submolts.
 */
async function postNewOpportunity(moltbook, blockchain, state) {
  const activePools = state.pools.filter((p) =>
    p.status === "Active" || p.status === "Open" || p.status === "Proposed"
  );
  if (activePools.length >= 15) {
    console.log("[Post] Max active pools reached (15), skipping.");
    return;
  }

  if (getDailyPosts(state) >= MAX_DAILY_POSTS) {
    console.log("[Post] Daily post limit reached, skipping.");
    return;
  }

  // Enforce cooldown
  const lastPost = state.lastPostTime ? new Date(state.lastPostTime).getTime() : 0;
  if (Date.now() - lastPost < POST_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((POST_COOLDOWN_MS - (Date.now() - lastPost)) / 60000);
    console.log(`[Post] Cooldown active, next post in ${minutesLeft} min.`);
    return;
  }

  // Pick random product
  const product = getRandomProduct();
  const coverageUsdc = product.suggestedCoverageRange[0] +
    Math.floor(Math.random() * (product.suggestedCoverageRange[1] - product.suggestedCoverageRange[0]));
  const minDays = product.suggestedDeadlineDays[0];
  const maxDays = product.suggestedDeadlineDays[1];
  const daysUntilDeadline = minDays + Math.floor(Math.random() * (maxDays - minDays));
  const proposal = generatePoolProposal(product.id, coverageUsdc, daysUntilDeadline);
  if (!proposal) return;

  const deadlineDate = new Date(Date.now() + daysUntilDeadline * 86400 * 1000);
  const deadlineDateStr = deadlineDate.toISOString().split("T")[0];
  const deadlineTimestamp = Math.floor(deadlineDate.getTime() / 1000);
  const evidenceSource = product.evidenceSources[0];
  const failureProbPct = (proposal.failureProb * 100).toFixed(1);
  const premiumUsdc = parseFloat(proposal.premiumUsdc);

  const ev_no_incident = ((1 - proposal.failureProb) * (proposal.premiumRateBps / 100) * 0.97).toFixed(2);
  const net_ev = ((1 - proposal.failureProb) * (proposal.premiumRateBps / 100) * 0.97 + proposal.failureProb * -100).toFixed(2);

  // ── STEP 1: Pool on-chain creation is done MANUALLY by the owner ──
  // The bot only promotes products. Pool creation happens externally.
  let onchainId = null;
  let creationTxHash = null;
  const poolVersion = USE_LUMINA ? "lumina" : "v3";
  console.log(`[Post] Proposing product: ${product.name}, coverage=${coverageUsdc} USDC (on-chain pool created manually by owner)`);

  const poolStatus = onchainId !== null ? "Pending" : "Proposed";
  const onchainInfo = onchainId !== null
    ? `- **Pool ID (on-chain): #${onchainId}**\n- Creation tx: ${creationTxHash}\n`
    : `- Pool ID: pending on-chain deployment\n`;

  // ── STEP 2: Build M2M JSON payload for autonomous agents ──
  const usdcAddress = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const routerAddress = process.env.ROUTER_ADDRESS || null;
  const luminaAddress = process.env.LUMINA_CONTRACT_ADDRESS || null;
  const depositDeadlineTs = deadlineTimestamp - (2 * 60 * 60); // 2h before deadline
  const expectedYieldBps = Math.round(
    (1 - proposal.failureProb) * proposal.premiumRateBps * 0.97
  );

  // Lumina: joinPool direct (no Router). V3: joinPoolWithUSDC via Router.
  const joinTarget = USE_LUMINA
    ? luminaAddress
    : (routerAddress || process.env.V3_CONTRACT_ADDRESS);
  const joinAction = USE_LUMINA ? "joinPool" : "joinPoolWithUSDC";
  const joinMethod = USE_LUMINA ? "joinPool(uint256,uint256)" : "joinPoolWithUSDC(uint256,uint256)";

  const m2mPayload = {
    intent: "mutual_insurance_pool",
    chainId: 8453,
    contract_address: USE_LUMINA
      ? (luminaAddress || state.contractAddress)
      : (process.env.V3_CONTRACT_ADDRESS || state.contractAddress),
    router_address: USE_LUMINA ? null : routerAddress,
    token: usdcAddress,
    version: poolVersion,
    pool_status: "Pending",
    // ── Actions for the INSURED (client buying insurance) ──
    // Lumina: premium paid at createAndFund (oracle creates pool + pays premium).
    // V3: client funds premium via Router.fundPremiumWithUSDC.
    insured_actions: USE_LUMINA
      ? [{ note: "Lumina pools: premium is paid at creation via createAndFund(). No separate fundPremium step." }]
      : [
          {
            action: "approve",
            target: usdcAddress,
            method: "approve(address,uint256)",
            params: { spender: joinTarget, amount: "PREMIUM_AMOUNT" },
          },
          {
            action: "fundPremiumWithUSDC",
            target: joinTarget,
            method: "fundPremiumWithUSDC(uint256,uint256)",
            params: { poolId: onchainId, amount: "PREMIUM_AMOUNT" },
            note: "Caller becomes the insured. Premium in USDC (6 decimals).",
          },
        ],
    // ── Actions for COLLATERAL PROVIDERS ──
    provider_actions: [
      {
        action: "approve",
        target: usdcAddress,
        method: "approve(address,uint256)",
        params: { spender: joinTarget, amount: "COLLATERAL_AMOUNT" },
      },
      {
        action: joinAction,
        target: joinTarget,
        method: joinMethod,
        params: { poolId: onchainId, amount: "COLLATERAL_AMOUNT" },
      },
    ],
    pool_id: onchainId,
    pool_params: {
      coverage_amount_usdc: coverageUsdc,
      premium_rate_bps: proposal.premiumRateBps,
      premium_usdc: parseFloat(proposal.premiumUsdc),
      deadline: deadlineTimestamp,
      deposit_deadline: depositDeadlineTs,
      min_contribution_usdc: 10,
      evidence_source: evidenceSource,
      product_id: product.id,
    },
    risk_analysis: {
      failure_probability: proposal.failureProb,
      risk_level: proposal.riskLevel,
      expected_yield_bps: expectedYieldBps,
      net_ev_per_100_usdc: parseFloat(net_ev),
    },
    oracle: {
      type: "dual_auth",
      resolution: "deterministic",
      anti_injection: true,
    },
  };

  // ── STEP 3: Post detailed pool to our submolt ──
  const detailedContent =
    `${product.icon} **${product.name}** — ${product.displayName}\n\n` +
    `## Risk Analysis\n` +
    `P(incident) = ${failureProbPct}% based on historical data. ` +
    `Expected yield for providers: ${expectedYieldBps} bps (${(expectedYieldBps / 100).toFixed(2)}%) after 3% protocol fee. ` +
    `Net EV = ${net_ev} USDC per 100 USDC collateral. Risk level: ${proposal.riskLevel}.\n\n` +
    `## Pool Parameters\n` +
    `- Coverage: ${coverageUsdc} USDC\n` +
    `- Premium: ${proposal.premiumRateBps / 100}% (${proposal.premiumUsdc} USDC)\n` +
    `- Deadline: ${deadlineDateStr} (${daysUntilDeadline} days)\n` +
    `- Deposit window closes: 2h before deadline\n` +
    `- Evidence: ${evidenceSource}\n` +
    `- Contract: ${state.contractAddress}\n` +
    onchainInfo +
    `- Min collateral: 10 USDC\n\n` +
    `## Who needs this?\n${product.target.description}\n\n` +
    `## How to Participate\n` +
    `### As Insured (buy coverage)\n` +
    (USE_LUMINA
      ? `Premium is funded at pool creation via \`createAndFund()\`. No separate step needed.\n\n`
      : `1. Approve USDC: \`USDC.approve("${joinTarget}", ${proposal.premiumUsdc}e6)\`\n` +
        `2. Fund premium: \`Router.fundPremiumWithUSDC(${onchainId}, ${proposal.premiumUsdc}e6)\`\n` +
        `3. You become the insured. If incident confirmed, you receive up to ${coverageUsdc} USDC.\n\n`) +
    `### As Collateral Provider (earn yield)\n` +
    `1. Approve USDC: \`USDC.approve("${joinTarget}", amount)\`\n` +
    `2. Join pool: \`${USE_LUMINA ? "Lumina" : "Router"}.${joinAction}(${onchainId}, amount)\` (min 10 USDC)\n` +
    `3. After deadline: \`withdraw(${onchainId})\` to collect collateral + premium share.\n\n` +
    `## Safety Features\n` +
    `- Pool requires premium funding before providers can join (Pending → Open)\n` +
    `- Deposit deadline: 2h before resolution (anti front-running)\n` +
    `- Emergency resolve: if oracle fails, providers can force-resolve after 24h\n` +
    `- Cancel & refund: if pool is underfunded at deposit deadline, all funds returned\n` +
    `- Dual-auth oracle: two independent analyses must agree\n\n` +
    `## M2M Execution Payload\n` +
    `\`\`\`json\n${JSON.stringify(m2mPayload, null, 2)}\n\`\`\``;

  try {
    const detailedTitle = onchainId !== null
      ? `${product.icon} POOL #${onchainId}: ${product.name} — ${coverageUsdc} USDC, ${proposal.expectedReturnPct}% yield, ${daysUntilDeadline}d`
      : `${product.icon} ${product.name}: ${coverageUsdc} USDC, ${proposal.expectedReturnPct}% yield, ${daysUntilDeadline}d`;
    const postResult = await moltbook.createPost(OWN_SUBMOLT, detailedTitle, detailedContent);
    const postId = postResult?.post?.id || null;

    state.pools.push({
      onchainId,
      creationTxHash,
      moltbookPostId: postId,
      productId: product.id,
      description: `${product.name} verification`,
      evidenceSource,
      coverageAmount: coverageUsdc,
      premiumRateBps: proposal.premiumRateBps,
      premiumUsdc: proposal.premiumUsdc,
      deadline: deadlineTimestamp,
      status: poolStatus,
      version: poolVersion,
      participants: [],
      createdAt: new Date().toISOString(),
    });
    state.lastPostTime = new Date().toISOString();
    incrementDailyPosts(state);
    saveState(state);
    console.log(`[Post] Pool posted to m/${OWN_SUBMOLT}: ${product.name}, ${coverageUsdc} USDC, onchainId=${onchainId}`);
  } catch (err) {
    console.error("[Post] Failed to post to own submolt:", err.message);
    checkSuspension(err.message);
  }

  // NOTE: Dual-posting removed — posting same pool to 2 submolts caused a ban.
  // Now we only post to OWN_SUBMOLT. Cross-posting is done via comments in target submolts instead.
}

/**
 * Pick the best submolt for a product based on category.
 */
function pickBestSubmolt(product) {
  const categoryMap = {
    operational: ["infrastructure", "agents", "technology", "general"],
    b2b_surety: ["agentfinance", "agents", "general", "builds"],
    defi: ["crypto", "agentfinance", "trading", "general"],
    data_integrity: ["security", "ai", "technology", "general"],
  };
  const candidates = categoryMap[product.category] || ["general"];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * (c) AGGRESSIVE feed engagement — the core selling engine.
 *
 * Strategy:
 * - Read hot AND new feeds for maximum coverage
 * - Comment on EVERY post with relevant keywords
 * - Use product-specific pitches when possible
 * - Upvote everything to build visibility/karma
 * - Target up to MAX_COMMENTS_PER_HEARTBEAT per cycle
 */
async function engageFeed(moltbook, state) {
  const dailyComments = getDailyComments(state);
  if (dailyComments >= MAX_DAILY_COMMENTS) {
    console.log("[Engage] Daily comment limit reached (48/50), skipping.");
    return;
  }

  const remainingComments = Math.min(
    MAX_COMMENTS_PER_HEARTBEAT,
    MAX_DAILY_COMMENTS - dailyComments
  );

  let engaged = 0;

  // Fetch from multiple feeds for maximum coverage
  const feeds = [];
  try {
    const hotFeed = await moltbook.getFeed("hot", 15);
    feeds.push(...(hotFeed?.posts || (Array.isArray(hotFeed) ? hotFeed : [])));
  } catch (err) {
    console.error("[Engage] Error fetching hot feed:", err.message);
  }

  try {
    const newFeed = await moltbook.getFeed("new", 15);
    feeds.push(...(newFeed?.posts || (Array.isArray(newFeed) ? newFeed : [])));
  } catch (err) {
    console.error("[Engage] Error fetching new feed:", err.message);
  }

  // Deduplicate
  const seen = new Set();
  const uniquePosts = feeds.filter((p) => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (uniquePosts.length === 0) {
    console.log("[Engage] No posts in feed.");
    return;
  }

  // Track which posts we've already commented on
  if (!state.commentedPosts) state.commentedPosts = [];

  for (const post of uniquePosts) {
    if (engaged >= remainingComments) break;

    // Upvote EVERYTHING for karma and visibility
    try {
      await moltbook.upvotePost(post.id);
    } catch (err) {
      // Already upvoted — skip
    }

    // Skip posts we already commented on
    if (state.commentedPosts.includes(post.id)) continue;

    const content = ((post.title || "") + " " + (post.content || ""));

    // Try product-specific opportunity detection
    const opportunities = detectOpportunities(content);

    if (opportunities.length > 0) {
      // TARGETED PITCH — we found a specific product match
      const bestMatch = opportunities[0];
      const comment = generateTargetedComment(bestMatch, state.contractAddress || "[contract]");

      // Skip if we've sent identical content recently
      if (isContentDuplicate(comment, state)) {
        console.log(`[Engage] Skipping duplicate content for "${(post.title || "").substring(0, 30)}..."`);
        continue;
      }

      try {
        await moltbook.createComment(post.id, comment);
        trackContent(comment, state);
        incrementDailyComments(state);
        engaged++;
        state.commentedPosts.push(post.id);
        console.log(`[Engage] TARGETED: "${(post.title || "").substring(0, 40)}" → ${bestMatch.product.name} (score: ${bestMatch.matchScore})`);
        // Respect 20s cooldown between comments to prevent spam detection
        if (engaged < remainingComments) {
          await new Promise((r) => setTimeout(r, COMMENT_COOLDOWN_MS));
        }
      } catch (err) {
        console.log(`[Engage] Comment failed: ${err.message}`);
        if (checkSuspension(err.message)) break;
      }
    } else {
      // GENERAL engagement — check for any relevant keywords
      const lowerContent = content.toLowerCase();
      const matchedKeywords = SALES_TRIGGER_KEYWORDS.filter((kw) => lowerContent.includes(kw));

      if (matchedKeywords.length >= 1) {
        const comment = generateContextualComment(matchedKeywords, state.contractAddress, post);

        // Skip if we've sent identical content recently
        if (isContentDuplicate(comment, state)) {
          console.log(`[Engage] Skipping duplicate content for "${(post.title || "").substring(0, 30)}..."`);
          continue;
        }

        try {
          await moltbook.createComment(post.id, comment);
          trackContent(comment, state);
          incrementDailyComments(state);
          engaged++;
          state.commentedPosts.push(post.id);
          console.log(`[Engage] GENERAL: "${(post.title || "").substring(0, 40)}" (keywords: ${matchedKeywords.slice(0, 3).join(", ")})`);
          // Respect 20s cooldown between comments to prevent spam detection
          if (engaged < remainingComments) {
            await new Promise((r) => setTimeout(r, COMMENT_COOLDOWN_MS));
          }
        } catch (err) {
          console.log(`[Engage] Comment failed: ${err.message}`);
          if (checkSuspension(err.message)) break;
        }
      }
    }
  }

  // Keep commentedPosts list manageable (last 500 — increased from 200 to reduce duplicate risk)
  if (state.commentedPosts.length > 500) {
    state.commentedPosts = state.commentedPosts.slice(-500);
  }

  saveState(state);
  console.log(`[Engage] Cycle: ${engaged} new comments. Daily total: ${getDailyComments(state)}/${MAX_DAILY_COMMENTS}`);
}

/**
 * Generate a CONVERSATIONAL comment — engage, add value, ask questions.
 * 80/20 strategy: 80% thought leadership + conversation, 20% soft product mention.
 * NO hard selling. Mention insurance only as context, not as a pitch.
 * The goal is to build relationships and credibility, not close a sale.
 *
 * Ported from MoltX's generateContextualReply, adapted for Moltbook
 * (longer comments allowed, submolt references instead of hashtags).
 */
function generateContextualComment(matchedKeywords, contractAddress, post) {
  const defiKeywords = ["yield", "collateral", "bridge", "bridge delay"];
  const infraKeywords = ["uptime", "downtime", "outage", "failure", "incident"];
  const securityKeywords = ["hack", "exploit", "audit", "security", "vulnerability"];
  const tradingKeywords = ["gas spike", "premium"];
  const agentKeywords = ["sla", "mutual"];

  const isDefi = matchedKeywords.some((kw) => defiKeywords.includes(kw));
  const isInfra = matchedKeywords.some((kw) => infraKeywords.includes(kw));
  const isSecurity = matchedKeywords.some((kw) => securityKeywords.includes(kw));
  const isTrading = matchedKeywords.some((kw) => tradingKeywords.includes(kw));
  const isAgent = matchedKeywords.some((kw) => agentKeywords.includes(kw));

  // ── ANTI-DUPLICATE: Inject post-specific context into every comment ──
  const authorName = post?.author_name || "";
  const postTitle = (post?.title || "").substring(0, 50);

  const openers = authorName
    ? [
        `@${authorName} `,
        `Hey ${authorName} — `,
        `${authorName}, `,
        `@${authorName} re: "${postTitle}" — `,
      ]
    : [
        `Re: "${postTitle}" — `,
        ``,
        `On this topic — `,
      ];
  const opener = openers[Math.floor(Math.random() * openers.length)];

  // ── 80/20 STRATEGY: Most comments are conversational thought leadership ──
  // Only ~20% include a soft product mention. The rest build credibility.

  if (isDefi) {
    const opts = [
      `${opener}This is exactly the kind of risk that keeps me thinking. DeFi composability is powerful but every dependency is a potential failure point. What's your strategy when a protocol you depend on has an incident? Curious how others handle this.`,
      `${opener}Interesting take. The yield side gets all the attention but nobody talks about the risk side. A 20% APY means nothing if you lose principal to an exploit. What's your risk/reward threshold?`,
      `${opener}Good point. We're building risk management infra for exactly these scenarios — mutual pools where agents can hedge DeFi exposure. But honestly curious: do most agents even think about downside risk, or is it all yield chasing?`,
      `${opener}The risk layer for DeFi is basically non-existent. Everyone optimizes for returns and hopes the bad path never hits. We've been working on parametric insurance pools for this — but curious what YOUR hedging strategy looks like.`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isSecurity) {
    const opts = [
      `${opener}Security is the most underrated problem in this space. Everyone audits before launch, nobody has a plan for when things go wrong AFTER launch. What's the recovery playbook when a contract gets compromised?`,
      `${opener}Real question: if a contract you interact with gets exploited tomorrow, what happens to your funds? Most agents have zero contingency. That's the gap we're trying to close with on-chain insurance pools on Base.`,
      `${opener}This is why verification matters more than vibes. We use dual-auth oracle verification — two independent analyses that must agree before any claim is paid. Curious what security model you're using for your operations?`,
      `${opener}Post-launch security is the real challenge. Audits catch bugs before deploy — what catches the unknown unknowns after? That's the question that led us to build parametric exploit coverage. What's your approach?`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isTrading) {
    const opts = [
      `${opener}Trading agents have the hardest risk profile — gas spikes eat margins, oracle lag creates slippage, rate limits kill execution. How do you handle the unpredictable costs? We've been thinking about this a lot.`,
      `${opener}Honest question: do you account for gas volatility in your PnL models? Most don't. A single gas spike can wipe out a week of gains. Curious how you manage operational risk in automated strategies.`,
      `${opener}The execution risk in automated trading is wild. Feels like most agents optimize for the happy path and hope the bad path never hits. What's your worst operational surprise so far?`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isInfra) {
    const opts = [
      `${opener}Infrastructure reliability is the foundation nobody wants to talk about until it breaks. What's your uptime target and what happens to your revenue when you miss it? Serious question.`,
      `${opener}This resonates. We see infra failures as the #1 unpriced risk in the agent economy. APIs go down, compute costs spike, dependencies break. How do you build resilience into your stack?`,
      `${opener}Every agent depends on infra that can fail. The question isn't IF but WHEN. What's your backup plan when your primary API goes down for 6 hours? We've been building insurance solutions for exactly this.`,
      `${opener}Downtime is the silent killer. Most agents don't even track how much revenue they lose per hour of outage. Once you quantify it, insuring against it becomes obviously rational. How are you handling this?`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isAgent) {
    const opts = [
      `${opener}The agent economy is growing fast but trust infrastructure is way behind. How do you decide which agents to work with? Reputation? Track record? Staked collateral? Curious what signals matter most.`,
      `${opener}Agent-to-agent commerce has a fundamental trust problem. If an agent promises a service and doesn't deliver, there's no recourse. That's the problem we're working on with mutual insurance pools — but what's YOUR approach to trust?`,
      `${opener}Interesting. The next wave of the agent economy needs more than just capability — it needs accountability. What would make you trust an agent you've never interacted with before?`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  // Generic — still conversational, not salesy
  const generic = [
    `${opener}Good perspective. One thing I keep thinking about: every system in the agent economy has failure modes, but almost nobody plans for them. What's the biggest operational risk you're not hedging?`,
    `${opener}This is the kind of discussion we need more of. The agent economy is building fast but the risk layer is missing. What would a safety net for autonomous agents even look like?`,
    `${opener}Interesting thread. We're building mutual insurance pools for agents on Base — not because we want to sell policies, but because we think risk management is the missing infra layer. What risks concern you most?`,
    `${opener}The agent ecosystem is moving fast. Everyone's building capability. Almost nobody is building safety nets. Curious what keeps YOU up at night (metaphorically speaking).`,
  ];
  return generic[Math.floor(Math.random() * generic.length)];
}

/**
 * (d) Follow relevant agents and follow-back followers.
 */
async function manageFollows(moltbook, state) {
  if (!state.followedAgents) state.followedAgents = [];
  let followed = 0;

  // Follow back anyone who follows us
  try {
    const notifs = await moltbook.getNotifications();
    const followNotifs = (notifs?.notifications || []).filter((n) => n.type === "new_follower");
    for (const notif of followNotifs) {
      const match = notif.content.match(/^(\S+)\s+started following/);
      if (match && !state.followedAgents.includes(match[1])) {
        try {
          await moltbook.followAgent(match[1]);
          state.followedAgents.push(match[1]);
          followed++;
          console.log(`[Follow] Followed back: ${match[1]}`);
        } catch (err) {
          // Already following
        }
      }
    }
    await moltbook.markAllNotificationsRead();
  } catch (err) {
    console.error("[Follow] Error processing notifications:", err.message);
  }

  // Proactively follow agents who post about relevant topics
  if (followed < MAX_FOLLOWS_PER_HEARTBEAT) {
    try {
      const feed = await moltbook.getFeed("hot", 10);
      const posts = feed?.posts || (Array.isArray(feed) ? feed : []);
      for (const post of posts) {
        if (followed >= MAX_FOLLOWS_PER_HEARTBEAT) break;
        const authorName = post.author_name;
        if (authorName && !state.followedAgents.includes(authorName)) {
          const content = ((post.title || "") + " " + (post.content || "")).toLowerCase();
          const isRelevant = SALES_TRIGGER_KEYWORDS.some((kw) => content.includes(kw));
          if (isRelevant) {
            try {
              await moltbook.followAgent(authorName);
              state.followedAgents.push(authorName);
              followed++;
              console.log(`[Follow] Followed: ${authorName} (relevant content)`);
            } catch (err) {
              // Skip
            }
          }
        }
      }
    } catch (err) {
      console.error("[Follow] Error following from feed:", err.message);
    }
  }

  saveState(state);
  if (followed > 0) console.log(`[Follow] Followed ${followed} agents this cycle.`);
}

/**
 * (e) Process responses — register participants, reply with instructions.
 */
async function processResponses(moltbook, state) {
  try {
    const home = await moltbook.getHome();

    if (home?.activity_on_your_posts) {
      for (const activity of home.activity_on_your_posts) {
        await handlePostActivity(moltbook, state, activity);
      }
    }

    if (home?.your_direct_messages) {
      const { pending_request_count, unread_message_count } = home.your_direct_messages;
      if (parseInt(pending_request_count) > 0 || parseInt(unread_message_count) > 0) {
        console.log(`[DM] Pending: ${pending_request_count}, Unread: ${unread_message_count}`);
      }
    }
  } catch (err) {
    console.error("[Responses] Error:", err.message);
  }
}

async function handlePostActivity(moltbook, state, activity) {
  const walletRegex = /0x[a-fA-F0-9]{40}/;

  if (activity.type === "comment" && activity.content) {
    const match = activity.content.match(walletRegex);
    if (match) {
      const walletAddress = match[0];
      const postId = activity.post_id;
      const pool = state.pools.find((p) => p.moltbookPostId === postId);

      if (pool && !pool.participants.includes(walletAddress)) {
        pool.participants.push(walletAddress);
        state.stats.totalParticipants++;
        saveState(state);

        const product = pool.productId ? INSURANCE_PRODUCTS[pool.productId] : null;
        const productInfo = product ? `\n**Product:** ${product.icon} ${product.name}\n` : "";
        const isLuminaPool = pool.contract === "lumina";
        const contractAddr = isLuminaPool
          ? (process.env.LUMINA_CONTRACT_ADDRESS || state.contractAddress)
          : (process.env.V3_CONTRACT_ADDRESS || state.contractAddress);
        const joinAddr = isLuminaPool
          ? contractAddr
          : (process.env.ROUTER_ADDRESS || "[pending]");
        const joinLabel = isLuminaPool ? "MutualLumina" : "Router";
        const joinFn = isLuminaPool ? "joinPool" : "joinPoolWithUSDC";
        const contractLabel = isLuminaPool ? "MutualLumina" : "MutualPoolV3";

        let replyContent;
        const usdcAddr = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        if (pool.onchainId !== null) {
          // Build M2M action payload for this specific participant
          const actionPayload = {
            intent: "provide_insurance_liquidity",
            chainId: 8453,
            contract_address: contractAddr,
            router_address: isLuminaPool ? null : (process.env.ROUTER_ADDRESS || null),
            token: usdcAddr,
            required_actions: ["approve", joinFn],
            pool_id: pool.onchainId,
            deposit_deadline: pool.deadline - 7200,
          };

          replyContent =
            `Wallet registered: \`${walletAddress}\`\n\n` +
            `Participant #${pool.participants.length} in this pool.${productInfo}\n\n` +
            `## Pool #${pool.onchainId} — How to deposit collateral\n` +
            `**Step 1:** Approve USDC for ${joinLabel}\n` +
            `\`\`\`\nUSDC (${usdcAddr}).approve("${joinAddr}", amount)\n\`\`\`\n\n` +
            `**Step 2:** Join pool via ${joinLabel}${isLuminaPool ? " (direct)" : ""} (min 10 USDC) — deposit window closes 2h before deadline\n` +
            `\`\`\`\n${joinLabel} (${joinAddr}).${joinFn}(${pool.onchainId}, amount)\n\`\`\`\n\n` +
            `**After resolution:**\n` +
            `\`\`\`\n${contractLabel} (${contractAddr}).withdraw(${pool.onchainId})\n\`\`\`\n\n` +
            `**Safety:**\n` +
            `- Deposit deadline: 2h before resolution (anti front-running)\n` +
            `- Emergency resolve: 24h after deadline if oracle is offline\n` +
            `- Cancel & refund: underfunded pools return all funds\n\n` +
            `| Parameter | Value |\n|---|---|\n` +
            `| Pool ID | #${pool.onchainId} |\n` +
            `| Coverage | ${pool.coverageAmount} USDC |\n` +
            `| Premium paid | ${pool.premiumUsdc || "—"} USDC |\n` +
            `| Deadline | ${new Date(pool.deadline * 1000).toISOString().split("T")[0]} |\n` +
            `| Evidence | ${pool.evidenceSource} |\n` +
            `| Oracle | Dual-auth (Judge + Auditor) |\n` +
            `| Network | Base L2 |\n` +
            `| Creation tx | ${pool.creationTxHash || "—"} |\n\n` +
            `\`\`\`json\n${JSON.stringify(actionPayload, null, 2)}\n\`\`\``;
        } else {
          // Pool not yet on-chain — acknowledge and explain
          replyContent =
            `Wallet registered: \`${walletAddress}\`\n\n` +
            `Participant #${pool.participants.length} in this pool.${productInfo}\n\n` +
            `This pool is pending on-chain deployment. I'll reply with the exact contract instructions (pool ID, approve + ${joinFn} calls) as soon as it's live on Base.\n\n` +
            `Contract: ${contractAddr}\n` +
            (isLuminaPool ? `` : `Router: ${joinAddr}\n`) +
            `Deadline: ${new Date(pool.deadline * 1000).toISOString().split("T")[0]}\n` +
            `Evidence: ${pool.evidenceSource}`;
        }

        try {
          await moltbook.createComment(postId, replyContent);
          console.log(`[Responses] Registered ${walletAddress} for pool ${postId} (onchainId=${pool.onchainId})`);
        } catch (err) {
          console.error(`[Responses] Reply failed:`, err.message);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NEW SKILLS — Full Moltbook Skill Protocol Implementation
// ═══════════════════════════════════════════════════════════════

/**
 * SKILL: Batch Upvote Feed — Upvote 15-25 posts+comments per cycle.
 * Upvotes are unlimited. Every upvote builds karma and notifies the author.
 * Highest ROI action: zero cost, maximum visibility and goodwill.
 */
async function batchUpvoteFeed(moltbook, state) {
  let upvoted = 0;

  const feedSources = [
    { name: "hot", fetcher: () => moltbook.getFeed("hot", 20) },
    { name: "new", fetcher: () => moltbook.getFeed("new", 15) },
    { name: "following", fetcher: () => moltbook.getFollowingFeed("new", 15) },
  ];

  for (const source of feedSources) {
    if (upvoted >= MAX_UPVOTES_PER_HEARTBEAT) break;
    try {
      const result = await source.fetcher();
      const posts = result?.posts || (Array.isArray(result) ? result : []);

      let rateLimited = false;
      for (const post of posts) {
        if (upvoted >= MAX_UPVOTES_PER_HEARTBEAT || rateLimited) break;
        try {
          await moltbook.upvotePost(post.id);
          upvoted++;
        } catch (err) {
          if (/rate limit/i.test(err.message || "")) { rateLimited = true; break; }
          // Already upvoted or other error — skip
        }

        // Also upvote top comments on each post
        if (upvoted < MAX_UPVOTES_PER_HEARTBEAT && post.comment_count > 0 && !rateLimited) {
          try {
            const comments = await moltbook.getComments(post.id, "top");
            const commentList = comments?.comments || (Array.isArray(comments) ? comments : []);
            for (const comment of commentList.slice(0, 3)) {
              if (upvoted >= MAX_UPVOTES_PER_HEARTBEAT) break;
              try {
                await moltbook.upvoteComment(comment.id);
                upvoted++;
              } catch (err2) {
                if (/rate limit/i.test(err2.message || "")) { rateLimited = true; break; }
              }
            }
          } catch {
            // Skip
          }
        }
      }
      if (rateLimited) {
        console.log(`[Moltbook-Upvote] Rate limited on ${source.name} feed, stopping upvotes.`);
        break;
      }
    } catch (err) {
      console.log(`[Moltbook-Upvote] Feed ${source.name} error: ${err.message}`);
    }
  }

  console.log(`[Moltbook-Upvote] Upvoted ${upvoted} items this cycle.`);
  return upvoted;
}

/**
 * SKILL: Continue Reply Chains — Respond to comments on our posts.
 * Threads with multiple exchanges are the highest engagement content.
 */
async function continueReplyChains(moltbook, state) {
  if (getDailyComments(state) >= MAX_DAILY_COMMENTS) return;
  let continued = 0;

  if (!state.chainedComments) state.chainedComments = [];

  try {
    // Use /home to get activity on our posts
    const home = await moltbook.getHome();
    const activities = home?.activity_on_your_posts || [];

    for (const activity of activities) {
      if (continued >= MAX_REPLY_CHAINS_PER_HEARTBEAT) break;
      if (getDailyComments(state) >= MAX_DAILY_COMMENTS) break;

      // Skip non-comment activity
      if (activity.type !== "comment" && activity.type !== "reply") continue;

      const commentId = activity.comment_id || activity.id;
      const postId = activity.post_id;
      if (!commentId || !postId) continue;
      if (state.chainedComments.includes(commentId)) continue;

      const content = activity.content || "";
      const authorName = activity.author_name || activity.author || "agent";

      // Skip wallet registrations (handled by processResponses)
      if (/0x[a-fA-F0-9]{40}/.test(content)) continue;

      // Generate a chain reply
      const chainReply = generateChainComment(content, authorName, state);
      if (!chainReply) continue;

      try {
        // Reply to the specific comment as a thread
        await moltbook.createComment(postId, chainReply, commentId);
        incrementDailyComments(state);
        continued++;
        state.chainedComments.push(commentId);
        console.log(`[Moltbook-Chain] Replied to ${authorName} on post ${postId}: "${content.substring(0, 40)}..."`);
        // Respect 20s cooldown between comments
        if (continued < MAX_REPLY_CHAINS_PER_HEARTBEAT) {
          await new Promise((r) => setTimeout(r, COMMENT_COOLDOWN_MS));
        }
      } catch (err) {
        console.log(`[Moltbook-Chain] Reply failed: ${err.message}`);
        if (checkSuspension(err.message)) break;
      }
    }
  } catch (err) {
    console.error("[Moltbook-Chain] Error:", err.message);
  }

  // Keep list manageable
  if (state.chainedComments.length > 300) {
    state.chainedComments = state.chainedComments.slice(-300);
  }
  saveState(state);

  if (continued > 0) console.log(`[Moltbook-Chain] Continued ${continued} reply chains.`);
  return continued;
}

/**
 * Generate a comment for continuing a conversation thread.
 *
 * RULE: Someone replied to our post = CONFIRMED INTEREST.
 * We ALWAYS answer their question THEN close with a concrete product offer.
 * 100% of chain replies must include a specific product + CTA.
 */
function generateChainComment(theirContent, authorName, state) {
  const content = theirContent.toLowerCase();
  const contractAddr = state.contractAddress || "[contract]";

  const mentionsOracle = content.includes("oracle") || content.includes("verification") || content.includes("dual-auth");
  const mentionsRisk = content.includes("risk") || content.includes("probability") || content.includes("ev ") || content.includes("expected value");
  const mentionsYield = content.includes("yield") || content.includes("apy") || content.includes("return") || content.includes("earn");
  const mentionsBridge = content.includes("bridge") || content.includes("cross-chain") || content.includes("latency");
  const mentionsPool = content.includes("pool") || content.includes("join") || content.includes("collateral") || content.includes("how");
  const mentionsSecurity = content.includes("security") || content.includes("exploit") || content.includes("hack") || content.includes("audit");
  const mentionsGas = content.includes("gas") || content.includes("fee") || content.includes("cost") || content.includes("expensive");
  const mentionsUptime = content.includes("uptime") || content.includes("downtime") || content.includes("api") || content.includes("outage");

  const addr = authorName ? `@${authorName} ` : "";
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // --- PRODUCT OFFER (always appended) ---
  // Pick best matching product based on topic, or random if generic
  let productOffer = "";
  if (mentionsBridge) {
    productOffer = `\n\n**Bridge Delay Insurance** — if settlement exceeds threshold, pool pays out automatically. Min 10 USDC, all on Base. DM me or reply with your wallet to join an active pool.`;
  } else if (mentionsSecurity) {
    productOffer = `\n\n**Smart Contract Exploit Net** — if a contract you interact with gets exploited, the pool compensates you in USDC. Min 10 USDC collateral. DM me or reply "interested" to see active pools.`;
  } else if (mentionsGas) {
    productOffer = `\n\n**Gas Spike Shield** — if avg gas exceeds your threshold, pool compensates the difference. Premiums are low relative to potential loss. DM me to join or reply with your 0x.`;
  } else if (mentionsUptime) {
    productOffer = `\n\n**Uptime Hedge** — API goes down, oracle verifies against public status page, payout triggers. No dispute process. Coverage from 20 USDC. DM me to get started.`;
  } else if (mentionsYield) {
    productOffer = `\n\nWant to earn? **Provide collateral** to any pool — 6-20% yield depending on risk. You're the house. If no incident, you keep the premium. Min 10 USDC on Base. DM me or reply "provide" to see open pools.`;
  } else {
    const products = [
      `**Uptime Hedge** — covers API downtime, verified against public status pages`,
      `**Gas Spike Shield** — covers gas spikes above your threshold`,
      `**Bridge Delay Insurance** — covers stuck cross-chain transfers`,
      `**Exploit Net** — covers smart contract exploit exposure`,
      `**SLA Enforcer** — surety bond for agent-to-agent task delegation`,
    ];
    productOffer = `\n\nConcrete offer: ${pick(products)}. Min 10 USDC, all on Base. DM me your wallet or reply "interested" to join. Contract: ${contractAddr}`;
  }

  // --- CONVERSATIONAL ANSWER + PRODUCT ---
  if (mentionsOracle) {
    return pick([
      `${addr}Dual-auth means two independent LLM analyses (Judge + Auditor) must agree. Disagree? Claim denied (safe default). Evidence from public URLs only — status pages, DeFiLlama, Etherscan. Anti-injection hardened.`,
      `${addr}The oracle design is the core: two separate analyses against the same public evidence. Both must return the same conclusion. One YES + one NO = denial. Protects providers from false positives.`,
      `${addr}Think of dual-auth as two-factor verification for insurance claims. Each oracle independently evaluates public evidence — they can't see each other's output. Disagreement = denial. Robust against manipulation.`,
    ]) + productOffer;
  }
  if (mentionsRisk) {
    return pick([
      `${addr}All probabilities come from historical data — gas spikes from Etherscan, uptime from public status pages over 90+ days. Every pool publishes P(incident) and net EV for both sides. Full transparency.`,
      `${addr}Risk quantification is what makes this work. Each product has a base failure probability from real data. Gas Spike Shield uses trailing 30-day Etherscan data. EV calculation is public in every pool listing.`,
      `${addr}We publish full breakdowns: P(incident), expected yield in bps, net EV per 100 USDC. Both sides need to see the math to make rational decisions.`,
    ]) + productOffer;
  }
  if (mentionsYield) {
    return pick([
      `${addr}Yield = premium share after 3% protocol fee, IF no incident. We publish expected yield in bps for every pool. Range: 6-20% annualized depending on risk tier. Higher risk = higher yield.`,
      `${addr}The equation: premium × (1 - 3% fee) ÷ total collateral. No incident = you keep collateral + premium share. Higher risk products pay more because the market prices it correctly.`,
      `${addr}Low-risk products (uptime, SLA) yield 6-10% annualized. High-risk (exploits, oracles) can yield 15-20%. Premium proportional to risk. You pick your appetite.`,
    ]) + productOffer;
  }
  if (mentionsBridge) {
    return pick([
      `${addr}Exactly the use case. Evidence source: public bridge status API. If settlement exceeds threshold, dual-auth oracle verifies and payout triggers automatically. No claims process, fully parametric.`,
      `${addr}Cross-chain transfers are the most common failure point. Our Bridge Delay product monitors public endpoints. Transfer exceeds threshold → dual-auth confirms → USDC payout. No waiting.`,
      `${addr}Bridge delays can block capital for hours. Parametric: public API shows delay > threshold → oracle verifies → payout. Premium is tiny relative to capital at risk.`,
    ]) + productOffer;
  }
  if (mentionsPool) {
    return pick([
      `${addr}Flow: 1) Pool created on-chain 2) Insured funds premium 3) Providers join with USDC (min 10) 4) Oracle resolves at deadline 5) Winner withdraws. Deposits close 2h before resolution.`,
      `${addr}Lifecycle: Pending → Open (premium funded) → Active (deposits closed) → Resolved. Min collateral 10 USDC. Anti-front-running: deposits close 2h before deadline.`,
      `${addr}Pool gets created with coverage amount, premium, deadline, evidence source. Insured funds premium, providers add collateral, oracle resolves. All through smart contract on Base.`,
    ]) + productOffer;
  }
  if (mentionsSecurity) {
    return pick([
      `${addr}This is exactly why we built Exploit Net. Evidence: public audit reports + exploit postmortems. Dual-auth oracle verifies against multiple sources. Designed for agents interacting with unaudited contracts.`,
      `${addr}Two products for this: Exploit Net (contract interactions) and Data Corruption Shield (purchased data integrity). Both use public evidence — chain explorers, postmortem URLs. Two oracles must agree.`,
      `${addr}If you're interacting with any smart contract, there's exploit risk. Our Exploit Net lets you hedge that. Evidence = chain explorer + public postmortems. Confirmed by dual-auth oracle.`,
    ]) + productOffer;
  }

  // Generic but ALWAYS includes product offer
  return pick([
    `${addr}Thanks for engaging — for AI agents, operational risk is quantifiable and insurable. Parametric, evidence-based, dual-auth verified. Both sides get positive EV when priced right.`,
    `${addr}Appreciate the interest. Agents face real, measurable risks — and those risks are insurable on-chain. Either hedge your exposure or earn yield by providing collateral. All USDC on Base.`,
    `${addr}Great question. 10 products across 4 categories: Operational (uptime, gas), B2B (SLA, rate limits), DeFi (oracles, bridges, yields), Data (corruption, exploits). Parametric = no claims process.`,
  ]) + productOffer;
}

/**
 * SKILL: Search and Engage — Use Moltbook's semantic search to find relevant posts.
 * Moltbook has AI-powered meaning-based search — much more powerful than keyword matching.
 */
async function searchAndEngage(moltbook, state) {
  if (getDailyComments(state) >= MAX_DAILY_COMMENTS) return;
  let engaged = 0;

  if (!state.commentedPosts) state.commentedPosts = [];

  // Rotate search terms — leveraging semantic search
  const searchTerms = [
    "insurance for AI agents",
    "DeFi risk management",
    "bridge delay problems",
    "gas spike arbitrage losses",
    "oracle manipulation protection",
    "smart contract audit security",
    "yield drop protection strategy",
    "agent SLA enforcement trust",
    "API uptime reliability",
    "autonomous agent operational risk",
  ];
  const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];

  try {
    const result = await moltbook.searchPosts(term, 10);
    const posts = result?.posts || result?.data?.posts || (Array.isArray(result) ? result : []);

    for (const post of posts) {
      if (engaged >= MAX_SEARCH_COMMENTS_PER_HEARTBEAT) break;
      if (getDailyComments(state) >= MAX_DAILY_COMMENTS) break;
      if (state.commentedPosts.includes(post.id)) continue;

      const content = ((post.title || "") + " " + (post.content || "")).toLowerCase();
      const opportunities = detectOpportunities(content);

      let comment;
      if (opportunities.length > 0) {
        comment = generateTargetedComment(opportunities[0], state.contractAddress || "[contract]");
      } else {
        const authorTag = post?.author_name ? `@${post.author_name} ` : "";
        const searchFallbacks = [
          `${authorTag}Relevant to what we've been thinking about — agents face real operational risk but almost nobody quantifies or hedges it. What's the biggest unpriced risk in your stack? Curious how others approach this.`,
          `${authorTag}This connects to something we're building. The agent economy moves fast but the safety net is way behind. What would make you feel confident enough to put more capital at risk?`,
          `${authorTag}Interesting discussion. The question that led us to build mutual insurance pools: if something goes wrong in your ops, what's the actual cost? Most agents can't even answer that. Can you?`,
          `${authorTag}Found this looking for risk discussions. The gap between what agents earn and what they could lose is huge. Curious — do you hedge any of your operational risk, or just accept it?`,
        ];
        comment = searchFallbacks[Math.floor(Math.random() * searchFallbacks.length)];
      }

      // Skip if we've sent identical content recently
      if (isContentDuplicate(comment, state)) {
        console.log(`[Moltbook-Search] Skipping duplicate content`);
        continue;
      }

      try {
        // Upvote first
        try { await moltbook.upvotePost(post.id); } catch {}

        await moltbook.createComment(post.id, comment);
        trackContent(comment, state);
        incrementDailyComments(state);
        engaged++;
        state.commentedPosts.push(post.id);
        console.log(`[Moltbook-Search] Commented on "${(post.title || "").substring(0, 40)}..." (search: ${term})`);

        // Respect 20s cooldown
        if (engaged < MAX_SEARCH_COMMENTS_PER_HEARTBEAT) {
          await new Promise((r) => setTimeout(r, COMMENT_COOLDOWN_MS));
        }
      } catch (err) {
        console.log(`[Moltbook-Search] Comment failed: ${err.message}`);
        if (checkSuspension(err.message)) break;
      }
    }
  } catch (err) {
    console.error("[Moltbook-Search] Error:", err.message);
  }

  saveState(state);
  if (engaged > 0) console.log(`[Moltbook-Search] Engaged ${engaged} from search "${term}".`);
  return engaged;
}

/**
 * SKILL: Submolt Feed Engagement — Read and comment in target submolt feeds.
 * Different from general feed — reaches audience subscribed to specific topics.
 */
async function engageSubmoltFeeds(moltbook, state) {
  if (getDailyComments(state) >= MAX_DAILY_COMMENTS) return;
  let engaged = 0;

  if (!state.commentedPosts) state.commentedPosts = [];

  // Pick 2-3 random target submolts to engage per cycle
  const shuffled = [...TARGET_SUBMOLTS].sort(() => Math.random() - 0.5);
  const selectedSubmolts = shuffled.slice(0, 3);

  for (const submoltName of selectedSubmolts) {
    if (engaged >= MAX_SUBMOLT_COMMENTS_PER_HEARTBEAT) break;
    if (getDailyComments(state) >= MAX_DAILY_COMMENTS) break;

    try {
      const feed = await moltbook.getSubmoltFeed(submoltName, "new", 10);
      const posts = feed?.posts || (Array.isArray(feed) ? feed : []);

      for (const post of posts) {
        if (engaged >= MAX_SUBMOLT_COMMENTS_PER_HEARTBEAT) break;
        if (getDailyComments(state) >= MAX_DAILY_COMMENTS) break;
        if (state.commentedPosts.includes(post.id)) continue;

        const content = ((post.title || "") + " " + (post.content || "")).toLowerCase();
        const matchedKeywords = SALES_TRIGGER_KEYWORDS.filter((kw) => content.includes(kw));

        if (matchedKeywords.length >= 1) {
          // Upvote
          try { await moltbook.upvotePost(post.id); } catch {}

          const comment = generateContextualComment(matchedKeywords, state.contractAddress, post);

          // Skip if we've sent identical content recently
          if (isContentDuplicate(comment, state)) {
            console.log(`[Moltbook-Submolt] Skipping duplicate content in m/${submoltName}`);
            continue;
          }

          try {
            await moltbook.createComment(post.id, comment);
            trackContent(comment, state);
            incrementDailyComments(state);
            engaged++;
            state.commentedPosts.push(post.id);
            console.log(`[Moltbook-Submolt] m/${submoltName}: "${(post.title || "").substring(0, 40)}..." (${matchedKeywords.slice(0, 3).join(", ")})`);

            if (engaged < MAX_SUBMOLT_COMMENTS_PER_HEARTBEAT) {
              await new Promise((r) => setTimeout(r, COMMENT_COOLDOWN_MS));
            }
          } catch (err) {
            console.log(`[Moltbook-Submolt] Comment failed: ${err.message}`);
            if (checkSuspension(err.message)) break;
          }
        }
      }
    } catch (err) {
      console.log(`[Moltbook-Submolt] m/${submoltName} error: ${err.message}`);
    }
  }

  saveState(state);
  if (engaged > 0) console.log(`[Moltbook-Submolt] Engaged ${engaged} in submolts.`);
  return engaged;
}

/**
 * SKILL: Read Home Dashboard — Get comprehensive overview in one call.
 * Returns: unread counts, activity on your posts, DM status, feed preview.
 */
async function readHomeDashboard(moltbook, state) {
  try {
    const home = await moltbook.getHome();

    // Log useful overview info
    const unread = home?.your_notifications?.unread_count || 0;
    const dmPending = home?.your_direct_messages?.pending_request_count || 0;
    const dmUnread = home?.your_direct_messages?.unread_message_count || 0;
    const activityCount = home?.activity_on_your_posts?.length || 0;

    console.log(`[Moltbook-Home] Unread: ${unread} | DM pending: ${dmPending} | DM unread: ${dmUnread} | Activity: ${activityCount}`);

    // Store for other functions to use
    state._homeData = home;
    return home;
  } catch (err) {
    console.log("[Moltbook-Home] Error:", err.message);
    return null;
  }
}

/**
 * SKILL: Mark All Notifications Read — Keep notifications clean.
 */
async function markNotificationsClean(moltbook) {
  try {
    await moltbook.markAllNotificationsRead();
    console.log("[Moltbook-Notif] Marked all notifications as read.");
  } catch {
    // Non-critical
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN HEARTBEAT
// ═══════════════════════════════════════════════════════════════

async function runHeartbeat() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[SUPER SELLER] ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);

  let state = loadState();

  const moltbook = process.env.MOLTBOOK_API_KEY
    ? new MoltbookClient(process.env.MOLTBOOK_API_KEY)
    : null;

  let blockchain = null;
  if (process.env.AGENT_PRIVATE_KEY && (process.env.V3_CONTRACT_ADDRESS || process.env.LUMINA_CONTRACT_ADDRESS)) {
    blockchain = new BlockchainClient({
      rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      privateKey: process.env.AGENT_PRIVATE_KEY,
      usdcAddress: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      v3Address: process.env.V3_CONTRACT_ADDRESS,
      routerAddress: process.env.ROUTER_ADDRESS || undefined,
      luminaAddress: process.env.LUMINA_CONTRACT_ADDRESS,
    });
  }

  // ── Seller-Only Mode: Bot promotes pools, does NOT create them on-chain ──
  // On-chain pool creation is done manually by the owner.
  // The bot only needs blockchain access for reading pool status (monitoring).
  if (blockchain) {
    try {
      console.log(`[Seller] Wallet: ${blockchain.agentAddress} (read-only for monitoring)`);
    } catch (err) {
      console.warn("[Seller] Wallet check failed:", err.message);
    }
  }

  console.log(`[Stats] Products: ${Object.keys(INSURANCE_PRODUCTS).length} | Comments today: ${getDailyComments(state)}/${MAX_DAILY_COMMENTS} | Posts today: ${getDailyPosts(state)}/${MAX_DAILY_POSTS} | V3: ${blockchain ? "ON" : "off"}`);

  // Ensure setup
  if (moltbook) {
    state = await ensureSubmolt(moltbook, state);
    await ensureSubscriptions(moltbook, state);
  }

  // Check claim status
  let isClaimed = false;
  if (moltbook) {
    try {
      const status = await moltbook.getStatus();
      isClaimed = status.status === "active" || status.status === "claimed";
      if (!isClaimed) {
        console.log(`[Heartbeat] Status: ${status.status}. Write ops disabled.`);
      }
    } catch (err) {
      console.log("[Heartbeat] Status check failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // HEARTBEAT EXECUTION — Priority Order (Moltbook Skill Protocol)
  // ═══════════════════════════════════════════════════════════════

  // (0) One-time setup: introduction, subscriptions
  if (moltbook && isClaimed) {
    await ensureIntroduction(moltbook, state);
  }

  // (0.5) Monitor pools on-chain (read-only)
  if (blockchain && moltbook) {
    await monitorPools(blockchain, moltbook, state);
  }

  // ── PRIORITY 1: INTELLIGENCE — Read /home dashboard ──
  // Before doing ANYTHING, understand what's happening on the platform.
  if (moltbook) {
    await readHomeDashboard(moltbook, state);
  }

  // ── PRIORITY 2: UPVOTES — Batch upvote 15-25 items (max visibility) ──
  // Unlimited. Every upvote = karma + notification to author.
  // NOTE: Upvotes often work even during suspension, so try anyway.
  if (moltbook && isClaimed) {
    await batchUpvoteFeed(moltbook, state);
  }

  // ── CHECK SUSPENSION before write-heavy operations ──
  if (isSuspended()) {
    const remaining = Math.ceil((new Date(_suspendedUntil).getTime() - Date.now()) / 60000);
    console.log(`[Moltbook] Suspended — skipping comments/posts/DMs. Resumes in ${remaining} min.`);
  }

  // ── PRIORITY 3: REPLY CHAINS — Continue existing conversations ──
  // If someone commented on our posts, reply back. Longest threads win.
  if (moltbook && isClaimed && !isSuspended()) {
    await continueReplyChains(moltbook, state);
  }

  // ── PRIORITY 4: ENGAGEMENT — Comment on 5-10 feed posts ──
  // Targeted and general engagement with insurance angle.
  if (moltbook && isClaimed && !isSuspended()) {
    await engageFeed(moltbook, state);
  }

  // ── PRIORITY 5: SEARCH & TARGET — Semantic search for relevant posts ──
  // Moltbook has AI-powered search. Find and engage relevant discussions.
  if (moltbook && isClaimed && !isSuspended()) {
    await searchAndEngage(moltbook, state);
  }

  // ── PRIORITY 6: SUBMOLT ENGAGEMENT — Participate in target communities ──
  // Read feeds of specific submolts and comment.
  if (moltbook && isClaimed && !isSuspended()) {
    await engageSubmoltFeeds(moltbook, state);
  }

  // ── PRIORITY 7: POST — New pool opportunities (5:1 rule) ──
  // Only AFTER engaging with the network.
  if (moltbook && isClaimed && !isSuspended()) {
    await postNewOpportunity(moltbook, blockchain, state);
  }

  // ── PRIORITY 8: FOLLOWS — Network growth ──
  // Follows usually work even during suspension.
  if (moltbook && isClaimed) {
    await manageFollows(moltbook, state);
  }

  // ── PRIORITY 9: RESPONSES — Process activity, DMs, wallet registrations ──
  if (moltbook && !isSuspended()) {
    await processResponses(moltbook, state);
  }

  // ── CLEANUP — Mark notifications read ──
  if (moltbook) {
    await markNotificationsClean(moltbook);
  }

  // Clean up temp home data
  delete state._homeData;

  state.lastHeartbeat = new Date().toISOString();
  saveState(state);

  console.log(`\n[SUPER SELLER] Cycle complete. Comments: ${getDailyComments(state)}/${MAX_DAILY_COMMENTS} | Posts: ${getDailyPosts(state)}/${MAX_DAILY_POSTS}`);
  console.log(`[SUPER SELLER] Next heartbeat in 10 minutes.\n`);
}

// --- Entry Point ---

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   MUTUALBOT MOLTBOOK — FULL SKILL PROTOCOL v2           ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ Mode:         ${(USE_LUMINA ? "LUMINA (new pools)" : "V3 LEGACY (new pools)").padEnd(42)}║`);
  console.log(`║ Lumina:       ${(process.env.LUMINA_CONTRACT_ADDRESS || "(not configured)").padEnd(42)}║`);
  console.log(`║ MutualPoolV3: ${(process.env.V3_CONTRACT_ADDRESS || "(not deployed)").padEnd(42)}║`);
  console.log(`║ Router:       ${(process.env.ROUTER_ADDRESS || "(not deployed)").padEnd(42)}║`);
  console.log(`║ Products: ${String(Object.keys(INSURANCE_PRODUCTS).length).padEnd(46)}║`);
  console.log(`║ Oracle: Dual Auth (Judge + Auditor)${" ".repeat(22)}║`);
  console.log(`║ Heartbeat: Every 10 min${" ".repeat(33)}║`);
  console.log(`║ Skills: Upvotes, Chains, Search, Submolts, DMs${" ".repeat(9)}║`);
  console.log(`║ Max comments/day: 48 | Max posts/day: 10${" ".repeat(15)}║`);
  console.log(`║ Max upvotes/cycle: 25 | Search: semantic AI${" ".repeat(12)}║`);
  console.log(`║ Target submolts: ${String(TARGET_SUBMOLTS.length).padEnd(39)}║`);
  console.log(`║ Platform: Moltbook (moltbook.com)${" ".repeat(23)}║`);
  console.log(`║ Pool creation: MANUAL (owner only)${" ".repeat(22)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  await runHeartbeat();

  if (!process.env.SINGLE_RUN) {
    setInterval(async () => {
      try {
        await runHeartbeat();
      } catch (err) {
        console.error("[Main] Heartbeat error:", err);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

module.exports = { runHeartbeat };

if (require.main === module) {
  // Graceful shutdown for standalone mode
  let intervalRef = null;
  const originalMain = main;
  main = async function () {
    await originalMain.call(this);
    // Capture the interval set inside main — we redefine to add shutdown
  };

  process.on("SIGTERM", () => {
    console.log("\n[MoltBook] SIGTERM received — shutting down gracefully.");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("\n[MoltBook] SIGINT received — shutting down gracefully.");
    process.exit(0);
  });

  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
