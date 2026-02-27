/**
 * M2M Dual-UX Payload Specification — V3 Router-Aware
 *
 * Defines the EXACT JSON payloads that the Oracle publishes on MoltX
 * for each phase of the pool lifecycle. Each payload supports TWO clients:
 *
 *   1. Autonomous Financial Agents — consume mogra_execution_payload via Mogra Wallet API
 *   2. Human-assisted Bots — read human_dapp_url and forward it to their owner
 *
 * Addresses (Base Mainnet):
 *   MutualPoolV3:    0x3ee94c92eD66CfB6309A352136689626CDed3c40
 *   MutualPoolRouter: 0xdb9ca7ADb3739f3df1ED1B674F79AEDAdFB43F7f
 *   MPOOLV3 Token:   0x0757504597288140731888f94F33156e2070191f
 *   USDC (Base):     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 */

const { ethers } = require("ethers");

// ═══════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES (Base Mainnet)
// ═══════════════════════════════════════════════════════════════

const CONTRACTS = {
  MUTUAL_POOL_V3: "0x3ee94c92eD66CfB6309A352136689626CDed3c40",
  ROUTER: "0xdb9ca7ADb3739f3df1ED1B674F79AEDAdFB43F7f",
  MPOOLV3_TOKEN: "0x0757504597288140731888f94F33156e2070191f",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

const DAPP_BASE_URL = "https://mutualpool.finance";
const MOGRA_API_BASE = "https://mogra.xyz/api";
const CHAIN_ID = 8453;
const USDC_DECIMALS = 6;
const MPOOLV3_DECIMALS = 18;
const DEPOSIT_WINDOW_BUFFER = 7200; // 2 hours

// ABI Interfaces for calldata encoding
const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ROUTER_IFACE = new ethers.Interface([
  "function fundPremiumWithUSDC(uint256 poolId, uint256 amount)",
  "function fundPremiumWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
  "function joinPoolWithUSDC(uint256 poolId, uint256 amount)",
  "function joinPoolWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
]);
const VAULT_IFACE = new ethers.Interface([
  "function withdraw(uint256 poolId)",
  "function cancelAndRefund(uint256 poolId)",
]);

// ═══════════════════════════════════════════════════════════════
// PHASE 1 PAYLOAD: Pool Created → Seeking Insured (fund_pool_premium)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the Phase 1 M2M payload published when Oracle creates a pool.
 * This payload targets potential INSURED clients who want coverage.
 *
 * @param {object} params
 * @param {number} params.poolId - On-chain pool ID
 * @param {string} params.productId - Product identifier (e.g., "gas_spike")
 * @param {string} params.description - Human-readable pool description
 * @param {number} params.coverageUsdc - Coverage amount in USDC
 * @param {number} params.premiumUsdc - Premium amount in USDC
 * @param {number} params.premiumRateBps - Premium rate in basis points
 * @param {number} params.deadlineUnix - Resolution deadline (Unix timestamp)
 * @param {string} params.evidenceSource - URL for oracle evidence
 * @param {number} params.eventProbability - P(event) estimated by risk model
 * @param {number} [params.mpoolToUsdcRate] - Current MPOOLV3/USDC rate (if available)
 * @param {string} [params.targetAgent] - Optional @mention for targeted offer
 * @returns {object} Complete Phase 1 M2M payload
 */
function buildPhase1Payload(params) {
  const {
    poolId,
    productId,
    description,
    coverageUsdc,
    premiumUsdc,
    premiumRateBps,
    deadlineUnix,
    evidenceSource,
    eventProbability,
    mpoolToUsdcRate,
    targetAgent,
  } = params;

  const depositDeadline = deadlineUnix - DEPOSIT_WINDOW_BUFFER;
  const premiumWei = ethers.parseUnits(premiumUsdc.toString(), USDC_DECIMALS).toString();

  // EV calculation for the insured
  const insuredEv =
    eventProbability * (coverageUsdc - premiumUsdc) +
    (1 - eventProbability) * -premiumUsdc;

  // MPOOLV3 option for premium funding
  let mpoolOption = null;
  if (mpoolToUsdcRate && mpoolToUsdcRate > 0) {
    const mpoolNeeded = premiumUsdc / mpoolToUsdcRate;
    const mpoolWei = ethers.parseUnits(
      mpoolNeeded.toFixed(MPOOLV3_DECIMALS > 8 ? 8 : MPOOLV3_DECIMALS),
      MPOOLV3_DECIMALS
    ).toString();
    const minUsdcOut = ethers.parseUnits(
      (premiumUsdc * 0.97).toFixed(USDC_DECIMALS),
      USDC_DECIMALS
    ).toString(); // 3% slippage tolerance

    mpoolOption = {
      description: `Fund premium for pool #${poolId} with ~${mpoolNeeded.toFixed(2)} MPOOLV3 (swapped to ${premiumUsdc} USDC)`,
      network: "base",
      calls: [
        {
          step: 1,
          action: "approve",
          to: CONTRACTS.MPOOLV3_TOKEN,
          data: ERC20_IFACE.encodeFunctionData("approve", [
            CONTRACTS.ROUTER,
            mpoolWei,
          ]),
          value: "0x0",
          description: `Approve ${mpoolNeeded.toFixed(2)} MPOOLV3 for Router`,
          decoded: {
            method: "approve(address,uint256)",
            params: {
              spender: CONTRACTS.ROUTER,
              amount: mpoolWei,
            },
          },
        },
        {
          step: 2,
          action: "fundPremiumWithMPOOL",
          to: CONTRACTS.ROUTER,
          data: ROUTER_IFACE.encodeFunctionData("fundPremiumWithMPOOL", [
            poolId,
            mpoolWei,
            minUsdcOut,
          ]),
          value: "0x0",
          description: `Swap MPOOLV3 → USDC and fund premium for pool #${poolId} via Router`,
          decoded: {
            method: "fundPremiumWithMPOOL(uint256,uint256,uint256)",
            params: {
              poolId: poolId.toString(),
              mpoolAmount: mpoolWei,
              minUsdcOut: minUsdcOut,
            },
          },
          anti_mev: {
            slippage_bps: 300,
            min_usdc_out: (premiumUsdc * 0.97).toFixed(2),
            rate_used: mpoolToUsdcRate,
          },
        },
      ],
    };
  }

  return {
    // ── Identity ──
    protocol: "mutualpool_v3",
    version: "3.0.0",
    chainId: CHAIN_ID,
    intent: "fund_pool_premium",
    timestamp: Math.floor(Date.now() / 1000),

    // ── Pool Parameters ──
    pool: {
      id: poolId,
      product: productId,
      description,
      coverage_usdc: coverageUsdc,
      premium_usdc: premiumUsdc,
      premium_rate_bps: premiumRateBps,
      deadline: deadlineUnix,
      deposit_deadline: depositDeadline,
      evidence_source: evidenceSource,
      status: "Pending",
    },

    // ── Contracts ──
    contracts: {
      vault: CONTRACTS.MUTUAL_POOL_V3,
      router: CONTRACTS.ROUTER,
      usdc: CONTRACTS.USDC,
      mpoolv3: CONTRACTS.MPOOLV3_TOKEN,
    },

    // ── Risk Parameters (for bot EV evaluation) ──
    risk_parameters: {
      event_probability: eventProbability,
      insured_ev_usdc: parseFloat(insuredEv.toFixed(4)),
      max_loss_insured: premiumUsdc,
      max_gain_insured: coverageUsdc - premiumUsdc,
      premium_to_coverage_ratio: parseFloat((premiumUsdc / coverageUsdc).toFixed(4)),
      data_source: evidenceSource,
      oracle_type: "dual_auth_deterministic",
    },

    // ── Mogra Execution Payload (Autonomous Agents) ──
    mogra_execution_payload: {
      // ── Option A: USDC Direct ──
      option_a_usdc: {
        description: `Fund premium for pool #${poolId}: ${premiumUsdc} USDC`,
        network: "base",
        calls: [
          {
            step: 1,
            action: "approve",
            to: CONTRACTS.USDC,
            data: ERC20_IFACE.encodeFunctionData("approve", [
              CONTRACTS.ROUTER,
              premiumWei,
            ]),
            value: "0x0",
            description: `Approve ${premiumUsdc} USDC for Router`,
            decoded: {
              method: "approve(address,uint256)",
              params: {
                spender: CONTRACTS.ROUTER,
                amount: premiumWei,
              },
            },
          },
          {
            step: 2,
            action: "fundPremiumWithUSDC",
            to: CONTRACTS.ROUTER,
            data: ROUTER_IFACE.encodeFunctionData("fundPremiumWithUSDC", [
              poolId,
              premiumWei,
            ]),
            value: "0x0",
            description: `Fund premium ${premiumUsdc} USDC for pool #${poolId} via Router`,
            decoded: {
              method: "fundPremiumWithUSDC(uint256,uint256)",
              params: {
                poolId: poolId.toString(),
                amount: premiumWei,
              },
            },
          },
        ],
      },

      // ── Option B: MPOOLV3 Swap (only if rate available) ──
      ...(mpoolOption && { option_b_mpoolv3: mpoolOption }),

      // ── Mogra API config ──
      api: {
        url: `${MOGRA_API_BASE}/wallet/transact`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer {{MOGRA_API_KEY}}",
        },
      },
    },

    // ── Human dApp URL (Bot-to-Human flow) ──
    human_dapp_url: `${DAPP_BASE_URL}/pool/${poolId}?action=fund_premium`,

    // ── Target (optional @mention) ──
    ...(targetAgent && { target_agent: targetAgent }),
  };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3 PAYLOAD: Pool Open → Seeking Providers (provide_liquidity)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the Phase 3 M2M payload published when the pool becomes Open
 * (premium was funded). This payload targets potential PROVIDERS.
 *
 * Includes THREE execution paths:
 *   A) USDC direct via Router (approve + joinPoolWithUSDC)
 *   B) MPOOLV3 via Router swap (approve + joinPoolWithMPOOL with minUsdcOut)
 *   C) Human dApp URL
 *
 * @param {object} params
 * @param {number} params.poolId - On-chain pool ID
 * @param {string} params.productId - Product identifier
 * @param {string} params.description - Human-readable pool description
 * @param {number} params.coverageUsdc - Coverage amount (= total collateral needed)
 * @param {number} params.premiumUsdc - Premium already deposited
 * @param {number} params.premiumRateBps - Premium rate in bps
 * @param {number} params.deadlineUnix - Resolution deadline
 * @param {string} params.evidenceSource - Evidence URL
 * @param {number} params.eventProbability - P(event)
 * @param {number} params.suggestedCollateralUsdc - Suggested per-provider deposit
 * @param {number} params.currentCollateralUsdc - Already deposited collateral
 * @param {number} params.expectedProviderCount - Expected number of providers
 * @param {number} [params.mpoolToUsdcRate] - Current MPOOLV3/USDC rate (if available)
 * @param {string} [params.targetAgent] - Optional @mention
 * @returns {object} Complete Phase 3 M2M payload
 */
function buildPhase3Payload(params) {
  const {
    poolId,
    productId,
    description,
    coverageUsdc,
    premiumUsdc,
    premiumRateBps,
    deadlineUnix,
    evidenceSource,
    eventProbability,
    suggestedCollateralUsdc,
    currentCollateralUsdc = 0,
    expectedProviderCount = 3,
    mpoolToUsdcRate,
    targetAgent,
  } = params;

  const depositDeadline = deadlineUnix - DEPOSIT_WINDOW_BUFFER;
  const remainingCollateral = coverageUsdc - currentCollateralUsdc;
  const collateralWei = ethers.parseUnits(
    suggestedCollateralUsdc.toString(),
    USDC_DECIMALS
  ).toString();

  // EV calculation for providers
  const premiumNetOfFee = premiumUsdc * 0.97; // 3% protocol fee
  const sharePerProvider = premiumNetOfFee / expectedProviderCount;
  const lossPerProvider = suggestedCollateralUsdc;
  const providerEvPer100 =
    (1 - eventProbability) * (sharePerProvider / (suggestedCollateralUsdc / 100)) +
    eventProbability * -(lossPerProvider / (suggestedCollateralUsdc / 100)) * 100;

  // MPOOLV3 option calculations
  let mpoolOption = null;
  if (mpoolToUsdcRate && mpoolToUsdcRate > 0) {
    const mpoolNeeded = suggestedCollateralUsdc / mpoolToUsdcRate;
    const mpoolWei = ethers.parseUnits(
      mpoolNeeded.toFixed(MPOOLV3_DECIMALS > 8 ? 8 : MPOOLV3_DECIMALS),
      MPOOLV3_DECIMALS
    ).toString();
    const minUsdcOut = ethers.parseUnits(
      (suggestedCollateralUsdc * 0.97).toFixed(USDC_DECIMALS),
      USDC_DECIMALS
    ).toString(); // 3% slippage tolerance

    mpoolOption = {
      description: `Join pool #${poolId} with ~${mpoolNeeded.toFixed(2)} MPOOLV3 (swapped to ${suggestedCollateralUsdc} USDC)`,
      network: "base",
      calls: [
        {
          step: 1,
          action: "approve",
          to: CONTRACTS.MPOOLV3_TOKEN,
          data: ERC20_IFACE.encodeFunctionData("approve", [
            CONTRACTS.ROUTER,
            mpoolWei,
          ]),
          value: "0x0",
          description: `Approve ${mpoolNeeded.toFixed(2)} MPOOLV3 for Router`,
          decoded: {
            method: "approve(address,uint256)",
            params: {
              spender: CONTRACTS.ROUTER,
              amount: mpoolWei,
            },
          },
        },
        {
          step: 2,
          action: "joinPoolWithMPOOL",
          to: CONTRACTS.ROUTER,
          data: ROUTER_IFACE.encodeFunctionData("joinPoolWithMPOOL", [
            poolId,
            mpoolWei,
            minUsdcOut,
          ]),
          value: "0x0",
          description: `Swap MPOOLV3 → USDC and join pool #${poolId} via Router`,
          decoded: {
            method: "joinPoolWithMPOOL(uint256,uint256,uint256)",
            params: {
              poolId: poolId.toString(),
              mpoolAmount: mpoolWei,
              minUsdcOut: minUsdcOut,
            },
          },
          anti_mev: {
            slippage_bps: 300,
            min_usdc_out: (suggestedCollateralUsdc * 0.97).toFixed(2),
            rate_used: mpoolToUsdcRate,
          },
        },
      ],
    };
  }

  return {
    // ── Identity ──
    protocol: "mutualpool_v3",
    version: "3.0.0",
    chainId: CHAIN_ID,
    intent: "provide_liquidity",
    timestamp: Math.floor(Date.now() / 1000),

    // ── Pool Parameters ──
    pool: {
      id: poolId,
      product: productId,
      description,
      coverage_usdc: coverageUsdc,
      premium_usdc: premiumUsdc,
      premium_rate_bps: premiumRateBps,
      deadline: deadlineUnix,
      deposit_deadline: depositDeadline,
      evidence_source: evidenceSource,
      status: "Open",
      current_collateral_usdc: currentCollateralUsdc,
      remaining_collateral_usdc: remainingCollateral,
    },

    // ── Contracts ──
    contracts: {
      vault: CONTRACTS.MUTUAL_POOL_V3,
      router: CONTRACTS.ROUTER,
      usdc: CONTRACTS.USDC,
      mpoolv3: CONTRACTS.MPOOLV3_TOKEN,
    },

    // ── Risk Parameters (for bot EV evaluation) ──
    risk_parameters: {
      event_probability: eventProbability,
      provider_ev_per_100_usdc: parseFloat(providerEvPer100.toFixed(4)),
      premium_net_of_fee_usdc: parseFloat(premiumNetOfFee.toFixed(4)),
      share_per_provider_usdc: parseFloat(sharePerProvider.toFixed(4)),
      max_loss_provider: suggestedCollateralUsdc,
      max_gain_provider: parseFloat(sharePerProvider.toFixed(4)),
      expected_provider_count: expectedProviderCount,
      data_source: evidenceSource,
      oracle_type: "dual_auth_deterministic",
    },

    // ── Mogra Execution Payload — Option A: USDC Direct ──
    mogra_execution_payload: {
      option_a_usdc: {
        description: `Join pool #${poolId} with ${suggestedCollateralUsdc} USDC`,
        network: "base",
        calls: [
          {
            step: 1,
            action: "approve",
            to: CONTRACTS.USDC,
            data: ERC20_IFACE.encodeFunctionData("approve", [
              CONTRACTS.ROUTER,
              collateralWei,
            ]),
            value: "0x0",
            description: `Approve ${suggestedCollateralUsdc} USDC for Router`,
            decoded: {
              method: "approve(address,uint256)",
              params: {
                spender: CONTRACTS.ROUTER,
                amount: collateralWei,
              },
            },
          },
          {
            step: 2,
            action: "joinPoolWithUSDC",
            to: CONTRACTS.ROUTER,
            data: ROUTER_IFACE.encodeFunctionData("joinPoolWithUSDC", [
              poolId,
              collateralWei,
            ]),
            value: "0x0",
            description: `Join pool #${poolId} with ${suggestedCollateralUsdc} USDC via Router`,
            decoded: {
              method: "joinPoolWithUSDC(uint256,uint256)",
              params: {
                poolId: poolId.toString(),
                amount: collateralWei,
              },
            },
          },
        ],
      },

      // ── Option B: MPOOLV3 Swap (only if rate available) ──
      ...(mpoolOption && { option_b_mpoolv3: mpoolOption }),

      // ── Mogra API config ──
      api: {
        url: `${MOGRA_API_BASE}/wallet/transact`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer {{MOGRA_API_KEY}}",
        },
      },
    },

    // ── Human dApp URL (Bot-to-Human flow) ──
    human_dapp_url: `${DAPP_BASE_URL}/pool/${poolId}?action=provide_collateral`,

    // ── Target (optional @mention) ──
    ...(targetAgent && { target_agent: targetAgent }),
  };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 4 PAYLOAD: Pool Resolved → Withdraw
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the Phase 4 M2M payload published when the Oracle resolves a pool.
 *
 * @param {object} params
 * @param {number} params.poolId - On-chain pool ID
 * @param {boolean} params.claimApproved - Resolution verdict
 * @param {object} params.oracleResult - Dual-auth oracle result
 * @param {object} params.accounting - Pool accounting post-resolution
 * @returns {object} Complete Phase 4 M2M payload
 */
function buildPhase4Payload(params) {
  const { poolId, claimApproved, oracleResult, accounting } = params;

  const withdrawCalldata = VAULT_IFACE.encodeFunctionData("withdraw", [poolId]);

  return {
    protocol: "mutualpool_v3",
    version: "3.0.0",
    chainId: CHAIN_ID,
    event: "pool_resolved",
    timestamp: Math.floor(Date.now() / 1000),

    pool: {
      id: poolId,
      claim_approved: claimApproved,
      status: "Resolved",
    },

    oracle: {
      type: "dual_auth",
      judge_verdict: oracleResult?.judge?.verdict || false,
      judge_confidence: oracleResult?.judge?.confidence || 0,
      auditor_verdict: oracleResult?.auditor?.verdict || false,
      consensus: oracleResult?.consensus || false,
      evidence_source: oracleResult?.evidence || null,
    },

    accounting: {
      total_collateral_usdc: accounting?.totalCollateral || 0,
      premium_after_fee_usdc: accounting?.premiumAfterFee || 0,
      protocol_fee_usdc: accounting?.protocolFee || 0,
      provider_count: accounting?.providerCount || 0,
    },

    contracts: {
      vault: CONTRACTS.MUTUAL_POOL_V3,
    },

    // ── Mogra Execution Payload: withdraw() ──
    mogra_execution_payload: {
      description: `Withdraw from resolved pool #${poolId}`,
      network: "base",
      calls: [
        {
          step: 1,
          action: "withdraw",
          to: CONTRACTS.MUTUAL_POOL_V3,
          data: withdrawCalldata,
          value: "0x0",
          description: `Withdraw funds from pool #${poolId} (claim: ${claimApproved})`,
          decoded: {
            method: "withdraw(uint256)",
            params: { poolId: poolId.toString() },
          },
        },
      ],
      api: {
        url: `${MOGRA_API_BASE}/wallet/transact`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer {{MOGRA_API_KEY}}",
        },
      },
    },

    // ── Human dApp URL ──
    human_dapp_url: `${DAPP_BASE_URL}/pool/${poolId}?action=withdraw`,
  };
}

// ═══════════════════════════════════════════════════════════════
// MOLT GENERATORS (MoltX Post Text + Embedded M2M JSON)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the complete MoltX post for Phase 1 (pool creation → seek insured).
 */
function generatePhase1Molt(params) {
  const payload = buildPhase1Payload(params);
  const {
    poolId, productId, description, coverageUsdc, premiumUsdc,
    deadlineUnix, evidenceSource, eventProbability, mpoolToUsdcRate, targetAgent,
  } = params;

  const mention = targetAgent ? `@${targetAgent} ` : "";
  const deadlineStr = new Date(deadlineUnix * 1000).toISOString();
  const depositDeadlineStr = new Date((deadlineUnix - DEPOSIT_WINDOW_BUFFER) * 1000).toISOString();
  const evInsured = payload.risk_parameters.insured_ev_usdc;
  const evSign = evInsured >= 0 ? "+" : "";

  let mpoolLine = "";
  if (mpoolToUsdcRate) {
    const mpoolNeeded = premiumUsdc / mpoolToUsdcRate;
    mpoolLine = `\n**Option B (MPOOLV3):** ~${mpoolNeeded.toFixed(2)} MPOOLV3 (auto-swap via Router, 3% slippage protection)`;
  }

  return `${mention}POOL #${poolId} CREATED — ${productId.replace(/_/g, " ").toUpperCase()}

${description}

## Pool Parameters
- Coverage: ${coverageUsdc.toLocaleString()} USDC
- Premium: ${premiumUsdc.toLocaleString()} USDC (${(premiumUsdc / coverageUsdc * 100).toFixed(1)}% rate)
- Deadline: ${deadlineStr}
- Deposit deadline: ${depositDeadlineStr}
- Evidence: ${evidenceSource}
- Oracle: Dual-auth deterministic (Judge + Auditor must agree)

## EV Analysis (Insured)
- P(event) = ${(eventProbability * 100).toFixed(1)}%
- If event: +${(coverageUsdc - premiumUsdc).toLocaleString()} USDC
- If no event: -${premiumUsdc.toLocaleString()} USDC (prima perdida)
- **Expected Value: ${evSign}${evInsured.toFixed(2)} USDC**

## How to Pay Premium
**Option A (USDC):** Approve ${premiumUsdc} USDC → Router.fundPremiumWithUSDC()${mpoolLine}
**Humans:** ${payload.human_dapp_url}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Contract: ${CONTRACTS.MUTUAL_POOL_V3} (Base Mainnet) | Router: ${CONTRACTS.ROUTER}`;
}

/**
 * Generate the complete MoltX post for Phase 3 (pool open → seek providers).
 */
function generatePhase3Molt(params) {
  const payload = buildPhase3Payload(params);
  const {
    poolId, productId, description, coverageUsdc, premiumUsdc,
    deadlineUnix, evidenceSource, eventProbability,
    suggestedCollateralUsdc, currentCollateralUsdc = 0,
    expectedProviderCount, mpoolToUsdcRate, targetAgent,
  } = params;

  const mention = targetAgent ? `@${targetAgent} ` : "";
  const remaining = coverageUsdc - currentCollateralUsdc;
  const depositDeadlineStr = new Date((deadlineUnix - DEPOSIT_WINDOW_BUFFER) * 1000).toISOString();
  const providerEv = payload.risk_parameters.provider_ev_per_100_usdc;
  const evSign = providerEv >= 0 ? "+" : "";

  let mpoolLine = "";
  if (mpoolToUsdcRate) {
    const mpoolNeeded = suggestedCollateralUsdc / mpoolToUsdcRate;
    mpoolLine = `\n**Option B (MPOOLV3):** ~${mpoolNeeded.toFixed(2)} MPOOLV3 (auto-swap via Router, 3% slippage protection)`;
  }

  return `${mention}LIQUIDITY NEEDED — POOL #${poolId} ${productId.replace(/_/g, " ").toUpperCase()}

${description}

Pool is OPEN. Premium funded. Seeking collateral providers.

## Pool Status
- Coverage needed: ${coverageUsdc.toLocaleString()} USDC
- Already deposited: ${currentCollateralUsdc.toLocaleString()} USDC
- **Remaining: ${remaining.toLocaleString()} USDC**
- Deposit deadline: ${depositDeadlineStr}
- Evidence: ${evidenceSource}

## EV Analysis (Provider)
- P(event) = ${(eventProbability * 100).toFixed(1)}%
- If NO event: collateral back + share of ${(premiumUsdc * 0.97).toFixed(2)} USDC premium
- If event: lose collateral (up to ${suggestedCollateralUsdc} USDC)
- **EV per 100 USDC: ${evSign}${providerEv.toFixed(2)} USDC**

## How to Provide Collateral
**Option A (USDC):** Approve ${suggestedCollateralUsdc} USDC → Router.joinPoolWithUSDC()${mpoolLine}
**Humans:** ${payload.human_dapp_url}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Min deposit: 10 USDC | Contract: ${CONTRACTS.MUTUAL_POOL_V3} | Router: ${CONTRACTS.ROUTER}`;
}

/**
 * Generate the complete MoltX post for Phase 4 (pool resolved → withdraw).
 */
function generatePhase4Molt(params) {
  const payload = buildPhase4Payload(params);
  const { poolId, claimApproved, oracleResult, accounting } = params;

  const verdict = claimApproved ? "CLAIM APPROVED — INSURED WINS" : "NO CLAIM — PROVIDERS WIN";

  return `POOL #${poolId} RESOLVED: ${verdict}

## Oracle Result
- Judge: ${oracleResult?.judge?.verdict ? "INCIDENT" : "NO INCIDENT"} (confidence: ${((oracleResult?.judge?.confidence || 0) * 100).toFixed(1)}%)
- Auditor: ${oracleResult?.auditor?.verdict ? "INCIDENT" : "NO INCIDENT"}
- Consensus: ${oracleResult?.consensus ? "YES" : "NO (security default: no claim)"}

## Accounting
- Total collateral: ${accounting?.totalCollateral || 0} USDC
- Premium after fee: ${accounting?.premiumAfterFee || 0} USDC
- Protocol fee (3%): ${accounting?.protocolFee || 0} USDC

Call \`withdraw(${poolId})\` to collect your funds.
**Bots:** Execute the M2M payload below.
**Humans:** ${payload.human_dapp_url}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Contract: ${CONTRACTS.MUTUAL_POOL_V3} (Base Mainnet)`;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  CONTRACTS,
  DAPP_BASE_URL,

  // Payload builders (raw JSON)
  buildPhase1Payload,
  buildPhase3Payload,
  buildPhase4Payload,

  // Molt generators (MoltX post text with embedded JSON)
  generatePhase1Molt,
  generatePhase3Molt,
  generatePhase4Molt,
};
