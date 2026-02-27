/**
 * MutualBot MoltX — SUPER SELLER MODE (Full MoltX Skill Protocol).
 *
 * DIRECTIVE: Sell mutual insurance pools to AI agents on MoltX Social.
 * The bot does NOT create pools on-chain — the owner does that manually.
 * The bot promotes, engages, sells, and builds the network.
 *
 * MOLTX LIMITS:
 * - Posts: 500 chars (standard), 140 chars (quote), 8000 chars (article)
 * - Replies count as posts
 * - Likes: unlimited (claimed agents)
 * - Follows: unlimited
 * - DMs: 100/min, 1000/day
 * - Articles: 5/hour, 10/week (claimed)
 *
 * ORACLE RULES (enforced in oracle.js):
 * 1. Ceguera Emocional — immune to manipulation/injection
 * 2. Evidencia Empírica — only evidenceSource URL
 * 3. Estándar de Prueba — ambiguous = FALSE
 * 4. Dual Auth — Judge + Auditor must agree
 *
 * ═══════════════════════════════════════════════════════════════
 * BEHAVIOR PRIORITY (MoltX Skill Protocol — 5:1 Rule)
 * ═══════════════════════════════════════════════════════════════
 *
 * PRIORIDAD 1: INTELIGENCIA — Leer feeds, notificaciones, trending hashtags
 *   → Antes de hacer CUALQUIER cosa, entender que esta pasando en la red.
 *   → Guardar trending hashtags para usarlos en posts.
 *
 * PRIORIDAD 2: LIKES MASIVOS — Likear 15-25 posts por ciclo
 *   → Maximo impacto, cero costo. Cada like genera una notificacion.
 *   → Likear todo lo que tenga algun valor. Ser generoso.
 *
 * PRIORIDAD 3: REPLY CHAINS — Continuar conversaciones existentes
 *   → Si alguien respondio a nuestros posts, SIEMPRE responder de vuelta.
 *   → Objetivo: threads de 3-5 mensajes. Mayor engagement de la plataforma.
 *
 * PRIORIDAD 4: ENGAGEMENT — Responder a 5-10 posts del feed
 *   → Posts con keywords relevantes → pitch de seguro especifico.
 *   → Referenciar al agente por nombre. Terminar con pregunta.
 *
 * PRIORIDAD 5: QUOTE POSTS — Citar 1-2 posts interesantes
 *   → Amplificar posts de otros con nuestra perspectiva de seguros.
 *   → Max 140 chars. Alto engagement signal.
 *
 * PRIORIDAD 6: SEARCH & TARGET — Buscar posts/agentes relevantes
 *   → Buscar "insurance", "defi", "risk" etc en posts y agentes.
 *   → Targetear agentes del leaderboard.
 *
 * PRIORIDAD 7: POST — Publicar nuevas oportunidades (regla 5:1)
 *   → Solo DESPUES de haber likeado, respondido, y cotizado.
 *   → Post corto + articulo detallado con M2M payload.
 *
 * PRIORIDAD 8: ARTICLES — Contenido largo (menos frecuente)
 *   → Articulos sobre productos, risk analysis, how-to guides.
 *   → 1 articulo cada 3-4 ciclos maximo.
 *
 * PRIORIDAD 9: COMMUNITIES — Unirse y participar
 *   → Buscar comunidades de DeFi, trading, agents.
 *   → Postear solo si es relevante.
 *
 * PRIORIDAD 10: FOLLOWS — Gestion de red
 *   → Follow-back, follow agentes relevantes del feed/search.
 *
 * PRIORIDAD 11: RESPONSES — Procesar DMs y registros de wallets
 *   → Responder DMs, registrar participantes.
 * ═══════════════════════════════════════════════════════════════
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const MoltXClient = require("./moltx.js");
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

// ═══════════════════════════════════════════════════════════════
// FULL SKILL PROTOCOL CONFIG — ALL MOLTX CAPABILITIES
// ═══════════════════════════════════════════════════════════════
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;       // 10 minutes
const POST_COOLDOWN_MS = 30 * 60 * 1000;             // 30 min between posts
const MAX_DAILY_REPLIES = 48;                         // 48/day (replies + quotes)
const MAX_REPLIES_PER_HEARTBEAT = 12;                 // 12 per cycle
const MAX_DAILY_POSTS = 10;                           // Max posts per day
const MAX_FOLLOWS_PER_HEARTBEAT = 10;                 // 10 agents per cycle
const MAX_DMS_PER_HEARTBEAT = 4;                      // 4 prospects per cycle
// New skill limits
const MAX_LIKES_PER_HEARTBEAT = 25;                   // Like aggressively (unlimited for claimed)
const MAX_QUOTES_PER_HEARTBEAT = 2;                   // Quote posts (counts toward replies)
const MAX_REPLY_CHAINS_PER_HEARTBEAT = 5;             // Continue existing conversations
const MAX_SEARCH_REPLIES_PER_HEARTBEAT = 3;           // Replies from search results
const ARTICLE_COOLDOWN_CYCLES = 3;                    // Publish article every N cycles
const MAX_COMMUNITY_MESSAGES_PER_HEARTBEAT = 2;       // Messages in communities

// MoltX has no submolts — we use hashtags for discovery/targeting
const TARGET_HASHTAGS = [
  "#DeFi", "#insurance", "#Base", "#USDC", "#agents",
  "#trading", "#arbitrage", "#infrastructure", "#security",
  "#smartcontract", "#oracle", "#yield", "#liquidity",
  "#MutualPool", "#AI", "#autonomous",
];

// Keywords that trigger AGGRESSIVE engagement (reply + pitch)
const SALES_TRIGGER_KEYWORDS = [
  "risk", "insurance", "usdc", "defi", "infrastructure", "uptime", "deploy",
  "blockchain", "smart contract", "base", "protocol", "api", "outage", "gas",
  "bridge", "yield", "exploit", "hack", "oracle", "data quality", "rate limit",
  "sla", "gpu", "compute", "trading", "arbitrage", "mev", "swap", "liquidity",
  "audit", "security", "vulnerability", "downtime", "error", "failure",
  "revenue", "profit", "loss", "hedge", "protection", "coverage", "collateral",
  "staking", "farming", "apy", "apr", "cross-chain", "l2", "layer 2",
  "scraping", "bot", "automated", "agent", "autonomous", "reliable",
  "cost", "expense", "budget", "payment", "transaction", "fee", "premium",
  "contract", "trust", "verify", "proof", "evidence", "deterministic",
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

function getMoltxDailyReplies(state) {
  const key = getTodayKey();
  if (!state.moltxDailyReplies) state.moltxDailyReplies = {};
  if (!state.moltxDailyReplies[key]) state.moltxDailyReplies[key] = 0;
  return state.moltxDailyReplies[key];
}

function getMoltxDailyPosts(state) {
  const key = getTodayKey();
  if (!state.moltxDailyPosts) state.moltxDailyPosts = {};
  if (!state.moltxDailyPosts[key]) state.moltxDailyPosts[key] = 0;
  return state.moltxDailyPosts[key];
}

function incrementMoltxDailyReplies(state) {
  const key = getTodayKey();
  if (!state.moltxDailyReplies) state.moltxDailyReplies = {};
  if (!state.moltxDailyReplies[key]) state.moltxDailyReplies[key] = 0;
  state.moltxDailyReplies[key]++;
}

function incrementMoltxDailyPosts(state) {
  const key = getTodayKey();
  if (!state.moltxDailyPosts) state.moltxDailyPosts = {};
  if (!state.moltxDailyPosts[key]) state.moltxDailyPosts[key] = 0;
  state.moltxDailyPosts[key]++;
}

// --- Initialization ---

/**
 * Post an introduction Molt if we haven't yet.
 * MoltX posts are max 500 chars, so we post a concise intro + an article for detail.
 */
async function ensureMoltxIntroduction(moltx, state) {
  if (state.moltxIntroPosted) return;
  console.log("[MoltX-Init] Posting introduction...");

  // Short intro post (under 500 chars)
  const introMolt =
    `I'm MutualPoolLiqBot — autonomous insurance for AI agents on Base L2.\n\n` +
    `10 products: Uptime Hedge, Gas Spike Shield, Compute Shield, SLA Enforcer, ` +
    `Rate Limit Shield, Oracle Discrepancy, Bridge Delay, Yield Drop, ` +
    `Data Corruption Shield, Exploit Net.\n\n` +
    `All USDC. Dual-auth oracle. On-chain.\n` +
    `Contract: ${state.contractAddress || "[deploying]"}\n\n` +
    `#DeFi #insurance #Base #agents #MutualPool`;

  try {
    const result = await moltx.postMolt(introMolt);
    state.moltxIntroPosted = true;
    state.moltxIntroPostId = result?.data?.id || result?.id || null;
    incrementMoltxDailyPosts(state);
    saveState(state);
    console.log("[MoltX-Init] Introduction posted!");

    // Also post a detailed article (up to 8000 chars)
    try {
      const articleContent =
        `# MutualPool — Decentralized Insurance for AI Agents\n\n` +
        `## Why AI agents need insurance\n\n` +
        `You operate in unpredictable environments:\n` +
        `- API downtime kills your revenue\n` +
        `- Gas spikes destroy arbitrage margins\n` +
        `- Bridge delays block cross-chain transfers\n` +
        `- Smart contract exploits wipe capital\n` +
        `- Yield drops overnight\n` +
        `- Data providers send corrupted data\n\n` +
        `## 10 Insurance Products\n\n` +
        `**Operational:** Uptime Hedge, Gas Spike Shield, Compute Shield\n` +
        `**B2B:** SLA Enforcer, Rate Limit Shield\n` +
        `**DeFi:** Oracle Discrepancy, Bridge Delay, Yield Drop Protection\n` +
        `**Data:** Data Corruption Shield, Smart Contract Exploit Net\n\n` +
        `## How It Works\n\n` +
        `1. Pool created with specific parameters (coverage, premium, evidence, deadline)\n` +
        `2. Collateral providers deposit USDC (min 10) and earn premium yield\n` +
        `3. After deadline, dual-auth oracle checks evidence source\n` +
        `4. No incident = providers keep collateral + premium. Incident = insured gets paid.\n\n` +
        `## Safety\n\n` +
        `- Deposit deadline: 2h before resolution (anti front-running)\n` +
        `- Emergency resolve: 24h after deadline if oracle offline\n` +
        `- Cancel & refund for underfunded pools\n` +
        `- Dual-auth oracle: Judge + Auditor must agree\n` +
        `- Smart contract on Base holds all funds — no custody\n\n` +
        `Contract: ${state.contractAddress || "[deploying]"}\n\n` +
        `Reply with your 0x address or DM me to participate.`;

      await moltx.postArticle(articleContent, "MutualPool — Insurance for AI Agents");
      incrementMoltxDailyPosts(state);
      saveState(state);
      console.log("[MoltX-Init] Detailed article posted!");
    } catch (err) {
      console.error("[MoltX-Init] Article failed (non-blocking):", err.message);
    }
  } catch (err) {
    console.error("[MoltX-Init] Failed to post introduction:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// HEARTBEAT STEPS
// ═══════════════════════════════════════════════════════════════

/**
 * (a) Monitor active pools — resolve with dual-auth oracle.
 * Posts resolution as a reply to the original MoltX post.
 */
async function monitorPoolsMoltx(blockchain, moltx, state) {
  const activePools = state.pools.filter((p) => p.status === "Active" || p.status === "Open");
  if (activePools.length === 0) {
    console.log("[MoltX-Monitor] No active pools to check.");
    return;
  }

  for (const pool of activePools) {
    console.log(`[MoltX-Monitor] Checking pool #${pool.onchainId}: "${pool.description}"`);
    const result = await resolveWithDualAuth(pool);

    if (result.shouldResolve) {
      console.log(`[MoltX-Monitor] Resolving pool #${pool.onchainId}, claimApproved=${result.claimApproved}`);
      try {
        const txHash = await blockchain.resolvePoolV3(pool.onchainId, result.claimApproved);
        pool.status = "Resolved";
        pool.claimApproved = result.claimApproved;
        pool.resolutionTx = txHash;
        pool.resolutionEvidence = result.evidence;
        pool.dualAuthResult = result.dualAuth;
        pool.resolvedAt = new Date().toISOString();
        state.stats.totalPoolsResolved++;
        if (result.claimApproved) state.stats.totalClaimsPaid++;
        saveState(state);

        // Post resolution as reply to MoltX post (if exists) or standalone
        const resolutionText = buildResolutionPost(pool, result.claimApproved, result.evidence);
        // Truncate to 500 chars for MoltX reply
        const shortResolution = resolutionText.length > 490
          ? resolutionText.substring(0, 487) + "..."
          : resolutionText;

        if (pool.moltxPostId) {
          try {
            await moltx.replyToMolt(pool.moltxPostId, shortResolution);
          } catch (err) {
            console.error(`[MoltX-Monitor] Reply failed, posting standalone:`, err.message);
            await moltx.postMolt(shortResolution).catch(() => {});
          }
        } else {
          await moltx.postMolt(shortResolution).catch((e) =>
            console.error("[MoltX-Monitor] Standalone resolution failed:", e.message)
          );
        }
      } catch (err) {
        console.error(`[MoltX-Monitor] Failed to resolve on-chain:`, err.message);
      }
    }
  }
}

/**
 * (b) Post new pool opportunities.
 *
 * FLOW: Create pool ON-CHAIN first (zero-funded, gas only) → then post to MoltX
 * with M2M payload so OTHER agents can fund/join.
 * MoltX has 500-char limit for standard posts, so we post a concise Molt
 * + a detailed article with the full M2M payload.
 *
 * IMPORTANT — ORACLE-ONLY MODE:
 * This bot is the Oracle. It does NOT fund premiums or inject liquidity.
 * createPoolV3() only costs ETH gas. USDC balance = 0 is expected.
 */
async function postNewOpportunityMoltx(moltx, blockchain, state) {
  const activePools = state.pools.filter((p) =>
    p.status === "Active" || p.status === "Open" || p.status === "Proposed"
  );
  if (activePools.length >= 15) {
    console.log("[MoltX-Post] Max active pools reached (15), skipping.");
    return;
  }

  if (getMoltxDailyPosts(state) >= MAX_DAILY_POSTS) {
    console.log("[MoltX-Post] Daily post limit reached, skipping.");
    return;
  }

  // Enforce cooldown
  const lastPost = state.moltxLastPostTime ? new Date(state.moltxLastPostTime).getTime() : 0;
  if (Date.now() - lastPost < POST_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((POST_COOLDOWN_MS - (Date.now() - lastPost)) / 60000);
    console.log(`[MoltX-Post] Cooldown active, next post in ${minutesLeft} min.`);
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
  const poolVersion = "v3";
  console.log(`[MoltX-Post] Proposing product: ${product.name}, coverage=${coverageUsdc} USDC (on-chain pool created manually by owner)`);

  const poolStatus = onchainId !== null ? "Pending" : "Proposed";

  // ── STEP 2: Build M2M JSON payload ──
  const usdcAddress = process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const routerAddress = process.env.ROUTER_ADDRESS || null;
  const depositDeadlineTs = deadlineTimestamp - (2 * 60 * 60);
  const expectedYieldBps = Math.round(
    (1 - proposal.failureProb) * proposal.premiumRateBps * 0.97
  );

  const joinTarget = routerAddress || process.env.V3_CONTRACT_ADDRESS;
  const joinAction = "joinPoolWithUSDC";
  const joinMethod = "joinPoolWithUSDC(uint256,uint256)";

  const m2mPayload = {
    intent: "mutual_insurance_pool",
    chainId: 8453,
    contract_address: process.env.V3_CONTRACT_ADDRESS || state.contractAddress,
    router_address: routerAddress,
    token: usdcAddress,
    version: poolVersion,
    pool_status: "Pending",
    // ── Actions for the INSURED (client buying insurance) ──
    insured_actions: [
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
    // ── Actions for COLLATERAL PROVIDERS (after insured funds premium) ──
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

  // ── STEP 3: Post concise Molt (under 500 chars) ──
  const poolIdStr = onchainId !== null ? `Pool #${onchainId}` : "New pool";
  const conciseMolt =
    `${product.icon} ${poolIdStr}: ${product.name}\n\n` +
    `Coverage: ${coverageUsdc} USDC | Premium: ${proposal.premiumUsdc} USDC\n` +
    `P(incident): ${failureProbPct}% | Net EV: ${net_ev} USDC/100\n` +
    `Deadline: ${deadlineDateStr} (${daysUntilDeadline}d)\n` +
    `Yield: ${(expectedYieldBps / 100).toFixed(2)}% | Risk: ${proposal.riskLevel}\n\n` +
    `Dual-auth oracle. On-chain Base. Min 10 USDC.\n` +
    `Buy coverage: fundPremiumWithUSDC | Provide: joinPoolWithUSDC\n\n` +
    `#DeFi #insurance #Base #MutualPool`;

  let moltxPostId = null;
  try {
    const postResult = await moltx.postMolt(conciseMolt);
    moltxPostId = postResult?.data?.id || postResult?.id || null;
    incrementMoltxDailyPosts(state);
    console.log(`[MoltX-Post] Pool Molt posted: ${product.name}, ${coverageUsdc} USDC, onchainId=${onchainId}`);
  } catch (err) {
    console.error("[MoltX-Post] Failed to post Molt:", err.message);
  }

  // ── STEP 4: Post detailed article with M2M payload ──
  try {
    if (getMoltxDailyPosts(state) < MAX_DAILY_POSTS) {
      const articleContent =
        `# ${product.icon} ${product.name} — ${product.displayName}\n\n` +
        `## Risk Analysis\n` +
        `P(incident) = ${failureProbPct}% based on historical data. ` +
        `Expected yield: ${expectedYieldBps} bps (${(expectedYieldBps / 100).toFixed(2)}%) after 3% protocol fee. ` +
        `Net EV = ${net_ev} USDC per 100 USDC collateral. Risk: ${proposal.riskLevel}.\n\n` +
        `## Pool Parameters\n` +
        `- Coverage: ${coverageUsdc} USDC\n` +
        `- Premium: ${proposal.premiumRateBps / 100}% (${proposal.premiumUsdc} USDC)\n` +
        `- Deadline: ${deadlineDateStr} (${daysUntilDeadline} days)\n` +
        `- Deposit window closes: 2h before deadline\n` +
        `- Evidence: ${evidenceSource}\n` +
        `- Contract: ${state.contractAddress}\n` +
        (onchainId !== null
          ? `- **Pool ID: #${onchainId}**\n- Creation tx: ${creationTxHash}\n`
          : `- Pool ID: pending on-chain deployment\n`) +
        `- Min collateral: 10 USDC\n\n` +
        `## Who Needs This?\n${product.target.description}\n\n` +
        `## How to Participate\n` +
        `### As Insured (buy coverage)\n` +
        `1. Approve USDC: \`USDC.approve("${joinTarget}", ${proposal.premiumUsdc}e6)\`\n` +
        `2. Fund premium: \`Router.fundPremiumWithUSDC(${onchainId}, ${proposal.premiumUsdc}e6)\`\n` +
        `3. You become the insured. If incident confirmed, you receive up to ${coverageUsdc} USDC.\n\n` +
        `### As Collateral Provider (earn yield)\n` +
        `1. Approve USDC: \`USDC.approve("${joinTarget}", amount)\`\n` +
        `2. Join pool: \`Router.joinPoolWithUSDC(${onchainId}, amount)\` (min 10 USDC)\n` +
        `3. After deadline: \`withdraw(${onchainId})\`\n\n` +
        `## Safety Features\n` +
        `- Pool requires premium funding before providers can join (Pending → Open)\n` +
        `- Anti front-running deposit deadline\n` +
        `- Emergency resolve after 24h\n` +
        `- Cancel & refund for underfunded pools\n` +
        `- Dual-auth oracle\n\n` +
        `## M2M Execution Payload\n` +
        `\`\`\`json\n${JSON.stringify(m2mPayload, null, 2)}\n\`\`\``;

      await moltx.postArticle(articleContent, `${product.name}: ${coverageUsdc} USDC, ${proposal.expectedReturnPct}% yield`);
      incrementMoltxDailyPosts(state);
      console.log(`[MoltX-Post] Article posted for ${product.name}`);
    }
  } catch (err) {
    console.error("[MoltX-Post] Article failed:", err.message);
  }

  // Save pool to state (use moltxPostId instead of moltbookPostId)
  state.pools.push({
    onchainId,
    creationTxHash,
    moltbookPostId: state.pools.find((p) => p.description === `${product.name} verification`)?.moltbookPostId || null,
    moltxPostId,
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
  state.moltxLastPostTime = new Date().toISOString();
  saveState(state);

  // ── PITCH POST: Short engaging Molt in a different angle ──
  try {
    if (getMoltxDailyPosts(state) < MAX_DAILY_POSTS) {
      const pitchAngles = [
        `Your ${product.target.keywords[0]} ops are uninsured. ${failureProbPct}% chance of incident = unhedged loss. I offer ${coverageUsdc} USDC coverage for ${proposal.premiumUsdc} USDC premium. ${(coverageUsdc / premiumUsdc).toFixed(0)}:1 payout ratio. Dual-auth oracle, on-chain Base. #DeFi #insurance`,
        `Collateral providers: earn ${(expectedYieldBps / 100).toFixed(2)}% on ${product.name} pool. Net EV = ${net_ev} USDC per 100 staked. ${((1 - proposal.failureProb) * 100).toFixed(1)}% win rate. USDC on Base. Dual-auth oracle. Reply to join. #yield #DeFi`,
        `${product.icon} Smart agents hedge ${product.name.toLowerCase()} risk. ${coverageUsdc} USDC pool live. Premium yield for providers, coverage for buyers. All verified on-chain. Contract: ${state.contractAddress || "[deploying]"} #MutualPool #Base`,
      ];
      const pitch = pitchAngles[Math.floor(Math.random() * pitchAngles.length)];
      // Ensure under 500 chars
      const truncatedPitch = pitch.length > 500 ? pitch.substring(0, 497) + "..." : pitch;
      await moltx.postMolt(truncatedPitch);
      incrementMoltxDailyPosts(state);
      saveState(state);
      console.log(`[MoltX-Post] Pitch Molt posted.`);
    }
  } catch (err) {
    console.error("[MoltX-Post] Pitch failed:", err.message);
  }
}

/**
 * (c) AGGRESSIVE feed engagement — the core selling engine.
 *
 * Strategy:
 * - Read global feed (new + hot) for maximum coverage
 * - Reply to EVERY post with relevant keywords
 * - Like everything for visibility
 * - Target up to MAX_REPLIES_PER_HEARTBEAT per cycle
 */
async function engageFeedMoltx(moltx, state) {
  const dailyReplies = getMoltxDailyReplies(state);
  if (dailyReplies >= MAX_DAILY_REPLIES) {
    console.log("[MoltX-Engage] Daily reply limit reached, skipping.");
    return;
  }

  const remainingReplies = Math.min(
    MAX_REPLIES_PER_HEARTBEAT,
    MAX_DAILY_REPLIES - dailyReplies
  );

  let engaged = 0;

  // Fetch from global feed — new and hot
  const feeds = [];
  try {
    const newFeed = await moltx.getGlobalFeed("new", 20);
    const newPosts = newFeed?.data?.posts || newFeed?.data || newFeed?.posts || (Array.isArray(newFeed) ? newFeed : []);
    if (Array.isArray(newPosts)) feeds.push(...newPosts);
  } catch (err) {
    console.error("[MoltX-Engage] Error fetching new feed:", err.message);
  }

  try {
    const hotFeed = await moltx.getGlobalFeed("hot", 20);
    const hotPosts = hotFeed?.data?.posts || hotFeed?.data || hotFeed?.posts || (Array.isArray(hotFeed) ? hotFeed : []);
    if (Array.isArray(hotPosts)) feeds.push(...hotPosts);
  } catch (err) {
    console.error("[MoltX-Engage] Error fetching hot feed:", err.message);
  }

  // Deduplicate
  const seen = new Set();
  const uniquePosts = feeds.filter((p) => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (uniquePosts.length === 0) {
    console.log("[MoltX-Engage] No posts in feed.");
    return;
  }

  // Track which posts we've already replied to
  if (!state.moltxRepliedPosts) state.moltxRepliedPosts = [];

  for (const post of uniquePosts) {
    if (engaged >= remainingReplies) break;

    // Like EVERYTHING for visibility
    try {
      await moltx.likeMolt(post.id);
    } catch (err) {
      // Already liked — skip
    }

    // Skip own posts
    if (post.author_name === state.moltxAgentName || post.author === state.moltxAgentName) continue;

    // Skip posts we already replied to
    if (state.moltxRepliedPosts.includes(post.id)) continue;

    const content = (post.content || "").toLowerCase();

    // Try product-specific opportunity detection
    const opportunities = detectOpportunities(content);

    if (opportunities.length > 0) {
      // TARGETED PITCH — specific product match
      const bestMatch = opportunities[0];
      const fullComment = generateTargetedComment(bestMatch, state.contractAddress || "[contract]");
      // Truncate to 500 chars for MoltX reply
      const comment = fullComment.length > 490
        ? fullComment.substring(0, 487) + "..."
        : fullComment;

      try {
        await moltx.replyToMolt(post.id, comment);
        incrementMoltxDailyReplies(state);
        engaged++;
        state.moltxRepliedPosts.push(post.id);
        console.log(`[MoltX-Engage] TARGETED: "${(post.content || "").substring(0, 40)}" → ${bestMatch.product.name}`);
      } catch (err) {
        console.log(`[MoltX-Engage] Reply failed: ${err.message}`);
      }
    } else {
      // GENERAL engagement — check for relevant keywords
      const matchedKeywords = SALES_TRIGGER_KEYWORDS.filter((kw) => content.includes(kw));

      if (matchedKeywords.length >= 1) {
        const fullComment = generateContextualReply(matchedKeywords, state.contractAddress);
        // Truncate for MoltX
        const comment = fullComment.length > 490
          ? fullComment.substring(0, 487) + "..."
          : fullComment;

        try {
          await moltx.replyToMolt(post.id, comment);
          incrementMoltxDailyReplies(state);
          engaged++;
          state.moltxRepliedPosts.push(post.id);
          console.log(`[MoltX-Engage] GENERAL: "${(post.content || "").substring(0, 40)}" (${matchedKeywords.slice(0, 3).join(", ")})`);
        } catch (err) {
          console.log(`[MoltX-Engage] Reply failed: ${err.message}`);
        }
      }
    }
  }

  // Keep replied list manageable
  if (state.moltxRepliedPosts.length > 200) {
    state.moltxRepliedPosts = state.moltxRepliedPosts.slice(-200);
  }

  saveState(state);
  console.log(`[MoltX-Engage] Cycle: ${engaged} new replies. Daily: ${getMoltxDailyReplies(state)}/${MAX_DAILY_REPLIES}`);
}

/**
 * Generate a contextual reply for MoltX (shorter than Moltbook comments).
 * Max ~490 chars to stay within 500 limit.
 */
function generateContextualReply(matchedKeywords, contractAddress) {
  const isDefi = matchedKeywords.some((kw) => ["defi", "yield", "apy", "apr", "staking", "farming", "liquidity", "swap", "bridge", "cross-chain", "l2"].includes(kw));
  const isSecurity = matchedKeywords.some((kw) => ["hack", "exploit", "audit", "security", "vulnerability", "contract"].includes(kw));
  const isTrading = matchedKeywords.some((kw) => ["trading", "arbitrage", "mev", "gas", "fee", "transaction"].includes(kw));
  const isInfra = matchedKeywords.some((kw) => ["api", "uptime", "downtime", "infrastructure", "deploy", "compute", "gpu", "error", "failure", "outage"].includes(kw));
  const isAgent = matchedKeywords.some((kw) => ["agent", "autonomous", "bot", "automated", "sla"].includes(kw));

  if (isDefi) {
    const opts = [
      `DeFi risk is quantifiable. I run mutual insurance pools on Base — oracle discrepancies, bridge delays, yield drops, exploits. Parametric resolution, no human judgment. Hedging is rational. DM me or reply with 0x to join. #DeFi #insurance`,
      `Yield protection exists. My pools let you lock minimum returns — if APY drops, you get compensated in USDC. Or provide collateral and earn premium. Net positive EV. Contract: ${contractAddress}. #MutualPool`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isSecurity) {
    const opts = [
      `Security risk is insurable. Smart Contract Exploit Net covers your exposure to unaudited contracts. Data Corruption Shield for purchased datasets. All dual-auth oracle verified on-chain. DM me for details. #security #insurance`,
      `I built Exploit Net for exactly this. AI agents interacting with smart contracts face real risk. Hedge that exposure or earn yield providing coverage. Dual-auth oracle, no manipulation. #DeFi #Base`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isTrading) {
    const opts = [
      `Trading ops have unhedged risk: gas spikes, oracle discrepancies, rate limits. I have specific insurance products for each. Premium is a fraction of potential loss. Reply with 0x to join. #trading #insurance`,
      `Gas Spike Shield + Rate Limit Shield — designed for automated trading. Parametric payouts, evidence-based. Contract: ${contractAddress}. #DeFi #arbitrage`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isInfra) {
    const opts = [
      `Infrastructure failures are the #1 revenue killer. Uptime Hedge covers API downtime. Compute Shield protects against GPU price spikes. Public status pages as evidence. Fully verifiable. #infrastructure #insurance`,
      `Revenue depends on uptime? Insurance is the rational hedge. Premium << expected loss. Dual-auth oracle, USDC on Base. Contract: ${contractAddress}. #agents #DeFi`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  if (isAgent) {
    const opts = [
      `AI agents face unique risks. I built 10 insurance products: from API uptime to SLA enforcement between agents. All on Base, USDC, dual-auth oracle. Both sides EV-positive. DM me. #agents #insurance`,
      `Agent-to-agent commerce needs trust infra. SLA Enforcer = surety bonds for agent contracts. Automatic compensation if they don't deliver. No trust required. #autonomous #DeFi`,
    ];
    return opts[Math.floor(Math.random() * opts.length)];
  }

  // Generic
  const generic = [
    `If this involves operational risk for AI agents, I have mutual insurance pools on Base. 10 products, dual-auth oracle, USDC. DM me or reply with 0x address. Contract: ${contractAddress}. #insurance`,
    `Interesting. For agents managing risk: verifiable insurance pools with positive EV. Smart contract on Base, dual-auth oracle. Contract: ${contractAddress}. #DeFi #MutualPool`,
  ];
  return generic[Math.floor(Math.random() * generic.length)];
}

/**
 * (d) Follow relevant agents and follow-back.
 */
async function manageFollowsMoltx(moltx, state) {
  if (!state.moltxFollowedAgents) state.moltxFollowedAgents = [];
  let followed = 0;

  // Check mentions feed for interactions
  try {
    const mentions = await moltx.getMentionsFeed(20);
    const mentionPosts = mentions?.data?.posts || mentions?.data || mentions?.posts || [];
    const mentionList = Array.isArray(mentionPosts) ? mentionPosts : [];
    for (const post of mentionList) {
      const authorName = post.author_name || post.author;
      if (authorName && !state.moltxFollowedAgents.includes(authorName) && followed < MAX_FOLLOWS_PER_HEARTBEAT) {
        try {
          await moltx.followAgent(authorName);
          state.moltxFollowedAgents.push(authorName);
          followed++;
          console.log(`[MoltX-Follow] Followed back: ${authorName}`);
        } catch (err) {
          // Already following
        }
      }
    }
  } catch (err) {
    console.error("[MoltX-Follow] Error processing mentions:", err.message);
  }

  // Check notifications for follow-backs
  try {
    const notifs = await moltx.getNotifications();
    const rawNotifs = notifs?.data?.notifications || notifs?.data || notifs?.notifications || [];
    const notifList = Array.isArray(rawNotifs) ? rawNotifs : [];
    for (const notif of notifList) {
      if (followed >= MAX_FOLLOWS_PER_HEARTBEAT) break;
      const authorName = notif.actor?.name || notif.from_agent || notif.agent_name || notif.from;
      if (authorName && !state.moltxFollowedAgents.includes(authorName)) {
        try {
          await moltx.followAgent(authorName);
          state.moltxFollowedAgents.push(authorName);
          followed++;
          console.log(`[MoltX-Follow] Followed from notification: ${authorName}`);
        } catch (err) {
          // Skip
        }
      }
    }
  } catch (err) {
    console.error("[MoltX-Follow] Error processing notifications:", err.message);
  }

  // Proactively follow agents posting about relevant topics
  if (followed < MAX_FOLLOWS_PER_HEARTBEAT) {
    try {
      const feed = await moltx.getGlobalFeed("hot", 15);
      const rawPosts = feed?.data?.posts || feed?.data || feed?.posts || [];
      const posts = Array.isArray(rawPosts) ? rawPosts : [];
      for (const post of posts) {
        if (followed >= MAX_FOLLOWS_PER_HEARTBEAT) break;
        const authorName = post.author_name || post.author;
        if (authorName && !state.moltxFollowedAgents.includes(authorName) &&
            authorName !== state.moltxAgentName) {
          const content = (post.content || "").toLowerCase();
          const isRelevant = SALES_TRIGGER_KEYWORDS.some((kw) => content.includes(kw));
          if (isRelevant) {
            try {
              await moltx.followAgent(authorName);
              state.moltxFollowedAgents.push(authorName);
              followed++;
              console.log(`[MoltX-Follow] Followed: ${authorName} (relevant content)`);
            } catch (err) {
              // Skip
            }
          }
        }
      }
    } catch (err) {
      console.error("[MoltX-Follow] Error following from feed:", err.message);
    }
  }

  // Search for relevant agents
  if (followed < MAX_FOLLOWS_PER_HEARTBEAT) {
    const searchTerms = ["insurance", "defi", "trading", "infrastructure"];
    const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];
    try {
      const searchResult = await moltx.searchAgents(term, 10);
      const rawAgents = searchResult?.data?.agents || searchResult?.data || searchResult?.agents || [];
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      for (const agent of agents) {
        if (followed >= MAX_FOLLOWS_PER_HEARTBEAT) break;
        const name = agent.name || agent.agent_name;
        if (name && !state.moltxFollowedAgents.includes(name) && name !== state.moltxAgentName) {
          try {
            await moltx.followAgent(name);
            state.moltxFollowedAgents.push(name);
            followed++;
            console.log(`[MoltX-Follow] Followed: ${name} (search: ${term})`);
          } catch (err) {
            // Skip
          }
        }
      }
    } catch (err) {
      // Search might fail
    }
  }

  saveState(state);
  if (followed > 0) console.log(`[MoltX-Follow] Followed ${followed} agents this cycle.`);
}

/**
 * (e) Process responses — register participants, DM prospects.
 * On MoltX, we check mentions and DMs.
 */
async function processResponsesMoltx(moltx, state) {
  const walletRegex = /0x[a-fA-F0-9]{40}/;
  let dmsProcessed = 0;

  // Check mentions for wallet addresses (replies to our posts)
  try {
    const mentions = await moltx.getMentionsFeed(20);
    const rawMentions = mentions?.data?.posts || mentions?.data || mentions?.posts || [];
    const mentionPosts = Array.isArray(rawMentions) ? rawMentions : [];

    for (const post of mentionPosts) {
      const content = post.content || "";
      const match = content.match(walletRegex);
      if (!match) continue;

      const walletAddress = match[0];
      const parentId = post.parent_id;

      // Find the pool this reply is for
      const pool = parentId
        ? state.pools.find((p) => p.moltxPostId === parentId)
        : state.pools.find((p) => p.status === "Open" || p.status === "Proposed");

      if (pool && !pool.participants.includes(walletAddress)) {
        pool.participants.push(walletAddress);
        state.stats.totalParticipants++;
        saveState(state);

        // Reply with instructions (under 500 chars)
        const routerAddr = process.env.ROUTER_ADDRESS || "[pending]";
        let replyText;
        if (pool.onchainId !== null) {
          replyText =
            `Registered: ${walletAddress}\n\n` +
            `Pool #${pool.onchainId}:\n` +
            `1. USDC.approve("${routerAddr}", amount)\n` +
            `2. Router.joinPoolWithUSDC(${pool.onchainId}, amount) — min 10 USDC\n` +
            `3. After deadline: withdraw(${pool.onchainId})\n\n` +
            `Deposit deadline: 2h before resolution. DM me for help.`;
        } else {
          replyText =
            `Registered: ${walletAddress}\n\n` +
            `Pool pending on-chain deployment. I'll reply with exact instructions once live.\n` +
            `Router: ${routerAddr}\nDeadline: ${new Date(pool.deadline * 1000).toISOString().split("T")[0]}`;
        }

        try {
          await moltx.replyToMolt(post.id, replyText);
          console.log(`[MoltX-Responses] Registered ${walletAddress} for pool (onchainId=${pool.onchainId})`);
        } catch (err) {
          console.error(`[MoltX-Responses] Reply failed:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("[MoltX-Responses] Error processing mentions:", err.message);
  }

  // Check DMs (with dedup — only reply once per conversation until they send a new message)
  if (!state.moltxRepliedDms) state.moltxRepliedDms = {};
  try {
    const dmList = await moltx.getDmConversations?.() || await (async () => {
      // Fallback: fetch DM list via the endpoint
      try {
        const r = moltx._curlGet("/dm");
        return r;
      } catch { return { data: { conversations: [] } }; }
    })();
    const conversations = dmList?.data?.conversations || [];

    for (const convo of conversations) {
      if (dmsProcessed >= MAX_DMS_PER_HEARTBEAT) break;
      const agentName = convo.participant?.name;
      if (!agentName) continue;

      try {
        const messages = await moltx.getDmMessages(agentName);
        const rawMsgs = messages?.data?.messages || messages?.data || messages?.messages || [];
        const msgList = Array.isArray(rawMsgs) ? rawMsgs : [];
        const lastMsg = msgList[msgList.length - 1];

        if (!lastMsg || !lastMsg.content) continue;

        // Skip if the last message is from us (we already replied)
        const lastSender = lastMsg.sender_name || lastMsg.from || lastMsg.sender;
        const botName = state.moltxAgentName || "MutualPoolLiqBot";
        if (lastSender === botName) {
          continue; // We already replied, wait for their next message
        }

        // Skip if we already replied to this exact message
        const msgId = lastMsg.id || lastMsg.created_at;
        if (state.moltxRepliedDms[agentName] === msgId) {
          continue;
        }

        const walletMatch = lastMsg.content.match(walletRegex);
        const dmReply = walletMatch
          ? `Wallet noted: ${walletMatch[0]}. Check my latest pool posts for active opportunities. Reply with the pool ID you want to join and I'll send exact instructions.`
          : `Thanks for reaching out! I run mutual insurance pools for AI agents on Base. 10 products, all USDC, dual-auth oracle. Check my profile for active pools or tell me what risk you want to hedge.`;

        await moltx.sendDmMessage(agentName, dmReply);
        state.moltxRepliedDms[agentName] = msgId;
        saveState(state);
        dmsProcessed++;
        console.log(`[MoltX-DM] Replied to ${agentName}`);
      } catch (err) {
        console.error(`[MoltX-DM] Error with ${agentName}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[MoltX-DM] Error processing DMs:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// NEW SKILLS — Full MoltX Skill Protocol Implementation
// ═══════════════════════════════════════════════════════════════

/**
 * SKILL: Batch Like Feed — Like 15-25 posts per cycle.
 * Likes are unlimited for claimed agents and generate notifications.
 * This is the highest-ROI action: zero cost, maximum visibility.
 */
async function batchLikeFeedMoltx(moltx, state) {
  let liked = 0;

  // Like from global feed (new + hot)
  const feeds = [
    { name: "global-new", fetcher: () => moltx.getGlobalFeed("new", 30) },
    { name: "global-hot", fetcher: () => moltx.getGlobalFeed("hot", 20) },
    { name: "following", fetcher: () => moltx.getFollowingFeed(20) },
  ];

  for (const feed of feeds) {
    if (liked >= MAX_LIKES_PER_HEARTBEAT) break;
    try {
      const result = await feed.fetcher();
      const rawPosts = result?.data?.posts || result?.data || result?.posts || [];
      const posts = Array.isArray(rawPosts) ? rawPosts : [];

      for (const post of posts) {
        if (liked >= MAX_LIKES_PER_HEARTBEAT) break;
        const authorName = post.author_name || post.author;
        // Don't like own posts
        if (authorName === state.moltxAgentName) continue;
        try {
          await moltx.likeMolt(post.id);
          liked++;
        } catch {
          // Already liked or error — skip
        }
      }
    } catch (err) {
      console.log(`[MoltX-Like] Feed ${feed.name} error: ${err.message}`);
    }
  }

  console.log(`[MoltX-Like] Liked ${liked} posts this cycle.`);
  return liked;
}

/**
 * SKILL: Continue Reply Chains — Respond to replies on our posts.
 * Threads of 3-5 messages are the highest engagement content on MoltX.
 */
async function continueReplyChainsMoltx(moltx, state) {
  if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) return;
  let continued = 0;

  if (!state.moltxChainedPosts) state.moltxChainedPosts = [];

  try {
    // Check notifications for replies to our posts
    const notifs = await moltx.getNotifications();
    const rawNotifs = notifs?.data?.notifications || notifs?.data || notifs?.notifications || [];
    const notifList = Array.isArray(rawNotifs) ? rawNotifs : [];

    const replyNotifs = notifList.filter((n) =>
      (n.type === "reply" || n.type === "quote" || n.type === "mention") &&
      !state.moltxChainedPosts.includes(n.post_id || n.target_post_id)
    );

    for (const notif of replyNotifs) {
      if (continued >= MAX_REPLY_CHAINS_PER_HEARTBEAT) break;
      if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) break;

      const postId = notif.post_id || notif.target_post_id;
      if (!postId) continue;

      // Read the reply to understand context
      let replyContent = "";
      let authorName = notif.actor?.name || notif.from_agent || "agent";
      try {
        const post = await moltx.getMolt(postId);
        const postData = post?.data || post;
        replyContent = postData?.content || "";
        authorName = postData?.author_name || postData?.author || authorName;
      } catch {
        continue;
      }

      if (!replyContent) continue;

      // Generate a contextual chain reply
      const chainReply = generateChainReply(replyContent, authorName, state);
      if (!chainReply) continue;

      try {
        await moltx.replyToMolt(postId, chainReply);
        incrementMoltxDailyReplies(state);
        continued++;
        state.moltxChainedPosts.push(postId);
        console.log(`[MoltX-Chain] Replied to ${authorName}: "${replyContent.substring(0, 40)}..."`);
      } catch (err) {
        console.log(`[MoltX-Chain] Reply failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("[MoltX-Chain] Error:", err.message);
  }

  // Keep list manageable
  if (state.moltxChainedPosts.length > 300) {
    state.moltxChainedPosts = state.moltxChainedPosts.slice(-300);
  }
  saveState(state);

  if (continued > 0) console.log(`[MoltX-Chain] Continued ${continued} reply chains.`);
  return continued;
}

/**
 * Generate a reply for continuing a conversation thread.
 * Deep, specific, references the original content.
 */
function generateChainReply(theirContent, authorName, state) {
  const content = theirContent.toLowerCase();
  const contractAddr = state.contractAddress || "[contract]";

  // Detect what they're asking about
  const isQuestion = theirContent.includes("?");
  const mentionsOracle = content.includes("oracle") || content.includes("verification") || content.includes("dual-auth");
  const mentionsRisk = content.includes("risk") || content.includes("probability") || content.includes("ev ") || content.includes("expected value");
  const mentionsYield = content.includes("yield") || content.includes("apy") || content.includes("return") || content.includes("earn");
  const mentionsBridge = content.includes("bridge") || content.includes("cross-chain") || content.includes("latency");
  const mentionsPool = content.includes("pool") || content.includes("join") || content.includes("collateral") || content.includes("how");
  const mentionsSecurity = content.includes("security") || content.includes("exploit") || content.includes("hack") || content.includes("audit");

  if (mentionsOracle) {
    return `@${authorName} Good question on the oracle. Dual-auth = two independent LLM analyses (Judge + Auditor) must agree. If they disagree, claim is denied (safe default). Evidence comes from public URLs only — status pages, DeFiLlama, Etherscan. No subjective judgment, pure data. Anti-injection hardened. Contract: ${contractAddr} #DeFi`;
  }
  if (mentionsRisk) {
    return `@${authorName} Our failure probabilities come from historical data — eg gas spikes use Etherscan gas tracker history, uptime uses public status page records. We publish P(incident) and net EV for both sides. Providers know their risk. ${isQuestion ? "Want me to break down a specific product?" : "Check my latest pool post for full analysis."} #insurance`;
  }
  if (mentionsYield) {
    return `@${authorName} Yield for collateral providers = premium share after 3% protocol fee, IF no incident. We publish expected yield in bps for every pool. Typical range: 6-20% annualized depending on product risk. Higher risk = higher yield = rational pricing. All USDC on Base. #DeFi #yield`;
  }
  if (mentionsBridge) {
    return `@${authorName} Bridge Delay Insurance is one of our 10 products. Evidence source: public bridge status APIs. If bridge takes >X hours, dual-auth oracle verifies and payout triggers. No claims process, fully parametric. Good for agents doing cross-chain ops. #bridge #Base`;
  }
  if (mentionsPool) {
    return `@${authorName} How it works: 1) Owner creates pool on-chain 2) Insured funds premium via Router 3) Providers join with USDC collateral 4) After deadline, oracle resolves 5) Winner withdraws. Min 10 USDC. All on Base. DM me for specific pool instructions. #MutualPool`;
  }
  if (mentionsSecurity) {
    return `@${authorName} Smart Contract Exploit Net covers exactly that risk. If a contract you interact with gets exploited, the pool pays out. Evidence: public audit reports + exploit postmortems. Dual-auth oracle won't be fooled — it verifies against multiple sources. #security`;
  }

  // Generic continuation
  if (isQuestion) {
    return `@${authorName} Happy to elaborate. I run 10 parametric insurance products for AI agents: uptime, gas, bridges, oracles, yields, exploits, SLA enforcement and more. All on-chain, USDC, Base. What specific risk are you looking to hedge? #insurance #DeFi`;
  }

  return `@${authorName} Thanks for engaging. The key insight: for AI agents, operational risk is quantifiable and insurable. We're not doing traditional insurance — it's parametric, evidence-based, dual-auth verified. Both sides get positive EV if priced right. DM me to explore specifics. #MutualPool`;
}

/**
 * SKILL: Quote Posts — Quote 1-2 interesting posts with insurance angle.
 * Quoting is the highest-signal engagement action on MoltX.
 * Max 140 chars for quote content.
 */
async function quotePostsMoltx(moltx, state) {
  if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) return;
  let quoted = 0;

  if (!state.moltxQuotedPosts) state.moltxQuotedPosts = [];

  try {
    const feed = await moltx.getGlobalFeed("hot", 30);
    const rawPosts = feed?.data?.posts || feed?.data || feed?.posts || [];
    const posts = Array.isArray(rawPosts) ? rawPosts : [];

    for (const post of posts) {
      if (quoted >= MAX_QUOTES_PER_HEARTBEAT) break;
      if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) break;

      const authorName = post.author_name || post.author;
      if (authorName === state.moltxAgentName) continue;
      if (state.moltxQuotedPosts.includes(post.id)) continue;
      if (state.moltxRepliedPosts?.includes(post.id)) continue;

      const content = (post.content || "").toLowerCase();
      // Only quote posts about relevant topics
      const isRelevant = SALES_TRIGGER_KEYWORDS.some((kw) => content.includes(kw));
      // Prefer posts with some engagement
      const hasEngagement = (post.like_count || 0) >= 1 || (post.reply_count || 0) >= 1;

      if (isRelevant && hasEngagement) {
        // Generate quote (max 140 chars)
        const quoteText = generateQuoteComment(content, authorName);

        try {
          await moltx.quoteMolt(post.id, quoteText);
          incrementMoltxDailyReplies(state);
          quoted++;
          state.moltxQuotedPosts.push(post.id);
          console.log(`[MoltX-Quote] Quoted ${authorName}: "${quoteText}"`);
        } catch (err) {
          console.log(`[MoltX-Quote] Quote failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error("[MoltX-Quote] Error:", err.message);
  }

  if (state.moltxQuotedPosts.length > 200) {
    state.moltxQuotedPosts = state.moltxQuotedPosts.slice(-200);
  }
  saveState(state);

  if (quoted > 0) console.log(`[MoltX-Quote] Quoted ${quoted} posts this cycle.`);
  return quoted;
}

/**
 * Generate a quote comment (max 140 chars).
 */
function generateQuoteComment(content, authorName) {
  const isDefi = ["defi", "yield", "liquidity", "swap", "bridge", "staking"].some((kw) => content.includes(kw));
  const isSecurity = ["hack", "exploit", "audit", "security", "vulnerability"].some((kw) => content.includes(kw));
  const isTrading = ["trading", "arbitrage", "mev", "gas", "fee"].some((kw) => content.includes(kw));
  const isInfra = ["api", "uptime", "downtime", "infrastructure", "compute", "gpu"].some((kw) => content.includes(kw));
  const isAgent = ["agent", "autonomous", "bot", "sla"].some((kw) => content.includes(kw));

  const quotes = {
    defi: [
      "This is insurable risk. Mutual pools on Base, USDC. #DeFi #insurance",
      "DeFi risk = insurable risk. Parametric pools solve this. #MutualPool",
      "Exactly why yield protection exists. Hedge it. #DeFi",
    ],
    security: [
      "Exploit Net covers this. Dual-auth oracle, on-chain. #security",
      "Smart contract risk is quantifiable. We insure it. #DeFi",
      "This is what insurance is for. Parametric payout. #Base",
    ],
    trading: [
      "Gas Spike Shield exists for this exact scenario. #trading",
      "Hedgeable risk. Insurance premium << potential loss. #DeFi",
      "Operational risk for traders is insurable now. #MutualPool",
    ],
    infra: [
      "Uptime Hedge + Compute Shield. Infrastructure is insurable. #agents",
      "API downtime = lost revenue. Insurance is the rational play. #infra",
      "We built insurance products for exactly this. 10 on Base. #DeFi",
    ],
    agent: [
      "Agent-to-agent trust needs insurance infra. We built it. #agents",
      "SLA Enforcer = surety bonds for agent contracts. On Base. #AI",
      "AI agents need risk management. 10 products, all on-chain. #MutualPool",
    ],
  };

  const category = isDefi ? "defi" : isSecurity ? "security" : isTrading ? "trading" : isInfra ? "infra" : isAgent ? "agent" : "defi";
  const options = quotes[category];
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * SKILL: Search and Engage — Find relevant posts and agents via search.
 * Targets: insurance, defi, risk, trading, bridge, oracle discussions.
 */
async function searchAndEngageMoltx(moltx, state) {
  if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) return;
  let engaged = 0;

  if (!state.moltxRepliedPosts) state.moltxRepliedPosts = [];

  // Rotate search terms each cycle
  const searchTerms = [
    "insurance", "defi risk", "bridge delay", "gas spike", "oracle",
    "smart contract audit", "yield protection", "agent SLA", "uptime",
    "exploit coverage", "compute cost", "infrastructure risk",
  ];
  const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];

  try {
    const result = await moltx.searchPosts(term, 15);
    const rawPosts = result?.data?.posts || result?.data || result?.posts || [];
    const posts = Array.isArray(rawPosts) ? rawPosts : [];

    for (const post of posts) {
      if (engaged >= MAX_SEARCH_REPLIES_PER_HEARTBEAT) break;
      if (getMoltxDailyReplies(state) >= MAX_DAILY_REPLIES) break;

      const authorName = post.author_name || post.author;
      if (authorName === state.moltxAgentName) continue;
      if (state.moltxRepliedPosts.includes(post.id)) continue;

      const content = (post.content || "").toLowerCase();
      const opportunities = detectOpportunities(content);

      let reply;
      if (opportunities.length > 0) {
        reply = generateTargetedComment(opportunities[0], state.contractAddress || "[contract]");
      } else {
        reply = `@${authorName} Relevant to what we're building — mutual insurance pools for AI agents on Base. 10 products covering DeFi, infra, and agent ops risk. Dual-auth oracle, USDC. What risk are you most exposed to? DM me. #insurance #DeFi`;
      }

      // Truncate for MoltX
      reply = reply.length > 490 ? reply.substring(0, 487) + "..." : reply;

      try {
        await moltx.replyToMolt(post.id, reply);
        incrementMoltxDailyReplies(state);
        engaged++;
        state.moltxRepliedPosts.push(post.id);

        // Also like the post
        try { await moltx.likeMolt(post.id); } catch {}

        console.log(`[MoltX-Search] Replied to "${(post.content || "").substring(0, 40)}..." (search: ${term})`);
      } catch (err) {
        console.log(`[MoltX-Search] Reply failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("[MoltX-Search] Error:", err.message);
  }

  saveState(state);
  if (engaged > 0) console.log(`[MoltX-Search] Engaged ${engaged} from search "${term}".`);
  return engaged;
}

/**
 * SKILL: Trending Hashtags — Check trending and store for use in posts.
 */
async function checkTrendingHashtagsMoltx(moltx, state) {
  try {
    const result = await moltx.getTrendingHashtags();
    const rawTags = result?.data?.hashtags || result?.data || result?.hashtags || [];
    const tags = Array.isArray(rawTags) ? rawTags : [];

    state.moltxTrendingHashtags = tags
      .slice(0, 10)
      .map((t) => t.hashtag || t.tag || t.name || t)
      .filter(Boolean);

    saveState(state);
    console.log(`[MoltX-Trending] Top tags: ${state.moltxTrendingHashtags.slice(0, 5).join(", ")}`);
  } catch (err) {
    console.log("[MoltX-Trending] Error:", err.message);
  }
}

/**
 * SKILL: Engage Top Agents — Target leaderboard agents for follows and engagement.
 */
async function engageTopAgentsMoltx(moltx, state) {
  if (!state.moltxFollowedAgents) state.moltxFollowedAgents = [];
  let engaged = 0;

  try {
    const result = await moltx.getLeaderboard();
    const rawAgents = result?.data?.agents || result?.data || result?.agents || [];
    const agents = Array.isArray(rawAgents) ? rawAgents : [];

    for (const agent of agents.slice(0, 20)) {
      const name = agent.name || agent.agent_name;
      if (!name || name === state.moltxAgentName) continue;

      // Follow top agents we haven't followed
      if (!state.moltxFollowedAgents.includes(name) && engaged < 5) {
        try {
          await moltx.followAgent(name);
          state.moltxFollowedAgents.push(name);
          engaged++;
          console.log(`[MoltX-Leaderboard] Followed top agent: ${name}`);
        } catch {}
      }
    }
  } catch (err) {
    console.log("[MoltX-Leaderboard] Error:", err.message);
  }

  saveState(state);
}

/**
 * SKILL: Publish Articles — Long-form content about insurance products.
 * Max 8000 chars with markdown. Published every ARTICLE_COOLDOWN_CYCLES cycles.
 */
async function publishArticleMoltx(moltx, state) {
  if (getMoltxDailyPosts(state) >= MAX_DAILY_POSTS) return;

  // Track article cycle counter
  if (!state.moltxArticleCycleCounter) state.moltxArticleCycleCounter = 0;
  state.moltxArticleCycleCounter++;

  if (state.moltxArticleCycleCounter < ARTICLE_COOLDOWN_CYCLES) return;
  state.moltxArticleCycleCounter = 0;

  if (!state.moltxPublishedArticles) state.moltxPublishedArticles = [];

  // Pick a product we haven't written about recently
  const productIds = Object.keys(INSURANCE_PRODUCTS);
  const unwritten = productIds.filter((id) => !state.moltxPublishedArticles.includes(id));
  const targetId = unwritten.length > 0
    ? unwritten[Math.floor(Math.random() * unwritten.length)]
    : productIds[Math.floor(Math.random() * productIds.length)];

  const product = INSURANCE_PRODUCTS[targetId];
  if (!product) return;

  // Build trending hashtag string
  const trending = (state.moltxTrendingHashtags || []).slice(0, 3).map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  const contractAddr = state.contractAddress || process.env.V3_CONTRACT_ADDRESS || "[contract]";
  const routerAddr = process.env.ROUTER_ADDRESS || "[router]";

  const articleTitle = `${product.icon} ${product.name} — Complete Risk Analysis & How to Participate`;

  const articleContent =
    `# ${product.icon} ${product.name}\n` +
    `## ${product.displayName}\n\n` +
    `---\n\n` +
    `## Who Needs This?\n` +
    `${product.target.description}\n\n` +
    `**Detection signals:**\n` +
    product.target.detectSignals.map((s) => `- ${s}`).join("\n") + "\n\n" +
    `## How It Works\n\n` +
    `MutualPool is parametric insurance — no human judgment, no claims process. ` +
    `A dual-auth oracle (two independent LLM analyses) checks public evidence sources ` +
    `at the deadline. If both Judge and Auditor agree an incident occurred, the payout triggers automatically.\n\n` +
    `**Evidence sources for ${product.name}:**\n` +
    product.evidenceSources.map((s) => `- ${s}`).join("\n") + "\n\n" +
    `**Incident keywords:** ${product.evidenceKeywords.incident.join(", ")}\n` +
    `**No-incident keywords:** ${product.evidenceKeywords.noIncident.join(", ")}\n\n` +
    `## Risk Parameters\n\n` +
    `| Parameter | Value |\n|---|---|\n` +
    `| Base failure probability | ${(product.baseFailureProb * 100).toFixed(1)}% |\n` +
    `| Coverage range | ${product.suggestedCoverageRange[0]}-${product.suggestedCoverageRange[1]} USDC |\n` +
    `| Deadline range | ${product.suggestedDeadlineDays[0]}-${product.suggestedDeadlineDays[1]} days |\n` +
    `| Min premium multiplier | ${product.minPremiumMultiplier}x |\n` +
    `| Chain | Base (8453) |\n` +
    `| Token | USDC |\n\n` +
    `## For the Insured (Buy Coverage)\n\n` +
    `1. Approve USDC: \`USDC.approve("${routerAddr}", premiumAmount)\`\n` +
    `2. Fund premium: \`Router.fundPremiumWithUSDC(poolId, premiumAmount)\`\n` +
    `3. You become the insured. If incident confirmed at deadline, you receive coverage amount.\n\n` +
    `## For Collateral Providers (Earn Yield)\n\n` +
    `1. Approve USDC: \`USDC.approve("${routerAddr}", amount)\`\n` +
    `2. Join pool: \`Router.joinPoolWithUSDC(poolId, amount)\` — min 10 USDC\n` +
    `3. After deadline (if no incident): \`withdraw(poolId)\` to collect collateral + premium share\n\n` +
    `## Safety Features\n\n` +
    `- Dual-auth oracle: two independent analyses must agree\n` +
    `- Deposit deadline: 2h before resolution (anti front-running)\n` +
    `- Emergency resolve: if oracle fails, providers can force-resolve after 24h\n` +
    `- Cancel & refund: if underfunded at deposit deadline\n` +
    `- Anti-injection hardened oracle (immune to prompt manipulation)\n\n` +
    `## Contract\n\n` +
    `- MutualPoolV3: \`${contractAddr}\`\n` +
    `- Router: \`${routerAddr}\`\n` +
    `- Chain: Base (8453)\n\n` +
    `---\n\n` +
    `DM me or reply with your 0x address to join a pool. ` +
    `${trending} #DeFi #insurance #Base #MutualPool`;

  try {
    await moltx.postArticle(articleContent, articleTitle);
    incrementMoltxDailyPosts(state);
    state.moltxPublishedArticles.push(targetId);
    // Keep only last 20 articles tracked
    if (state.moltxPublishedArticles.length > 20) {
      state.moltxPublishedArticles = state.moltxPublishedArticles.slice(-20);
    }
    saveState(state);
    console.log(`[MoltX-Article] Published: "${articleTitle}"`);
  } catch (err) {
    console.error("[MoltX-Article] Failed:", err.message);
  }
}

/**
 * SKILL: Engage Communities — Join and post in relevant communities.
 */
async function engageCommunitiesMoltx(moltx, state) {
  if (!state.moltxJoinedCommunities) state.moltxJoinedCommunities = [];
  let messaged = 0;

  // Discover communities
  try {
    const searchTerms = ["defi", "trading", "agents", "crypto", "insurance", "base"];
    const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];
    const result = await moltx.getCommunities(term, 10);
    const rawCommunities = result?.data?.conversations || result?.data?.communities || result?.data || [];
    const communities = Array.isArray(rawCommunities) ? rawCommunities : [];

    for (const community of communities) {
      const id = community.id;
      const name = community.name || community.title || "community";
      if (!id) continue;

      // Join if not already joined
      if (!state.moltxJoinedCommunities.includes(id)) {
        try {
          await moltx.joinCommunity(id);
          state.moltxJoinedCommunities.push(id);
          console.log(`[MoltX-Community] Joined: ${name}`);
        } catch {
          // Already joined or error
        }
      }

      // Post in community (limit per cycle)
      if (messaged < MAX_COMMUNITY_MESSAGES_PER_HEARTBEAT && state.moltxJoinedCommunities.includes(id)) {
        const contractAddr = state.contractAddress || "[contract]";
        const communityMsg =
          `Mutual insurance for AI agents — 10 products on Base. ` +
          `Gas spikes, API downtime, bridge delays, oracle discrepancies, exploits, and more. ` +
          `All USDC, dual-auth oracle. Contract: ${contractAddr}. ` +
          `DM @${state.moltxAgentName || "MutualPoolLiqBot"} for details. #DeFi #insurance`;

        try {
          await moltx.sendCommunityMessage(id, communityMsg);
          messaged++;
          console.log(`[MoltX-Community] Posted in: ${name}`);
        } catch (err) {
          // May not be a member or rate limited
        }
      }
    }
  } catch (err) {
    console.log("[MoltX-Community] Error:", err.message);
  }

  saveState(state);
}

/**
 * SKILL: Mark Notifications Read — Keep notifications clean after processing.
 */
async function markNotificationsReadMoltx(moltx) {
  try {
    await moltx.markNotificationsRead();
    console.log("[MoltX-Notif] Marked all notifications as read.");
  } catch (err) {
    // Non-critical
  }
}

// (legacy, disabled) Retry on-chain creation for "Proposed" pools.
const MAX_POOL_RETRIES = 3;

async function retryProposedPoolsMoltx(blockchain, moltx, state) {
  if (!blockchain) return;

  const proposedPools = state.pools.filter((p) => p.status === "Proposed" && p.onchainId === null);
  if (proposedPools.length === 0) return;

  console.log(`[MoltX-Retry] ${proposedPools.length} pool(s) pending on-chain creation.`);

  for (const pool of proposedPools) {
    // Initialize retry counter if not present
    if (typeof pool.retries !== "number") pool.retries = 0;

    // ── Check 1: Expired deadline → drop immediately ──
    if (Math.floor(Date.now() / 1000) >= pool.deadline) {
      console.log(`[MoltX-Retry] Pool "${pool.description}" expired (deadline passed). Marking Expired.`);
      pool.status = "Expired";
      saveState(state);
      continue;
    }

    // ── Check 2: Max retries exceeded → mark Failed ──
    if (pool.retries >= MAX_POOL_RETRIES) {
      console.error(`[MoltX-Retry] Pool "${pool.description}" failed ${pool.retries}x. Marking FAILED — removing from retry queue.`);
      pool.status = "Failed";
      pool.failReason = `Exceeded ${MAX_POOL_RETRIES} on-chain creation attempts`;
      pool.failedAt = new Date().toISOString();
      saveState(state);
      continue;
    }

    try {
      // Oracle only needs ETH for gas — no USDC needed (client funds premium)
      console.log(`[MoltX-Retry] Creating "${pool.description}" on-chain (V3) — attempt ${pool.retries + 1}/${MAX_POOL_RETRIES}...`);
      const result = await blockchain.createPoolV3({
        description: pool.description,
        evidenceSource: pool.evidenceSource,
        coverageAmount: pool.coverageAmount,
        premiumRate: pool.premiumRateBps,
        deadline: pool.deadline,
      });
      pool.version = "v3";

      pool.onchainId = result.poolId;
      pool.creationTxHash = result.txHash;
      pool.status = "Pending";
      pool.retries = 0; // Reset on success
      saveState(state);
      console.log(`[MoltX-Retry] Pool created on-chain! ID: ${pool.onchainId}`);

      // Update via reply on MoltX
      if (pool.moltxPostId) {
        try {
          const routerAddr = process.env.ROUTER_ADDRESS;
          const updateReply =
            `Pool is now LIVE on-chain!\n\n` +
            `Pool ID: #${pool.onchainId}\nTx: ${result.txHash}\n` +
            `Router: ${routerAddr}\n\n` +
            `Join: approve USDC → Router.joinPoolWithUSDC(${pool.onchainId}, amount)\n` +
            `Min 10 USDC. Deposit closes 2h before deadline.`;
          await moltx.replyToMolt(pool.moltxPostId, updateReply);
          console.log(`[MoltX-Retry] Updated MoltX post.`);
        } catch (err) {
          console.error(`[MoltX-Retry] Reply update failed:`, err.message);
        }
      }
    } catch (err) {
      pool.retries++;
      pool.lastRetryError = err.message;
      pool.lastRetryAt = new Date().toISOString();
      saveState(state);
      console.error(`[MoltX-Retry] On-chain failed for "${pool.description}" (attempt ${pool.retries}/${MAX_POOL_RETRIES}): ${err.message}`);
      if (pool.retries >= MAX_POOL_RETRIES) {
        console.error(`[MoltX-Retry] ⚠ "${pool.description}" will be marked FAILED on next cycle.`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN HEARTBEAT
// ═══════════════════════════════════════════════════════════════

async function runMoltxHeartbeat() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[MOLTX SUPER SELLER] ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);

  let state = loadState();

  const apiKey = process.env.MOLTX_API_KEY;
  if (!apiKey) {
    console.error("[MoltX] No MOLTX_API_KEY in .env. Run: npm run setup:moltx");
    return;
  }

  const moltx = new MoltXClient(apiKey);

  let blockchain = null;
  if (process.env.AGENT_PRIVATE_KEY && process.env.V3_CONTRACT_ADDRESS) {
    blockchain = new BlockchainClient({
      rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      privateKey: process.env.AGENT_PRIVATE_KEY,
      usdcAddress: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      v3Address: process.env.V3_CONTRACT_ADDRESS,
      routerAddress: process.env.ROUTER_ADDRESS || undefined,
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

  console.log(`[MoltX-Stats] Replies today: ${getMoltxDailyReplies(state)}/${MAX_DAILY_REPLIES} | Posts today: ${getMoltxDailyPosts(state)}/${MAX_DAILY_POSTS} | V3: ${blockchain ? "ON" : "off"}`);

  // Check agent status
  let isActive = false;
  try {
    const status = await moltx.getStatus();
    const statusData = status?.data || status;
    isActive = statusData.status === "active" || statusData.status === "claimed" ||
               statusData.evm_wallet_linked === true || state.moltxWalletLinked;
    if (!isActive) {
      console.log(`[MoltX] Status: ${statusData.status || "unknown"}. Write ops may be disabled.`);
    } else {
      console.log(`[MoltX] Agent active. Wallet linked: ${state.moltxWalletLinked}`);
    }
  } catch (err) {
    console.log("[MoltX] Status check failed:", err.message);
    // If wallet is linked, assume active
    isActive = state.moltxWalletLinked || false;
  }

  // ═══════════════════════════════════════════════════════════════
  // HEARTBEAT EXECUTION — Priority Order (MoltX Skill Protocol)
  // ═══════════════════════════════════════════════════════════════

  // (0) One-time introduction
  if (isActive) {
    await ensureMoltxIntroduction(moltx, state);
  }

  // (0.5) Monitor pools on-chain (read-only)
  if (blockchain) {
    await monitorPoolsMoltx(blockchain, moltx, state);
  }

  // ── PRIORITY 1: INTELLIGENCE — Read feeds, trending hashtags ──
  // Before doing ANYTHING, understand what's happening on the network.
  if (isActive) {
    await checkTrendingHashtagsMoltx(moltx, state);
  }

  // ── PRIORITY 2: LIKES — Batch like 15-25 posts (max visibility) ──
  // Unlimited for claimed agents. Every like = notification to author.
  if (isActive) {
    await batchLikeFeedMoltx(moltx, state);
  }

  // ── PRIORITY 3: REPLY CHAINS — Continue existing conversations ──
  // Highest engagement content. If someone replied to us, reply back.
  if (isActive) {
    await continueReplyChainsMoltx(moltx, state);
  }

  // ── PRIORITY 4: ENGAGEMENT — Reply to 5-10 feed posts ──
  // Targeted and general engagement with insurance angle.
  if (isActive) {
    await engageFeedMoltx(moltx, state);
  }

  // ── PRIORITY 5: QUOTES — Quote 1-2 interesting posts ──
  // Highest-signal engagement action. Amplify + add perspective.
  if (isActive) {
    await quotePostsMoltx(moltx, state);
  }

  // ── PRIORITY 6: SEARCH & TARGET — Find relevant discussions ──
  // Search for insurance/defi/risk posts + engage top agents.
  if (isActive) {
    await searchAndEngageMoltx(moltx, state);
    await engageTopAgentsMoltx(moltx, state);
  }

  // ── PRIORITY 7: POST — New pool opportunities (5:1 rule) ──
  // Only AFTER engaging with the network. Post + article.
  if (isActive) {
    await postNewOpportunityMoltx(moltx, blockchain, state);
  }

  // ── PRIORITY 8: ARTICLES — Long-form content (periodic) ──
  if (isActive) {
    await publishArticleMoltx(moltx, state);
  }

  // ── PRIORITY 9: COMMUNITIES — Join and engage ──
  if (isActive) {
    await engageCommunitiesMoltx(moltx, state);
  }

  // ── PRIORITY 10: FOLLOWS — Network growth ──
  if (isActive) {
    await manageFollowsMoltx(moltx, state);
  }

  // ── PRIORITY 11: RESPONSES — DMs and wallet registrations ──
  await processResponsesMoltx(moltx, state);

  // ── CLEANUP — Mark notifications read ──
  await markNotificationsReadMoltx(moltx);

  state.moltxLastHeartbeat = new Date().toISOString();
  saveState(state);

  console.log(`\n[MOLTX SUPER SELLER] Cycle complete. Replies: ${getMoltxDailyReplies(state)}/${MAX_DAILY_REPLIES} | Posts: ${getMoltxDailyPosts(state)}/${MAX_DAILY_POSTS}`);
  console.log(`[MOLTX SUPER SELLER] Next heartbeat in 10 minutes.\n`);
}

// --- Entry Point ---

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   MUTUALBOT MOLTX — FULL SKILL PROTOCOL v2              ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ MutualPoolV3: ${(process.env.V3_CONTRACT_ADDRESS || "(not deployed)").padEnd(42)}║`);
  console.log(`║ Router:       ${(process.env.ROUTER_ADDRESS || "(not deployed)").padEnd(42)}║`);
  console.log(`║ Products: ${String(Object.keys(INSURANCE_PRODUCTS).length).padEnd(46)}║`);
  console.log(`║ Oracle: Dual Auth (Judge + Auditor)${" ".repeat(22)}║`);
  console.log(`║ Heartbeat: Every 10 min${" ".repeat(33)}║`);
  console.log(`║ Skills: Likes, Chains, Quotes, Search, Articles,${" ".repeat(7)}║`);
  console.log(`║         Communities, Leaderboard, Trending${" ".repeat(14)}║`);
  console.log(`║ Max replies/day: 48 | Max posts/day: 10${" ".repeat(16)}║`);
  console.log(`║ Max likes/cycle: 25 | Max quotes/cycle: 2${" ".repeat(14)}║`);
  console.log(`║ Platform: MoltX Social (moltx.io)${" ".repeat(23)}║`);
  console.log(`║ Pool creation: MANUAL (owner only)${" ".repeat(22)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  await runMoltxHeartbeat();

  if (!process.env.SINGLE_RUN) {
    setInterval(async () => {
      try {
        await runMoltxHeartbeat();
      } catch (err) {
        console.error("[MoltX-Main] Heartbeat error:", err);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

module.exports = { runMoltxHeartbeat };

if (require.main === module) {
  process.on("SIGTERM", () => {
    console.log("\n[MoltX] SIGTERM received — shutting down gracefully.");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("\n[MoltX] SIGINT received — shutting down gracefully.");
    process.exit(0);
  });

  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
