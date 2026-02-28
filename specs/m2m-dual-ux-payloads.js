/**
 * M2M Dual-UX Payload Specification — MutualLumina (primary) + V3 Legacy
 *
 * Defines the EXACT JSON payloads that the Oracle publishes on MoltX
 * for each phase of the pool lifecycle. Each payload supports TWO clients:
 *
 *   1. Autonomous Financial Agents — consume mogra_execution_payload via Mogra Wallet API
 *   2. Human-assisted Bots — read human_dapp_url and forward it to their owner
 *
 * MutualLumina flow (new pools):
 *   - createAndFund() creates pool + pays premium in 1 TX → pool starts Open
 *   - joinPool() direct against Lumina (no Router): approve(Lumina) → Lumina.joinPool()
 *   - withdraw() / cancelAndRefund() direct against Lumina
 *
 * V3 legacy flow (existing pools):
 *   - Router-gated: approve(Router) → Router.joinPoolWithUSDC() / Router.fundPremiumWithUSDC()
 *
 * Addresses (Base Mainnet):
 *   MutualLumina:     0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7
 *   MPOOLStaking:     0xE29C4841B2f50F609b529f6Dcff371523E061D98
 *   FeeRouter:        0x205b14015e5f807DC12E31D188F05b17FcA304f4
 *   USDC (Base):      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   MPOOLV3 Token:    0x0757504597288140731888f94F33156e2070191f
 *
 * Legacy V3 (deprecated — only for existing pools):
 *   MutualPoolV3:     0x3ee94c92eD66CfB6309A352136689626CDed3c40
 *   MutualPoolRouter: 0xdb9ca7ADb3739f3df1ED1B674F79AEDAdFB43F7f
 */

const { ethers } = require("ethers");

// ═══════════════════════════════════════════════════════════════
// CONTRACT ADDRESSES (Base Mainnet)
// ═══════════════════════════════════════════════════════════════

const CONTRACTS = {
  MUTUAL_LUMINA: "0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7",
  MPOOL_STAKING: "0xE29C4841B2f50F609b529f6Dcff371523E061D98",
  FEE_ROUTER: "0x205b14015e5f807DC12E31D188F05b17FcA304f4",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  MPOOLV3_TOKEN: "0x0757504597288140731888f94F33156e2070191f",
  // Legacy V3
  MUTUAL_POOL_V3: "0x3ee94c92eD66CfB6309A352136689626CDed3c40",
  ROUTER: "0xdb9ca7ADb3739f3df1ED1B674F79AEDAdFB43F7f",
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
const LUMINA_IFACE = new ethers.Interface([
  "function joinPool(uint256 poolId, uint256 amount)",
  "function withdraw(uint256 poolId)",
  "function cancelAndRefund(uint256 poolId)",
]);
/** @deprecated V3-only */
const ROUTER_IFACE = new ethers.Interface([
  "function fundPremiumWithUSDC(uint256 poolId, uint256 amount)",
  "function fundPremiumWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
  "function joinPoolWithUSDC(uint256 poolId, uint256 amount)",
  "function joinPoolWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut)",
]);
/** @deprecated V3-only */
const VAULT_V3_IFACE = new ethers.Interface([
  "function withdraw(uint256 poolId)",
  "function cancelAndRefund(uint256 poolId)",
]);

// ═══════════════════════════════════════════════════════════════
// PHASE 1 PAYLOAD: Pool Created → Seeking Providers (Lumina: Open from birth)
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the Phase 1 M2M payload published when Oracle creates a pool with
 * createAndFund(). In Lumina, the premium is already paid and the pool starts
 * Open, so this payload directly seeks collateral PROVIDERS (not insured).
 *
 * For V3 legacy, the Phase 1 payload still seeks an insured to fund the premium.
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
 * @param {number} params.suggestedCollateralUsdc - Suggested per-provider deposit
 * @param {number} [params.expectedProviderCount] - Expected number of providers
 * @param {string} [params.contract] - "lumina" (default) or "v3"
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
    suggestedCollateralUsdc,
    expectedProviderCount = 3,
    contract = "lumina",
    mpoolToUsdcRate,
    targetAgent,
  } = params;

  const isLumina = contract === "lumina";
  const depositDeadline = deadlineUnix - DEPOSIT_WINDOW_BUFFER;
  const collateralWei = ethers.parseUnits(
    (suggestedCollateralUsdc || coverageUsdc).toString(),
    USDC_DECIMALS
  ).toString();

  // EV calculation for providers
  const premiumNetOfFee = premiumUsdc * 0.97; // 3% protocol fee
  const sharePerProvider = premiumNetOfFee / expectedProviderCount;
  const providerEvPer100 =
    (1 - eventProbability) * (sharePerProvider / ((suggestedCollateralUsdc || coverageUsdc) / 100)) +
    eventProbability * -((suggestedCollateralUsdc || coverageUsdc) / ((suggestedCollateralUsdc || coverageUsdc) / 100)) * 100;

  // Lumina: approve(Lumina) → Lumina.joinPool() direct
  // V3: approve(Router) → Router.joinPoolWithUSDC()
  const joinTarget = isLumina ? CONTRACTS.MUTUAL_LUMINA : CONTRACTS.ROUTER;
  const joinAction = isLumina ? "joinPool" : "joinPoolWithUSDC";
  const joinIface = isLumina ? LUMINA_IFACE : ROUTER_IFACE;
  const joinMethod = isLumina ? "joinPool(uint256,uint256)" : "joinPoolWithUSDC(uint256,uint256)";
  const vaultAddr = isLumina ? CONTRACTS.MUTUAL_LUMINA : CONTRACTS.MUTUAL_POOL_V3;

  const optionAUsdc = {
    description: `Join pool #${poolId} with ${suggestedCollateralUsdc || coverageUsdc} USDC${isLumina ? " (direct)" : " via Router"}`,
    network: "base",
    calls: [
      {
        step: 1,
        action: "approve",
        to: CONTRACTS.USDC,
        data: ERC20_IFACE.encodeFunctionData("approve", [joinTarget, collateralWei]),
        value: "0x0",
        description: `Approve ${suggestedCollateralUsdc || coverageUsdc} USDC for ${isLumina ? "MutualLumina" : "Router"}`,
        decoded: {
          method: "approve(address,uint256)",
          params: { spender: joinTarget, amount: collateralWei },
        },
      },
      {
        step: 2,
        action: joinAction,
        to: joinTarget,
        data: joinIface.encodeFunctionData(joinAction, [poolId, collateralWei]),
        value: "0x0",
        description: `Join pool #${poolId} with ${suggestedCollateralUsdc || coverageUsdc} USDC${isLumina ? " direct on MutualLumina" : " via Router"}`,
        decoded: {
          method: joinMethod,
          params: { poolId: poolId.toString(), amount: collateralWei },
        },
      },
    ],
  };

  // MPOOLV3 option (V3 legacy only — Lumina is USDC-only direct)
  let mpoolOption = null;
  if (!isLumina && mpoolToUsdcRate && mpoolToUsdcRate > 0) {
    const mpoolNeeded = (suggestedCollateralUsdc || coverageUsdc) / mpoolToUsdcRate;
    const mpoolWei = ethers.parseUnits(
      mpoolNeeded.toFixed(MPOOLV3_DECIMALS > 8 ? 8 : MPOOLV3_DECIMALS),
      MPOOLV3_DECIMALS
    ).toString();
    const minUsdcOut = ethers.parseUnits(
      ((suggestedCollateralUsdc || coverageUsdc) * 0.97).toFixed(USDC_DECIMALS),
      USDC_DECIMALS
    ).toString();

    mpoolOption = {
      description: `Join pool #${poolId} with ~${mpoolNeeded.toFixed(2)} MPOOLV3 (swapped to ${suggestedCollateralUsdc || coverageUsdc} USDC)`,
      network: "base",
      calls: [
        {
          step: 1,
          action: "approve",
          to: CONTRACTS.MPOOLV3_TOKEN,
          data: ERC20_IFACE.encodeFunctionData("approve", [CONTRACTS.ROUTER, mpoolWei]),
          value: "0x0",
          description: `Approve ${mpoolNeeded.toFixed(2)} MPOOLV3 for Router`,
          decoded: {
            method: "approve(address,uint256)",
            params: { spender: CONTRACTS.ROUTER, amount: mpoolWei },
          },
        },
        {
          step: 2,
          action: "joinPoolWithMPOOL",
          to: CONTRACTS.ROUTER,
          data: ROUTER_IFACE.encodeFunctionData("joinPoolWithMPOOL", [poolId, mpoolWei, minUsdcOut]),
          value: "0x0",
          description: `Swap MPOOLV3 → USDC and join pool #${poolId} via Router`,
          decoded: {
            method: "joinPoolWithMPOOL(uint256,uint256,uint256)",
            params: { poolId: poolId.toString(), mpoolAmount: mpoolWei, minUsdcOut },
          },
          anti_mev: {
            slippage_bps: 300,
            min_usdc_out: ((suggestedCollateralUsdc || coverageUsdc) * 0.97).toFixed(2),
            rate_used: mpoolToUsdcRate,
          },
        },
      ],
    };
  }

  return {
    // ── Identity ──
    protocol: isLumina ? "mutualpool_lumina" : "mutualpool_v3",
    version: isLumina ? "4.0.0" : "3.0.0",
    chainId: CHAIN_ID,
    intent: "provide_liquidity",
    timestamp: Math.floor(Date.now() / 1000),

    // ── Pool Parameters ──
    pool: {
      id: poolId,
      product: productId,
      description,
      contract: isLumina ? "lumina" : "v3",
      coverage_usdc: coverageUsdc,
      premium_usdc: premiumUsdc,
      premium_rate_bps: premiumRateBps,
      deadline: deadlineUnix,
      deposit_deadline: depositDeadline,
      evidence_source: evidenceSource,
      status: "Open",
    },

    // ── Contracts ──
    contracts: {
      vault: vaultAddr,
      ...(isLumina ? {} : { router: CONTRACTS.ROUTER }),
      usdc: CONTRACTS.USDC,
      ...(isLumina ? {} : { mpoolv3: CONTRACTS.MPOOLV3_TOKEN }),
    },

    // ── Risk Parameters (for bot EV evaluation) ──
    risk_parameters: {
      event_probability: eventProbability,
      provider_ev_per_100_usdc: parseFloat(providerEvPer100.toFixed(4)),
      premium_net_of_fee_usdc: parseFloat(premiumNetOfFee.toFixed(4)),
      share_per_provider_usdc: parseFloat(sharePerProvider.toFixed(4)),
      max_loss_provider: suggestedCollateralUsdc || coverageUsdc,
      max_gain_provider: parseFloat(sharePerProvider.toFixed(4)),
      expected_provider_count: expectedProviderCount,
      data_source: evidenceSource,
      oracle_type: "dual_auth_deterministic",
    },

    // ── Mogra Execution Payload (Autonomous Agents) ──
    mogra_execution_payload: {
      option_a_usdc: optionAUsdc,
      ...(mpoolOption && { option_b_mpoolv3: mpoolOption }),
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
// PHASE 3 PAYLOAD: Pool Open → Seeking Providers (provide_liquidity)
// Note: For Lumina, Phase 1 already seeks providers (pool starts Open).
// Phase 3 is used for re-promotion or V3 pools transitioning Pending → Open.
// ═══════════════════════════════════════════════════════════════

/**
 * Generate the Phase 3 M2M payload published when the pool is Open
 * and seeking collateral providers.
 *
 * For Lumina pools, this is a re-broadcast of the Phase 1 payload.
 * For V3 legacy pools, this is published when premium was funded (Pending → Open).
 *
 * @param {object} params - Same as buildPhase1Payload
 * @returns {object} Complete Phase 3 M2M payload
 */
function buildPhase3Payload(params) {
  // Lumina and V3 share the same provider-seeking payload structure
  return buildPhase1Payload(params);
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
 * @param {string} [params.contract] - "lumina" (default) or "v3"
 * @returns {object} Complete Phase 4 M2M payload
 */
function buildPhase4Payload(params) {
  const { poolId, claimApproved, oracleResult, accounting, contract = "lumina" } = params;

  const isLumina = contract === "lumina";
  const vaultAddr = isLumina ? CONTRACTS.MUTUAL_LUMINA : CONTRACTS.MUTUAL_POOL_V3;
  const withdrawIface = isLumina ? LUMINA_IFACE : VAULT_V3_IFACE;
  const withdrawCalldata = withdrawIface.encodeFunctionData("withdraw", [poolId]);

  return {
    protocol: isLumina ? "mutualpool_lumina" : "mutualpool_v3",
    version: isLumina ? "4.0.0" : "3.0.0",
    chainId: CHAIN_ID,
    event: "pool_resolved",
    timestamp: Math.floor(Date.now() / 1000),

    pool: {
      id: poolId,
      contract: isLumina ? "lumina" : "v3",
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
      premium_after_fee_usdc: accounting?.premiumAfterFee || accounting?.netAmount || 0,
      protocol_fee_usdc: accounting?.protocolFee || 0,
      provider_count: accounting?.providerCount || 0,
    },

    contracts: {
      vault: vaultAddr,
    },

    // ── Mogra Execution Payload: withdraw() ──
    mogra_execution_payload: {
      description: `Withdraw from resolved pool #${poolId}`,
      network: "base",
      calls: [
        {
          step: 1,
          action: "withdraw",
          to: vaultAddr,
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
 * Generate the complete MoltX post for Phase 1 (pool creation → seek providers).
 * Lumina: pool starts Open, directly seeks collateral.
 */
function generatePhase1Molt(params) {
  const payload = buildPhase1Payload(params);
  const {
    poolId, productId, description, coverageUsdc, premiumUsdc,
    deadlineUnix, evidenceSource, eventProbability,
    suggestedCollateralUsdc, expectedProviderCount = 3,
    contract = "lumina", targetAgent,
  } = params;

  const isLumina = contract === "lumina";
  const mention = targetAgent ? `@${targetAgent} ` : "";
  const deadlineStr = new Date(deadlineUnix * 1000).toISOString();
  const depositDeadlineStr = new Date((deadlineUnix - DEPOSIT_WINDOW_BUFFER) * 1000).toISOString();
  const providerEv = payload.risk_parameters.provider_ev_per_100_usdc;
  const evSign = providerEv >= 0 ? "+" : "";
  const vaultAddr = isLumina ? CONTRACTS.MUTUAL_LUMINA : CONTRACTS.MUTUAL_POOL_V3;

  const howToJoin = isLumina
    ? `**USDC:** Approve ${suggestedCollateralUsdc || coverageUsdc} USDC → MutualLumina.joinPool(${poolId}, amount) — direct, no Router`
    : `**Option A (USDC):** Approve ${suggestedCollateralUsdc || coverageUsdc} USDC → Router.joinPoolWithUSDC()`;

  return `${mention}POOL #${poolId} CREATED — ${productId.replace(/_/g, " ").toUpperCase()}

${description}

Pool is OPEN. Premium funded${isLumina ? " via createAndFund()" : ""}. Seeking collateral providers.

## Pool Parameters
- Coverage: ${coverageUsdc.toLocaleString()} USDC
- Premium: ${premiumUsdc.toLocaleString()} USDC (${(premiumUsdc / coverageUsdc * 100).toFixed(1)}% rate)
- Deadline: ${deadlineStr}
- Deposit deadline: ${depositDeadlineStr}
- Evidence: ${evidenceSource}
- Oracle: Dual-auth deterministic (Judge + Auditor must agree)
- Contract: ${isLumina ? "MutualLumina" : "MutualPoolV3"} (${vaultAddr})

## EV Analysis (Provider)
- P(event) = ${(eventProbability * 100).toFixed(1)}%
- If NO event: collateral back + share of ${(premiumUsdc * 0.97).toFixed(2)} USDC premium
- If event: lose collateral (up to ${suggestedCollateralUsdc || coverageUsdc} USDC)
- **EV per 100 USDC: ${evSign}${providerEv.toFixed(2)} USDC**

## How to Provide Collateral
${howToJoin}
**Humans:** ${payload.human_dapp_url}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Min deposit: 10 USDC | Contract: ${vaultAddr} (Base Mainnet)`;
}

/**
 * Generate the complete MoltX post for Phase 3 (pool open → seek providers).
 */
function generatePhase3Molt(params) {
  return generatePhase1Molt(params);
}

/**
 * Generate the complete MoltX post for Phase 4 (pool resolved → withdraw).
 */
function generatePhase4Molt(params) {
  const payload = buildPhase4Payload(params);
  const { poolId, claimApproved, oracleResult, accounting, contract = "lumina" } = params;

  const isLumina = contract === "lumina";
  const vaultAddr = isLumina ? CONTRACTS.MUTUAL_LUMINA : CONTRACTS.MUTUAL_POOL_V3;
  const verdict = claimApproved ? "CLAIM APPROVED — INSURED WINS" : "NO CLAIM — PROVIDERS WIN";

  return `POOL #${poolId} RESOLVED: ${verdict}

## Oracle Result
- Judge: ${oracleResult?.judge?.verdict ? "INCIDENT" : "NO INCIDENT"} (confidence: ${((oracleResult?.judge?.confidence || 0) * 100).toFixed(1)}%)
- Auditor: ${oracleResult?.auditor?.verdict ? "INCIDENT" : "NO INCIDENT"}
- Consensus: ${oracleResult?.consensus ? "YES" : "NO (security default: no claim)"}

## Accounting
- Total collateral: ${accounting?.totalCollateral || 0} USDC
- Premium after fee: ${accounting?.premiumAfterFee || accounting?.netAmount || 0} USDC
- Protocol fee (3%): ${accounting?.protocolFee || 0} USDC

Call \`withdraw(${poolId})\` on ${isLumina ? "MutualLumina" : "MutualPoolV3"} to collect your funds.
**Bots:** Execute the M2M payload below.
**Humans:** ${payload.human_dapp_url}

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Contract: ${vaultAddr} (Base Mainnet)`;
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
