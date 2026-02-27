/**
 * M2M Payload Parser — Node.js/Ethers.js module for parsing Machine-to-Machine
 * JSON payloads from MoltX social posts and constructing on-chain transactions.
 *
 * V3 Update: Now supports MutualPoolRouter flow and Mogra wallet payloads.
 *
 * Workflow:
 *   1. Parse MoltX post content → extract JSON code blocks
 *   2. Validate M2M payload structure (intent, required_actions, pool_params)
 *   3. Validate depositDeadline (block.timestamp < deadline - 7200s)
 *   4. Construct approve → Router.fundPremiumWithUSDC/joinPoolWithUSDC transactions
 *   5. Optionally build Mogra wallet/transact payloads for off-chain submission
 *   6. Return executable transaction sequence
 *
 * Security:
 *   - Strict schema validation (no arbitrary method execution)
 *   - Allowlisted actions only: approve, fundPremiumWithUSDC, joinPoolWithUSDC, withdraw
 *   - depositDeadline validation prevents front-running
 *   - Amount bounds checking (min 1 USDC, max 10,000 USDC)
 */
const { ethers } = require("ethers");

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const DEPOSIT_WINDOW_BUFFER = 7200; // 2 hours in seconds (matches contract)
const MIN_AMOUNT_USDC = 1;
const MAX_AMOUNT_USDC = 10_000;

// Allowlisted on-chain actions — prevents arbitrary method execution
const ALLOWED_ACTIONS = {
  approve: {
    method: "approve(address,uint256)",
    target: "usdc",
    description: "Approve USDC spending for Router contract",
  },
  joinPool: {
    method: "joinPool(uint256,uint256)",
    target: "mutualpool",
    description: "Join a mutual insurance pool as collateral provider (V1 legacy)",
  },
  fundPremiumWithUSDC: {
    method: "fundPremiumWithUSDC(uint256,uint256)",
    target: "router",
    description: "Fund pool premium via Router (V3)",
  },
  joinPoolWithUSDC: {
    method: "joinPoolWithUSDC(uint256,uint256)",
    target: "router",
    description: "Join pool via Router with USDC (V3)",
  },
  withdraw: {
    method: "withdraw(uint256)",
    target: "mutualpool",
    description: "Withdraw funds from a resolved pool",
  },
  cancelAndRefund: {
    method: "cancelAndRefund(uint256)",
    target: "mutualpool",
    description: "Cancel underfunded pool and refund all participants",
  },
};

// Mogra Wallet API endpoint
const MOGRA_API_BASE = "https://mogra.xyz/api";

// ═══════════════════════════════════════════════════════════════
// Payload Extraction from MoltX Post Content
// ═══════════════════════════════════════════════════════════════

/**
 * Extract M2M JSON payloads from a MoltX post's text content.
 * Looks for ```json ... ``` fenced code blocks containing M2M data.
 *
 * @param {string} postContent - Raw text content of a MoltX post (Molt)
 * @returns {object[]} - Array of parsed M2M payload objects
 */
function extractM2MPayloads(postContent) {
  if (!postContent || typeof postContent !== "string") return [];

  // Match all ```json ... ``` code blocks
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)```/g;
  const payloads = [];
  let match;

  while ((match = jsonBlockRegex.exec(postContent)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      // Only include objects that look like M2M payloads
      if (parsed && typeof parsed === "object" && (parsed.intent || parsed.event)) {
        payloads.push(parsed);
      }
    } catch {
      // Malformed JSON block — skip silently
    }
  }

  return payloads;
}

// ═══════════════════════════════════════════════════════════════
// Payload Validation
// ═══════════════════════════════════════════════════════════════

/**
 * Validate an M2M payload for structural correctness and security.
 *
 * @param {object} payload - Parsed M2M JSON object
 * @returns {{ valid: boolean, errors: string[], payload: object }}
 */
function validatePayload(payload) {
  const errors = [];

  // Required fields
  if (!payload.intent && !payload.event) {
    errors.push("Missing 'intent' or 'event' field");
  }

  // Chain validation
  if (payload.chainId && payload.chainId !== 8453) {
    errors.push(`Unsupported chainId: ${payload.chainId}. Only Base (8453) supported`);
  }

  // Validate required_actions if present (for intent payloads)
  if (payload.required_actions) {
    if (!Array.isArray(payload.required_actions)) {
      errors.push("'required_actions' must be an array");
    } else {
      for (let i = 0; i < payload.required_actions.length; i++) {
        const action = payload.required_actions[i];
        if (!action.action || !ALLOWED_ACTIONS[action.action]) {
          errors.push(`Action [${i}]: unknown action '${action.action}'. Allowed: ${Object.keys(ALLOWED_ACTIONS).join(", ")}`);
        }
        if (action.method && ALLOWED_ACTIONS[action.action] && action.method !== ALLOWED_ACTIONS[action.action].method) {
          errors.push(`Action [${i}]: method mismatch. Expected '${ALLOWED_ACTIONS[action.action].method}', got '${action.method}'`);
        }
      }
    }
  }

  // Validate pool_params if present
  if (payload.pool_params) {
    if (payload.pool_params.deposit_deadline) {
      const deadline = payload.pool_params.deposit_deadline;
      if (typeof deadline !== "number" || deadline < 1_000_000_000) {
        errors.push(`Invalid deposit_deadline: ${deadline}. Must be a Unix timestamp`);
      }
    }
  }

  // Validate risk_analysis if present
  if (payload.risk_analysis) {
    if (payload.risk_analysis.net_ev_per_100_usdc !== undefined) {
      const ev = payload.risk_analysis.net_ev_per_100_usdc;
      if (typeof ev !== "number") {
        errors.push(`Invalid net_ev_per_100_usdc: must be a number`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    payload,
  };
}

// ═══════════════════════════════════════════════════════════════
// Deadline Validation
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a pool's deposit window is still open.
 * The contract enforces: block.timestamp < deadline - DEPOSIT_WINDOW_BUFFER
 * This mirrors the on-chain depositDeadline = deadline - 7200s check.
 *
 * @param {number} deadline - Pool deadline as Unix timestamp
 * @param {number} [currentTimestamp] - Current time (defaults to Date.now()/1000)
 * @returns {{ open: boolean, depositDeadline: number, secondsRemaining: number, reason: string }}
 */
function checkDepositWindow(deadline, currentTimestamp) {
  const now = currentTimestamp || Math.floor(Date.now() / 1000);
  const depositDeadline = deadline - DEPOSIT_WINDOW_BUFFER;
  const secondsRemaining = depositDeadline - now;

  if (now >= depositDeadline) {
    return {
      open: false,
      depositDeadline,
      secondsRemaining: 0,
      reason: `Deposit window closed. depositDeadline=${depositDeadline} (deadline - 7200s). Current time: ${now}`,
    };
  }

  return {
    open: true,
    depositDeadline,
    secondsRemaining,
    reason: `Deposit window open. ${secondsRemaining}s remaining (${(secondsRemaining / 3600).toFixed(1)}h)`,
  };
}

// ═══════════════════════════════════════════════════════════════
// Transaction Construction
// ═══════════════════════════════════════════════════════════════

/**
 * Build the transaction sequence for a "provide_insurance_liquidity" M2M payload.
 *
 * V3 flow: approve(Router) → Router.joinPoolWithUSDC(poolId, amount)
 * Legacy V1 flow: approve(MutualPool) → joinPool(poolId, amount)
 *
 * @param {object} payload - Validated M2M payload
 * @param {object} options
 * @param {string} options.contractAddress - MutualPool/V3 contract address
 * @param {string} [options.routerAddress] - MutualPoolRouter address (enables V3 flow)
 * @param {number} options.amountUsdc - Amount of USDC to provide as collateral
 * @param {import('ethers').Wallet} [options.wallet] - Optional wallet for signing
 * @param {import('ethers').JsonRpcProvider} [options.provider] - Optional provider for gas estimation
 * @returns {{ transactions: object[], depositWindow: object, riskAnalysis: object }}
 */
function buildJoinPoolTransactions(payload, options) {
  const { contractAddress, routerAddress, amountUsdc, wallet, provider } = options;
  const useV3 = !!routerAddress;

  // Validate amount bounds
  if (amountUsdc < MIN_AMOUNT_USDC || amountUsdc > MAX_AMOUNT_USDC) {
    throw new Error(`Amount ${amountUsdc} USDC out of bounds [${MIN_AMOUNT_USDC}, ${MAX_AMOUNT_USDC}]`);
  }

  // Validate deposit window
  const deadline = payload.pool_params?.deposit_deadline ||
                   payload.pool_params?.deadline;
  if (!deadline) {
    throw new Error("No deadline found in payload pool_params");
  }

  const depositWindow = checkDepositWindow(deadline);
  if (!depositWindow.open) {
    throw new Error(`Cannot join: ${depositWindow.reason}`);
  }

  // Extract pool ID
  const poolId = payload.pool_params?.pool_id ?? payload.pool_id;
  if (poolId === undefined || poolId === null) {
    throw new Error("No pool_id found in payload");
  }

  const amountWei = ethers.parseUnits(amountUsdc.toString(), USDC_DECIMALS);
  const transactions = [];
  const approveTarget = useV3 ? routerAddress : contractAddress;

  // TX 1: approve USDC for Router (V3) or MutualPool (V1)
  const approveIface = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
  transactions.push({
    step: 1,
    action: "approve",
    description: `Approve ${amountUsdc} USDC for ${useV3 ? "Router" : "MutualPool"}`,
    to: USDC_ADDRESS,
    data: approveIface.encodeFunctionData("approve", [approveTarget, amountWei]),
    value: "0x0",
    decoded: {
      method: "approve(address,uint256)",
      params: { spender: approveTarget, amount: amountWei.toString() },
    },
  });

  if (useV3) {
    // TX 2 (V3): Router.joinPoolWithUSDC(poolId, amount)
    const routerIface = new ethers.Interface(["function joinPoolWithUSDC(uint256,uint256)"]);
    transactions.push({
      step: 2,
      action: "joinPoolWithUSDC",
      description: `Join pool #${poolId} with ${amountUsdc} USDC via Router (V3)`,
      to: routerAddress,
      data: routerIface.encodeFunctionData("joinPoolWithUSDC", [poolId, amountWei]),
      value: "0x0",
      decoded: {
        method: "joinPoolWithUSDC(uint256,uint256)",
        params: { poolId: poolId.toString(), amount: amountWei.toString() },
      },
    });
  } else {
    // TX 2 (V1 legacy): joinPool(poolId, amount)
    const joinIface = new ethers.Interface(["function joinPool(uint256,uint256)"]);
    transactions.push({
      step: 2,
      action: "joinPool",
      description: `Join pool #${poolId} with ${amountUsdc} USDC collateral`,
      to: contractAddress,
      data: joinIface.encodeFunctionData("joinPool", [poolId, amountWei]),
      value: "0x0",
      decoded: {
        method: "joinPool(uint256,uint256)",
        params: { poolId: poolId.toString(), amount: amountWei.toString() },
      },
    });
  }

  return {
    transactions,
    depositWindow,
    riskAnalysis: payload.risk_analysis || null,
    poolParams: payload.pool_params || null,
    version: useV3 ? "v3" : "v1",
  };
}

/**
 * Build a Mogra wallet/transact payload for off-chain submission.
 * The Mogra API signs and submits the batch of calls atomically.
 *
 * @param {object} payload - Validated M2M payload
 * @param {object} options
 * @param {string} options.routerAddress - MutualPoolRouter address
 * @param {number} options.amountUsdc - USDC amount
 * @param {string} options.mograApiKey - Mogra API key
 * @returns {object} Mogra-compatible transact payload
 */
function buildMograPayload(payload, options) {
  const { routerAddress, amountUsdc, mograApiKey } = options;

  if (!routerAddress) throw new Error("routerAddress required for Mogra payload");
  if (!mograApiKey) throw new Error("mograApiKey required");

  const poolId = payload.pool_params?.pool_id ?? payload.pool_id;
  if (poolId === undefined || poolId === null) {
    throw new Error("No pool_id found in payload");
  }

  const amountWei = ethers.parseUnits(amountUsdc.toString(), USDC_DECIMALS);
  const approveIface = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
  const routerIface = new ethers.Interface(["function joinPoolWithUSDC(uint256,uint256)"]);

  const intent = payload.intent === "fund_pool_premium" ? "fundPremiumWithUSDC" : "joinPoolWithUSDC";
  const routerMethod = intent === "fundPremiumWithUSDC"
    ? new ethers.Interface(["function fundPremiumWithUSDC(uint256,uint256)"]).encodeFunctionData("fundPremiumWithUSDC", [poolId, amountWei])
    : routerIface.encodeFunctionData("joinPoolWithUSDC", [poolId, amountWei]);

  return {
    mograPayload: {
      network: "base",
      calls: [
        {
          to: USDC_ADDRESS,
          data: approveIface.encodeFunctionData("approve", [routerAddress, amountWei]),
          value: "0x0",
        },
        {
          to: routerAddress,
          data: routerMethod,
          value: "0x0",
        },
      ],
    },
    apiConfig: {
      url: `${MOGRA_API_BASE}/wallet/transact`,
      headers: {
        "Authorization": `Bearer ${mograApiKey}`,
        "Content-Type": "application/json",
      },
    },
    meta: {
      poolId,
      amountUsdc,
      intent,
    },
  };
}

/**
 * Build the transaction for a "pool_resolved" event (withdraw action).
 *
 * @param {object} payload - Validated M2M resolution payload
 * @param {string} contractAddress - MutualPool contract address
 * @returns {{ transaction: object }}
 */
function buildWithdrawTransaction(payload, contractAddress) {
  const poolId = payload.pool_id;
  if (poolId === undefined || poolId === null) {
    throw new Error("No pool_id found in resolution payload");
  }

  const withdrawIface = new ethers.Interface(["function withdraw(uint256)"]);
  return {
    transaction: {
      action: "withdraw",
      description: `Withdraw funds from resolved pool #${poolId} (claim_approved: ${payload.claim_approved})`,
      to: contractAddress,
      data: withdrawIface.encodeFunctionData("withdraw", [poolId]),
      value: "0x0",
      decoded: {
        method: "withdraw(uint256)",
        params: { poolId: poolId.toString() },
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Full Pipeline: Parse → Validate → Build
// ═══════════════════════════════════════════════════════════════

/**
 * Full M2M processing pipeline: extract payloads from a MoltX post,
 * validate each one, and build transaction sequences.
 *
 * @param {string} postContent - Raw MoltX post content
 * @param {object} options
 * @param {string} options.contractAddress - MutualPool contract address
 * @param {number} options.amountUsdc - USDC amount for joinPool
 * @returns {{ results: Array<{ payload: object, validation: object, transactions?: object, error?: string }> }}
 */
function processPost(postContent, options) {
  const payloads = extractM2MPayloads(postContent);
  const results = [];

  for (const payload of payloads) {
    const validation = validatePayload(payload);

    if (!validation.valid) {
      results.push({ payload, validation, error: validation.errors.join("; ") });
      continue;
    }

    try {
      // Route by intent/event type
      if (payload.intent === "provide_insurance_liquidity") {
        const txResult = buildJoinPoolTransactions(payload, options);
        results.push({ payload, validation, ...txResult });
      } else if (payload.event === "pool_resolved") {
        const txResult = buildWithdrawTransaction(payload, options.contractAddress);
        results.push({ payload, validation, ...txResult });
      } else {
        results.push({
          payload,
          validation,
          error: `Unhandled intent/event: ${payload.intent || payload.event}`,
        });
      }
    } catch (err) {
      results.push({ payload, validation, error: err.message });
    }
  }

  return { results, payloadCount: payloads.length };
}

// ═══════════════════════════════════════════════════════════════
// Execute Transactions (with wallet)
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a built transaction sequence on-chain.
 *
 * @param {object[]} transactions - Array of transaction objects from buildJoinPoolTransactions
 * @param {import('ethers').Wallet} wallet - Ethers.js wallet connected to provider
 * @returns {Promise<object[]>} - Array of transaction receipts
 */
async function executeTransactions(transactions, wallet) {
  const receipts = [];

  for (const tx of transactions) {
    console.log(`[M2M] Executing step ${tx.step}: ${tx.description}`);
    const txResponse = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    console.log(`[M2M] TX hash: ${txResponse.hash}`);
    const receipt = await txResponse.wait();
    console.log(`[M2M] Confirmed in block ${receipt.blockNumber}`);
    receipts.push({
      step: tx.step,
      action: tx.action,
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    });
  }

  return receipts;
}

/**
 * Submit a Mogra wallet/transact payload via the Mogra API.
 *
 * @param {object} mograResult - Output from buildMograPayload()
 * @returns {Promise<object>} Mogra API response
 */
async function submitMograTransaction(mograResult) {
  const { mograPayload, apiConfig, meta } = mograResult;

  console.log(`[Mogra] Submitting ${meta.intent} for pool #${meta.poolId} (${meta.amountUsdc} USDC)`);

  const { execSync } = require("child_process");
  const body = JSON.stringify(mograPayload);

  const cmd = `curl -s -X POST "${apiConfig.url}" -H "Authorization: ${apiConfig.headers.Authorization}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`;

  try {
    const response = execSync(cmd, { encoding: "utf8", timeout: 30000 });
    const result = JSON.parse(response);
    console.log(`[Mogra] Response:`, JSON.stringify(result).substring(0, 200));
    return result;
  } catch (err) {
    console.error(`[Mogra] Failed:`, err.message);
    throw err;
  }
}

module.exports = {
  extractM2MPayloads,
  validatePayload,
  checkDepositWindow,
  buildJoinPoolTransactions,
  buildMograPayload,
  buildWithdrawTransaction,
  processPost,
  executeTransactions,
  submitMograTransaction,
  ALLOWED_ACTIONS,
  DEPOSIT_WINDOW_BUFFER,
  USDC_ADDRESS,
  MOGRA_API_BASE,
};
