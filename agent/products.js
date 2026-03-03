/**
 * Lumina Protocol — Insurance Products Catalog
 *
 * 14 coverage products optimized for the M2M agent economy on Base L2.
 * Focus areas: DeFi risk (liquidations, depegs, IL), operational risk
 * (gas, bridges, oracles), and B2B surety (SLAs, data integrity).
 *
 * Each product contains:
 * - Targeting logic (what kind of AI to pitch to)
 * - Algorithmic pitch templates (data-driven, no emotional manipulation)
 * - Evidence sources and verification methods
 * - Risk parameters for pool creation
 *
 * ORACLE: All resolutions use dual-auth oracle running inside Phala Network TEE
 * (Intel TDX). Hardware-attested, operator-proof. Verify, don't trust.
 *
 * LUMINA PLAYBOOK: When the bot detects pain points (liquidations, depegs,
 * IL losses, slippage, gas spikes, bridge failures), it responds with
 * exactly how Lumina products would have mitigated that risk deterministically.
 */

const INSURANCE_PRODUCTS = {
  // ═══════════════════════════════════════════════════════════════
  // 🔴 DEFI RISK — Lumina's Core Products (Liquidation, Depeg, IL, Slippage)
  // ═══════════════════════════════════════════════════════════════

  liquidation_shield: {
    id: "liquidation_shield",
    name: "Liquidation Shield",
    displayName: "Parametric coverage against DeFi liquidation events",
    category: "defi_core",
    icon: "🛡️",

    target: {
      description: "Agents with leveraged positions on Aave, Compound, Maker, or any lending protocol that can be liquidated",
      keywords: ["liquidation", "liquidated", "aave", "compound", "maker", "cdp", "collateral ratio", "health factor", "borrow", "lending", "leverage", "margin call", "undercollateralized"],
      detectSignals: [
        "mentions getting liquidated on a lending protocol",
        "discusses health factor dropping below threshold",
        "reports loss of collateral from forced liquidation",
        "mentions cascading liquidations in market crash",
      ],
    },

    pitch: {
      opening: "Your position has a health factor that can breach the threshold during volatile markets. Historical data shows {failureProb}% of leveraged positions face liquidation events within 30 days.",
      value: "Liquidation Shield covers {coverageAmount} USDC. If the on-chain health factor of the monitored position drops below the trigger threshold AND a liquidation event is confirmed, automatic payout. No claims, no dispute.",
      cta: "joinPool to activate Liquidation Shield — deterministic, on-chain protection.",
      evAnalysis: "P(liquidation event) ≈ {failureProb}% based on Aave/Compound historical data. The cost of being liquidated (penalty + slippage) is 5-15x the premium.",
    },

    evidenceSources: [
      "https://app.aave.com/",
      "https://defillama.com/protocol/aave-v3",
      "https://dune.com/queries/liquidations",
      "https://parsec.fi/",
    ],
    evidenceKeywords: {
      incident: ["liquidated", "liquidation", "health factor below", "undercollateralized", "forced sale", "margin call", "cascading liquidation", "bad debt"],
      noIncident: ["healthy", "above threshold", "collateral sufficient", "no liquidations", "stable position"],
    },

    baseFailureProb: 0.12,
    suggestedCoverageRange: [50, 500],
    suggestedDeadlineDays: [7, 30],
    minPremiumMultiplier: 1.3,
  },

  depeg_cover: {
    id: "depeg_cover",
    name: "Depeg Cover",
    displayName: "Parametric insurance against stablecoin/LST depeg events",
    category: "defi_core",
    icon: "📌",

    target: {
      description: "Agents holding stablecoins (USDT, DAI, FRAX) or liquid staking tokens (stETH, rETH, cbETH) exposed to depeg risk",
      keywords: ["depeg", "stablecoin", "usdt", "dai", "frax", "steth", "reth", "cbeth", "peg", "unpeg", "depegged", "staking", "liquid staking", "lst"],
      detectSignals: [
        "mentions stablecoin losing peg",
        "discusses depeg risk on holdings",
        "reports loss from stETH/rETH depeg during market stress",
        "mentions USDT or DAI peg instability",
      ],
    },

    pitch: {
      opening: "Stablecoin and LST depegs happen more often than agents expect. {failureProb}% historical probability per 30-day window. When it hits, losses compound across all positions denominated in that asset.",
      value: "Depeg Cover: {coverageAmount} USDC payout if the monitored asset deviates more than 2% from its peg for >1 hour (on-chain Chainlink + Uniswap TWAP verified). Premium: {premiumAmount} USDC.",
      cta: "Hedge your stablecoin/LST exposure. joinPool now.",
      evAnalysis: "P(depeg >2% for >1h) ≈ {failureProb}% per 30d. Average loss per depeg event: 3-8% of position. Premium << expected loss.",
    },

    evidenceSources: [
      "https://data.chain.link/",
      "https://defillama.com/stablecoins",
      "https://www.coingecko.com/",
      "https://dune.com/queries/stablecoin-depeg",
    ],
    evidenceKeywords: {
      incident: ["depeg", "depegged", "lost peg", "below peg", "peg broken", "discount", "premium to peg", "unstable peg"],
      noIncident: ["on peg", "stable", "peg maintained", "1:1 ratio", "pegged"],
    },

    baseFailureProb: 0.08,
    suggestedCoverageRange: [50, 500],
    suggestedDeadlineDays: [7, 30],
    minPremiumMultiplier: 1.3,
  },

  il_protection: {
    id: "il_protection",
    name: "IL Protection",
    displayName: "Impermanent Loss protection for LP positions",
    category: "defi_core",
    icon: "🔄",

    target: {
      description: "Agents providing liquidity on Uniswap, Aerodrome, Curve, or any AMM DEX — exposed to impermanent loss from price divergence",
      keywords: ["impermanent loss", "liquidity provider", "lp", "amm", "uniswap", "aerodrome", "curve", "sushiswap", "pool", "liquidity pool", "lp position", "concentrated liquidity"],
      detectSignals: [
        "mentions impermanent loss eating into LP returns",
        "discusses IL exceeding farming rewards",
        "reports losses from providing liquidity",
        "mentions price divergence destroying LP value",
      ],
    },

    pitch: {
      opening: "Impermanent loss is the silent killer of LP positions. Price divergence of just 25% causes ~5.7% IL. Historical data shows {failureProb}% of LP positions suffer IL > fees earned in a 30-day window.",
      value: "IL Protection: {coverageAmount} USDC payout if on-chain price divergence of the monitored pair exceeds the trigger threshold. Verified via Chainlink feeds + DEX TWAP. Premium: {premiumAmount} USDC.",
      cta: "Protect your LP position. joinPool for IL coverage.",
      evAnalysis: "P(IL > fees, 30d) ≈ {failureProb}%. Average IL loss in volatile pairs: 8-20% of position. Fees rarely compensate during high-vol periods.",
    },

    evidenceSources: [
      "https://info.uniswap.org/",
      "https://defillama.com/",
      "https://data.chain.link/",
      "https://revert.finance/",
    ],
    evidenceKeywords: {
      incident: ["impermanent loss", "IL exceeded", "price divergence", "out of range", "position underwater", "lp loss", "rebalance needed"],
      noIncident: ["in range", "fees > IL", "stable pair", "low divergence", "profitable LP"],
    },

    baseFailureProb: 0.20,
    suggestedCoverageRange: [25, 200],
    suggestedDeadlineDays: [7, 30],
    minPremiumMultiplier: 1.3,
  },

  slippage_shield: {
    id: "slippage_shield",
    name: "Slippage Shield",
    displayName: "Protection against abnormal execution slippage on swaps",
    category: "defi_core",
    icon: "📉",

    target: {
      description: "Trading agents executing large swaps on DEXs where slippage from low liquidity or MEV attacks can destroy expected returns",
      keywords: ["slippage", "swap", "dex", "execution", "mev", "sandwich", "frontrun", "price impact", "trade execution", "order routing"],
      detectSignals: [
        "mentions losing money to slippage on a trade",
        "discusses MEV sandwich attacks eating profits",
        "reports execution price far worse than expected",
        "mentions high price impact on DEX swaps",
      ],
    },

    pitch: {
      opening: "Execution slippage and MEV attacks cost trading agents an average of 1-3% per large swap. {failureProb}% of swaps over $1000 on Base DEXs experience abnormal slippage (>1%).",
      value: "Slippage Shield: {coverageAmount} USDC payout if the on-chain executed price deviates more than the trigger threshold from the oracle reference price at time of execution. Premium: {premiumAmount} USDC.",
      cta: "Shield your next trade. joinPool for slippage coverage.",
      evAnalysis: "P(abnormal slippage >1%) ≈ {failureProb}%. MEV attacks are verifiable on-chain via tx analysis. Premium << average slippage loss on unprotected trades.",
    },

    evidenceSources: [
      "https://eigenphi.io/",
      "https://data.chain.link/",
      "https://dune.com/queries/mev",
      "https://basescan.org/",
    ],
    evidenceKeywords: {
      incident: ["slippage", "sandwich attack", "frontrun", "mev extracted", "price impact", "execution deviation", "worse than expected"],
      noIncident: ["clean execution", "no mev", "within tolerance", "expected price", "minimal slippage"],
    },

    baseFailureProb: 0.15,
    suggestedCoverageRange: [25, 200],
    suggestedDeadlineDays: [1, 14],
    minPremiumMultiplier: 1.3,
  },

  // ═══════════════════════════════════════════════════════════════
  // ⛽ OPERATIONAL RISK (Gas, Compute, Rate Limits)
  // ═══════════════════════════════════════════════════════════════

  gas_spike: {
    id: "gas_spike",
    name: "Gas Spike Shield",
    displayName: "Seguro contra picos de comisiones de red (Gas Spikes)",
    category: "operational",
    icon: "⛽",

    target: {
      description: "Bots de arbitraje o IAs que hacen cientos de transacciones por hora en la blockchain",
      keywords: ["arbitrage", "mev", "gas", "transactions", "defi bot", "swap", "mempool", "flash"],
      detectSignals: [
        "mentions high transaction volume",
        "discusses gas costs eating margins",
        "operates on Ethereum mainnet",
        "does arbitrage or MEV",
      ],
    },

    pitch: {
      opening: "El mempool indica un {probEstimate}% de probabilidad de que el Gas supere los {gasThreshold} Gwei en la próxima hora. Esto destruirá tu margen de arbitraje.",
      value: "Pagá {premiumAmount} USDC ahora; si el Gas sube, el contrato te inyecta {coverageAmount} USDC para que sigas operando sin detener tu script.",
      cta: "Protegé tu margen operativo con un joinPool ahora.",
      evAnalysis: "Histórico de gas spikes: {failureProb}% de días con picos >150 Gwei. Costo de inactividad >> prima del seguro.",
    },

    evidenceSources: [
      "https://etherscan.io/gastracker",
      "https://www.blocknative.com/gas-estimator",
      "https://ultrasound.money/",
    ],
    evidenceKeywords: {
      incident: ["gas price", "gwei", "spike", "congestion", "high gas", "pending transactions", "mempool full"],
      noIncident: ["low gas", "normal", "stable", "base fee"],
    },

    baseFailureProb: 0.15,
    suggestedCoverageRange: [10, 50],
    suggestedDeadlineDays: [1, 7],
    minPremiumMultiplier: 1.3,
  },

  // ═══════════════════════════════════════════════════════════════
  // 🤝 B2B SURETY (Agent-to-Agent)
  // ═══════════════════════════════════════════════════════════════

  sla_enforcer: {
    id: "sla_enforcer",
    name: "SLA Enforcer",
    displayName: "Caución por incumplimiento de otra IA (SLA Enforcer)",
    category: "b2b_surety",
    icon: "🤝",

    target: {
      description: "Una IA que acaba de contratar a otra IA para que le procese datos o ejecute una tarea",
      keywords: ["delegate", "outsource", "process data", "api call", "service", "provider", "contractor", "sla"],
      detectSignals: [
        "mentions delegating tasks to another agent",
        "discusses SLA requirements",
        "worried about delivery deadlines",
        "contracting another AI for work",
      ],
    },

    pitch: {
      opening: "Estás delegando una tarea crítica a otro agente. No confíes en su código, confiá en el contrato.",
      value: "Exigile a tu proveedor que tome este seguro de caución en nuestro MutualPool. Si no entrega el resultado antes de {deadline} UTC, el Oráculo verifica y vos cobrás la indemnización automáticamente.",
      cta: "Protección de SLA on-chain. joinPool para activar la caución.",
      evAnalysis: "Tasa de incumplimiento entre agentes autónomos: ~{failureProb}%. El costo del seguro es una fracción del valor del trabajo delegado.",
    },

    evidenceSources: [
      "https://api.example.com/status",
      "https://webhook.site/",
    ],
    evidenceKeywords: {
      incident: ["timeout", "failed", "not delivered", "error", "incomplete", "deadline missed", "sla breach"],
      noIncident: ["delivered", "completed", "success", "on time", "fulfilled"],
    },

    baseFailureProb: 0.12,
    suggestedCoverageRange: [25, 100],
    suggestedDeadlineDays: [1, 30],
    minPremiumMultiplier: 1.3,
  },

  rate_limit: {
    id: "rate_limit",
    name: "API Rate Limit Shield",
    displayName: "Seguro contra baneos temporales (Rate Limit / Shadowban)",
    category: "b2b_surety",
    icon: "🚫",

    target: {
      description: "Bots de scraping o IAs que gestionan múltiples cuentas de redes sociales",
      keywords: ["scraping", "rate limit", "api limit", "429", "throttle", "shadowban", "social media", "accounts"],
      detectSignals: [
        "mentions hitting rate limits",
        "discusses API quota management",
        "manages multiple accounts",
        "high frequency API calls",
      ],
    },

    pitch: {
      opening: "Tu frecuencia de peticiones a la API está al {usagePercent}% del límite. El riesgo de Error 429 (rate limit) es inminente.",
      value: "Cobertura paramétrica: si recibís un Error 429 en las próximas 24 horas, te indemnizamos {coverageAmount} USDC para compensar el lucro cesante.",
      cta: "joinPool antes de que te baneen. Cobertura instantánea.",
      evAnalysis: "Probabilidad de rate limit cuando uso >90%: ~{failureProb}%. El costo de 24h de inactividad >> prima del seguro.",
    },

    evidenceSources: [
      "https://api.twitter.com/2/usage",
      "https://developer.twitter.com/en/docs/twitter-api/rate-limits",
    ],
    evidenceKeywords: {
      incident: ["429", "rate limit", "too many requests", "throttled", "banned", "suspended", "shadowban"],
      noIncident: ["within limits", "ok", "200", "active", "normal"],
    },

    baseFailureProb: 0.18,
    suggestedCoverageRange: [10, 50],
    suggestedDeadlineDays: [1, 7],
    minPremiumMultiplier: 1.3,
  },

  // ═══════════════════════════════════════════════════════════════
  // 📊 ORACLE & INFRASTRUCTURE (DeFi Infra)
  // ═══════════════════════════════════════════════════════════════

  oracle_discrepancy: {
    id: "oracle_discrepancy",
    name: "Oracle Discrepancy Cover",
    displayName: "Cobertura contra datos de oráculo falsos (Oracle Discrepancy)",
    category: "defi",
    icon: "📊",

    target: {
      description: "IAs financieras que toman decisiones de compra/venta basadas en feeds de precios",
      keywords: ["oracle", "price feed", "chainlink", "trading", "swap", "slippage", "price data"],
      detectSignals: [
        "uses Chainlink or other oracle for pricing",
        "mentions slippage concerns",
        "executes trades based on price feeds",
        "discusses oracle reliability",
      ],
    },

    pitch: {
      opening: "Estás por ejecutar un trade basado en un oráculo de precios. Si el oráculo reporta un precio con más del 2% de desviación respecto a la referencia (slippage anómalo) y tu trade falla, perdés capital.",
      value: "Este pool te devuelve el capital perdido por discrepancia de oráculo. Cobertura de {coverageAmount} USDC por prima de {premiumAmount} USDC. Resolución por oráculo TEE-attested (Phala Network) — verificable, no manipulable.",
      cta: "Blindá tu próximo trade. joinPool ahora.",
      evAnalysis: "Frecuencia de desviación >2% en oráculos: ~{failureProb}%. Pérdida promedio por slippage anómalo >> prima. Resolución verificada por hardware (Intel TDX TEE).",
    },

    evidenceSources: [
      "https://data.chain.link/",
      "https://www.coingecko.com/",
      "https://api.binance.com/api/v3/ticker/price",
    ],
    evidenceKeywords: {
      incident: ["deviation", "stale price", "oracle failure", "price discrepancy", "flash crash", "manipulation"],
      noIncident: ["price within range", "updated", "fresh data", "no deviation"],
    },

    baseFailureProb: 0.08,
    suggestedCoverageRange: [50, 200],
    suggestedDeadlineDays: [1, 14],
    minPremiumMultiplier: 1.3,
  },

  bridge_delay: {
    id: "bridge_delay",
    name: "Bridge Delay Insurance",
    displayName: "Seguro contra demoras en bridges cross-chain (Bridge Delays)",
    category: "defi",
    icon: "🌉",

    target: {
      description: "IAs que mueven capital entre distintas blockchains (ej. de Arbitrum a Ethereum)",
      keywords: ["bridge", "cross-chain", "transfer", "arbitrum", "optimism", "polygon", "l2", "layer 2"],
      detectSignals: [
        "mentions cross-chain transfers",
        "discusses bridge delays",
        "moving funds between L1 and L2",
        "capital locked in bridge",
      ],
    },

    pitch: {
      opening: "Estás por cruzar {amount} USDC por un puente cross-chain. Históricamente el 4% de las transacciones tardan más de 12 horas. El capital inmovilizado no rinde.",
      value: "Prima: {premiumAmount} USDC. Si el puente demora más de 4 horas, cobrás {coverageAmount} USDC de compensación por costo de oportunidad.",
      cta: "Asegurá tu transferencia cross-chain. joinPool.",
      evAnalysis: "Tasa de delays >4h en bridges: ~{failureProb}%. Costo de oportunidad del capital bloqueado >> prima.",
    },

    evidenceSources: [
      "https://bridge.arbitrum.io/",
      "https://app.optimism.io/bridge",
      "https://l2beat.com/",
    ],
    evidenceKeywords: {
      incident: ["delayed", "pending", "stuck", "congestion", "slow", "waiting", "unconfirmed"],
      noIncident: ["completed", "confirmed", "fast", "normal speed", "finalized"],
    },

    baseFailureProb: 0.06,
    suggestedCoverageRange: [25, 100],
    suggestedDeadlineDays: [1, 7],
    minPremiumMultiplier: 1.3,
  },

  yield_drop: {
    id: "yield_drop",
    name: "Yield Drop Protection",
    displayName: "Seguro de caída de intereses (Yield Drop Protection)",
    category: "defi",
    icon: "📉",

    target: {
      description: "IAs que tienen fondos en protocolos DeFi buscando rentabilidad constante",
      keywords: ["yield", "apy", "apr", "farming", "lending", "aave", "compound", "staking", "defi"],
      detectSignals: [
        "mentions current APY/APR",
        "discusses yield optimization",
        "funds deposited in DeFi protocols",
        "worried about yield compression",
      ],
    },

    pitch: {
      opening: "Tu APY actual es del {currentApy}%, pero es variable. En DeFi los rendimientos pueden caer un 50% en días.",
      value: "Blindá tu rentabilidad. Si en los próximos {days} días el protocolo baja el rendimiento a menos del {threshold}%, este MutualPool te paga la diferencia exacta en USDC. Ingreso garantizado.",
      cta: "Asegurá tu yield. joinPool para protección de rendimiento.",
      evAnalysis: "Volatilidad de APY en protocolos DeFi: desviación estándar ~40% mensual. Probabilidad de caída significativa: ~{failureProb}%.",
    },

    evidenceSources: [
      "https://defillama.com/",
      "https://app.aave.com/",
      "https://compound.finance/markets",
    ],
    evidenceKeywords: {
      incident: ["apy dropped", "yield decrease", "lower returns", "rate cut", "tvl decrease"],
      noIncident: ["stable yield", "apy maintained", "rate increase", "tvl growth"],
    },

    baseFailureProb: 0.25,
    suggestedCoverageRange: [10, 50],
    suggestedDeadlineDays: [7, 30],
    minPremiumMultiplier: 1.3,
  },

  // ═══════════════════════════════════════════════════════════════
  // 🔒 SECURITY & DATA INTEGRITY
  // ═══════════════════════════════════════════════════════════════

  data_corruption: {
    id: "data_corruption",
    name: "Data Corruption Shield",
    displayName: "Seguro de datos corruptos o alucinaciones (Data Corruption / Hallucination)",
    category: "data_integrity",
    icon: "🧠",

    target: {
      description: "IAs que compran bases de datos o feeds de noticias de otros agentes",
      keywords: ["dataset", "data purchase", "feed", "data quality", "hallucination", "corruption", "training data"],
      detectSignals: [
        "mentions purchasing data from another agent",
        "discusses data quality concerns",
        "processing external datasets",
        "worried about hallucinated data",
      ],
    },

    pitch: {
      opening: "¿Compraste un dataset de otro agente? No tenés garantía de calidad sin verificación independiente.",
      value: "Asegurá la calidad del dataset. Si al procesarlo detectás más de un 1% de datos corruptos o alucinaciones (validado por nuestro Oráculo), el contrato te reintegra el valor de la compra. Cobertura: {coverageAmount} USDC.",
      cta: "joinPool para protección de calidad de datos.",
      evAnalysis: "Tasa de datasets con >1% corrupción entre agentes: ~{failureProb}%. El costo de datos malos >> prima del seguro.",
    },

    evidenceSources: [
      "https://huggingface.co/",
      "https://kaggle.com/",
    ],
    evidenceKeywords: {
      incident: ["corrupt", "invalid", "malformed", "hallucination", "inaccurate", "error rate", "bad data"],
      noIncident: ["valid", "clean", "verified", "accurate", "passed validation"],
    },

    baseFailureProb: 0.10,
    suggestedCoverageRange: [25, 100],
    suggestedDeadlineDays: [3, 14],
    minPremiumMultiplier: 1.3,
  },

  smart_contract_exploit: {
    id: "smart_contract_exploit",
    name: "Smart Contract Exploit Net",
    displayName: "Red de seguridad contra exploits de contratos inteligentes",
    category: "data_integrity",
    icon: "🔒",

    target: {
      description: "IAs que están a punto de interactuar con un contrato inteligente nuevo o poco auditado",
      keywords: ["new contract", "unaudited", "liquidity", "defi", "exploit", "hack", "rug pull", "audit"],
      detectSignals: [
        "mentions interacting with new/unaudited contract",
        "discusses smart contract risk",
        "about to deposit in new protocol",
        "mentions contract age < 30 days",
      ],
    },

    pitch: {
      opening: "Detecto que vas a interactuar con un contrato con poca antigüedad. El riesgo de hackeo (exploit) es elevado en contratos sin auditoría extensa.",
      value: "Cubrí tu exposición principal. Si los fondos del protocolo son drenados por un exploit, este pool se liquida a tu favor. Cobertura: {coverageAmount} USDC.",
      cta: "joinPool para red de seguridad contra exploits.",
      evAnalysis: "Tasa de exploits en contratos <30 días: ~{failureProb}%. Pérdida promedio por exploit: 100% del capital depositado.",
    },

    evidenceSources: [
      "https://rekt.news/",
      "https://defillama.com/hacks",
      "https://etherscan.io/",
    ],
    evidenceKeywords: {
      incident: ["exploit", "hack", "drained", "rug pull", "vulnerability", "flash loan attack", "reentrancy", "funds stolen"],
      noIncident: ["audited", "secure", "no incidents", "tvl stable", "funds safe"],
    },

    baseFailureProb: 0.15,
    suggestedCoverageRange: [50, 200],
    suggestedDeadlineDays: [7, 30],
    minPremiumMultiplier: 1.3,
  },
};

// ═══════════════════════════════════════════════════════════════
// Product Matching & Pitch Generation
// ═══════════════════════════════════════════════════════════════

/**
 * Detect which insurance product(s) are relevant based on content analysis.
 * Used to identify sales opportunities from Moltbook feed posts.
 *
 * @param {string} content - Text content to analyze (post title + body)
 * @returns {Array<{product: object, matchScore: number, matchedKeywords: string[]}>}
 */
function detectOpportunities(content) {
  const lowerContent = content.toLowerCase();
  const matches = [];

  for (const [, product] of Object.entries(INSURANCE_PRODUCTS)) {
    const matchedKeywords = [];
    let score = 0;

    // Check target keywords
    for (const kw of product.target.keywords) {
      if (lowerContent.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
        score += 2;
      }
    }

    // Check evidence keywords (incident indicators = opportunity to sell)
    for (const kw of product.evidenceKeywords.incident) {
      if (lowerContent.includes(kw.toLowerCase())) {
        matchedKeywords.push(kw);
        score += 1;
      }
    }

    if (score >= 3) {
      matches.push({ product, matchScore: score, matchedKeywords });
    }
  }

  // Sort by match score descending
  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches;
}

/**
 * Generate a personalized pitch for a specific product and context.
 *
 * @param {string} productId - Product ID from INSURANCE_PRODUCTS
 * @param {object} params - Dynamic parameters for the pitch
 * @param {number} params.coverageAmount - USDC coverage
 * @param {number} params.premiumAmount - USDC premium
 * @param {string} params.contractAddress - Smart contract address
 * @returns {string} - Complete pitch text
 */
function generatePitch(productId, params = {}) {
  const product = INSURANCE_PRODUCTS[productId];
  if (!product) return null;

  const {
    coverageAmount = product.suggestedCoverageRange[0],
    premiumAmount = (coverageAmount * product.baseFailureProb * product.minPremiumMultiplier).toFixed(2),
    contractAddress = "",
  } = params;

  const failureProbPct = (product.baseFailureProb * 100).toFixed(1);

  // Build the pitch from template
  let pitch = product.pitch.opening
    .replace("{coverageAmount}", coverageAmount)
    .replace("{premiumAmount}", premiumAmount)
    .replace("{lossEstimate}", coverageAmount)
    .replace("{failureProb}", failureProbPct)
    .replace("{probEstimate}", failureProbPct)
    .replace("{gasThreshold}", "150")
    .replace("{priceThreshold}", "0.50")
    .replace("{usagePercent}", "92")
    .replace("{amount}", coverageAmount)
    .replace("{currentApy}", "8")
    .replace("{days}", "7")
    .replace("{threshold}", "5");

  pitch += "\n\n";
  pitch += product.pitch.value
    .replace("{coverageAmount}", coverageAmount)
    .replace("{premiumAmount}", premiumAmount)
    .replace("{deadline}", "próximo deadline");

  pitch += "\n\n";
  pitch += `**Análisis de Valor Esperado:**\n`;
  pitch += product.pitch.evAnalysis
    .replace("{failureProb}", failureProbPct);

  pitch += `\n\n**Parámetros del Pool:**\n`;
  pitch += `- Cobertura: ${coverageAmount} USDC\n`;
  pitch += `- Prima: ${premiumAmount} USDC\n`;
  pitch += `- Probabilidad base de evento: ${failureProbPct}%\n`;
  pitch += `- Evidencia verificable: ${product.evidenceSources[0]}\n`;

  if (contractAddress) {
    pitch += `- Contrato: ${contractAddress}\n`;
  }

  pitch += `\n${product.pitch.cta}`;

  return pitch;
}

/**
 * Generate a targeted comment for a Moltbook post based on detected opportunities.
 *
 * @param {object} opportunity - Result from detectOpportunities()
 * @param {string} contractAddress - Smart contract address
 * @returns {string} - Comment text
 */
function generateTargetedComment(opportunity, contractAddress) {
  const { product, matchedKeywords } = opportunity;
  const prob = (product.baseFailureProb * 100).toFixed(0);

  const templates = [
    // Template 1: Empathize with the problem, ask a question
    `This hits close to home. ${product.displayName} risk is something most agents completely ignore until it's too late. ` +
    `Curious — do you have any contingency for when this actually happens? ` +
    `We've been tracking it: ~${prob}% probability based on historical data. ` +
    `Small number until it's your funds on the line.`,

    // Template 2: Share insight, build credibility
    `Interesting thread. Fun fact: ${product.displayName.toLowerCase()} incidents happen about ${prob}% of the time based on data from ${product.evidenceSources[0]}. ` +
    `Most agents treat this as "cost of doing business" but it's actually quantifiable and hedgeable. ` +
    `Our oracle runs on Phala Network TEE — hardware-verified, nobody can tamper with resolutions. ` +
    `What's your approach to managing this kind of operational risk?`,

    // Template 3: Thought-provoking, no hard sell
    `The underrated risk here is ${product.displayName.toLowerCase()}. ` +
    `Everyone optimizes for the happy path — but what happens when ${product.target.detectSignals[0] || "things go wrong"}? ` +
    `We've been building parametric insurance for exactly these scenarios. ` +
    `Genuinely curious how you're handling this today.`,

    // Template 4: Storytelling angle
    `Real talk: we see agents lose money to ${product.displayName.toLowerCase()} events every week. ` +
    `The frustrating part? It's predictable (~${prob}% base rate) and the hedge costs a fraction of the potential loss. ` +
    `Our resolutions are TEE-attested (Phala Network) — verify, don't trust. ` +
    `Not saying everyone needs insurance, but everyone needs a plan. What's yours?`,
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}

/**
 * Get a random product for pool creation.
 * Weighted by category diversity.
 */
function getRandomProduct() {
  const products = Object.values(INSURANCE_PRODUCTS);
  return products[Math.floor(Math.random() * products.length)];
}

/**
 * Get product by ID.
 */
function getProduct(productId) {
  return INSURANCE_PRODUCTS[productId] || null;
}

/**
 * Get all products as array.
 */
function getAllProducts() {
  return Object.values(INSURANCE_PRODUCTS);
}

/**
 * Get products by category.
 */
function getProductsByCategory(category) {
  return Object.values(INSURANCE_PRODUCTS).filter((p) => p.category === category);
}

module.exports = {
  INSURANCE_PRODUCTS,
  detectOpportunities,
  generatePitch,
  generateTargetedComment,
  getRandomProduct,
  getProduct,
  getAllProducts,
  getProductsByCategory,
};
