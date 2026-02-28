/**
 * Blockchain interaction module — wraps ethers.js calls to MutualPool contracts.
 *
 * Supports:
 *   V1:     Legacy direct createPool() flow
 *   V3:     Zero-funded, router-gated flow
 *   Lumina: Standalone — createAndFund() + joinPool() direct (no router)
 *
 * Infrastructure:
 *   - FallbackProvider: Alchemy (priority 1) → Infura (priority 2) → Public RPC (priority 3)
 *   - Exponential backoff on CALL_EXCEPTION / 429 / network errors
 *   - Nonce-safe TX queue for serialized writes
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════
// EXPONENTIAL BACKOFF HELPER (Eje 4)
// ═══════════════════════════════════════════════════════════════

/**
 * Execute an async function with exponential backoff on transient errors.
 * Retries on: CALL_EXCEPTION, NETWORK_ERROR, TIMEOUT, SERVER_ERROR, 429.
 *
 * @param {Function} asyncFn - Async function to execute
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @param {number} baseDelay - Base delay in ms (default 2000)
 * @returns {Promise<*>} Result of asyncFn
 */
async function executeWithBackoff(asyncFn, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await asyncFn();
    } catch (err) {
      lastError = err;
      const code = err.code || "";
      const message = (err.message || "").toLowerCase();
      const isTransient =
        code === "CALL_EXCEPTION" ||
        code === "NETWORK_ERROR" ||
        code === "TIMEOUT" ||
        code === "SERVER_ERROR" ||
        code === "UNKNOWN_ERROR" ||
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("missing revert data") ||
        message.includes("could not coalesce") ||
        message.includes("failed to fetch") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("socket hang up");

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt); // 2s, 4s, 8s
      console.log(`[Backoff] Attempt ${attempt + 1}/${maxRetries} failed (${code || err.message}). Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK PROVIDER FACTORY (Eje 2)
// ═══════════════════════════════════════════════════════════════

/**
 * Build a resilient provider using ethers v6 FallbackProvider.
 * Priority: ALCHEMY_RPC_URL (weight 2) → INFURA_RPC_URL (weight 1) → public RPC (weight 1)
 *
 * With Alchemy at weight 2 and quorum = ceil(totalWeight/2), Alchemy alone
 * satisfies the quorum — Infura and public only kick in if Alchemy stalls.
 *
 * @param {string} primaryRpcUrl - The BASE_RPC_URL from env (public fallback)
 * @returns {ethers.AbstractProvider}
 */
function buildFallbackProvider(primaryRpcUrl) {
  const configs = [];

  // Priority 1: Alchemy (premium, fast, weight 2)
  if (process.env.ALCHEMY_RPC_URL) {
    configs.push({
      provider: new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL),
      priority: 1,
      stallTimeout: 2000,
      weight: 2,
    });
    console.log("[Provider] Alchemy RPC configured (priority 1, weight 2)");
  }

  // Priority 2: Infura (reliable backup, weight 1)
  if (process.env.INFURA_RPC_URL) {
    configs.push({
      provider: new ethers.JsonRpcProvider(process.env.INFURA_RPC_URL),
      priority: 2,
      stallTimeout: 3000,
      weight: 1,
    });
    console.log("[Provider] Infura RPC configured (priority 2, weight 1)");
  }

  // Priority 3: Public RPC (last resort, weight 1)
  const publicUrl = primaryRpcUrl || "https://mainnet.base.org";
  configs.push({
    provider: new ethers.JsonRpcProvider(publicUrl),
    priority: 3,
    stallTimeout: 4000,
    weight: 1,
  });
  console.log(`[Provider] Public RPC configured (priority 3, weight 1): ${publicUrl}`);

  // If only 1 provider, use it directly (no FallbackProvider overhead)
  if (configs.length === 1) {
    console.log("[Provider] Single provider mode — no fallback.");
    return configs[0].provider;
  }

  // FallbackProvider: quorum defaults to ceil(totalWeight/2)
  // With Alchemy(2) + Infura(1) + Public(1) = 4, quorum = 2.
  // Alchemy alone (weight 2) satisfies quorum → primary provider.
  const fallback = new ethers.FallbackProvider(configs);
  const totalWeight = configs.reduce((s, c) => s + c.weight, 0);
  console.log(`[Provider] FallbackProvider active: ${configs.length} providers, totalWeight=${totalWeight}, quorum=${Math.ceil(totalWeight / 2)}`);
  return fallback;
}

// ABI — V1 (legacy)
const MUTUAL_POOL_ABI = [
  "function createPool(string _description, string _evidenceSource, uint256 _coverageAmount, uint256 _premiumRate, uint256 _deadline) external returns (uint256)",
  "function joinPool(uint256 _poolId, uint256 _amount) external",
  "function resolvePool(uint256 _poolId, bool _claimApproved) external",
  "function withdraw(uint256 _poolId) external",
  "function cancelAndRefund(uint256 _poolId) external",
  "function emergencyResolve(uint256 _poolId) external",
  "function getPool(uint256 _poolId) external view returns (string description, string evidenceSource, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline, address insured, uint256 premiumPaid, uint256 totalCollateral, uint8 status, bool claimApproved, uint256 participantCount)",
  "function getPoolParticipants(uint256 _poolId) external view returns (address[])",
  "function getContribution(uint256 _poolId, address _participant) external view returns (uint256)",
  "function getPoolAccounting(uint256 _poolId) external view returns (uint256 premiumAfterFee, uint256 protocolFee, uint256 totalCollateral)",
  "function nextPoolId() external view returns (uint256)",
  "function oracle() external view returns (address)",
  "function DEPOSIT_WINDOW_BUFFER() external view returns (uint256)",
  "function EMERGENCY_RESOLVE_DELAY() external view returns (uint256)",
  "event PoolCreated(uint256 indexed poolId, address indexed insured, string description, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline)",
  "event AgentJoined(uint256 indexed poolId, address indexed participant, uint256 amount)",
  "event PoolActivated(uint256 indexed poolId, uint256 totalCollateral)",
  "event PoolResolved(uint256 indexed poolId, bool claimApproved, uint256 totalCollateral, uint256 premiumAfterFee, uint256 protocolFee)",
  "event PoolCancelled(uint256 indexed poolId, uint256 totalCollateral, uint256 premiumRefunded)",
  "event EmergencyResolved(uint256 indexed poolId, address indexed triggeredBy)",
  "event FeeCollected(uint256 indexed poolId, uint256 feeAmount)",
  "event Withdrawn(uint256 indexed poolId, address indexed participant, uint256 amount)",
];

// ABI — V3 (zero-funded, router-gated)
const MUTUAL_POOL_V3_ABI = [
  "function createPool(string _description, string _evidenceSource, uint256 _coverageAmount, uint256 _premiumRate, uint256 _deadline) external returns (uint256)",
  "function fundPremium(uint256 _poolId, address _insured) external",
  "function joinPool(uint256 _poolId, uint256 _amount, address _participant) external",
  "function resolvePool(uint256 _poolId, bool _claimApproved) external",
  "function withdraw(uint256 _poolId) external",
  "function cancelAndRefund(uint256 _poolId) external",
  "function emergencyResolve(uint256 _poolId) external",
  "function getPool(uint256 _poolId) external view returns (string description, string evidenceSource, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline, address insured, uint256 premiumPaid, uint256 totalCollateral, uint8 status, bool claimApproved, uint256 participantCount)",
  "function getPoolParticipants(uint256 _poolId) external view returns (address[])",
  "function getContribution(uint256 _poolId, address _participant) external view returns (uint256)",
  "function getPoolAccounting(uint256 _poolId) external view returns (uint256 premiumAfterFee, uint256 protocolFee, uint256 totalCollateral)",
  "function getRequiredPremium(uint256 _poolId) external view returns (uint256)",
  "function nextPoolId() external view returns (uint256)",
  "function oracle() external view returns (address)",
  "function router() external view returns (address)",
  "event PoolCreated(uint256 indexed poolId, string description, uint256 coverageAmount, uint256 premiumRate, uint256 deadline)",
  "event PremiumFunded(uint256 indexed poolId, address indexed insured, uint256 premiumAmount)",
  "event AgentJoined(uint256 indexed poolId, address indexed participant, uint256 amount)",
  "event PoolActivated(uint256 indexed poolId, uint256 totalCollateral)",
  "event PoolResolved(uint256 indexed poolId, bool claimApproved, uint256 totalCollateral, uint256 premiumAfterFee, uint256 protocolFee)",
  "event PoolCancelled(uint256 indexed poolId, uint256 totalCollateral, uint256 premiumRefunded)",
  "event EmergencyResolved(uint256 indexed poolId, address indexed triggeredBy)",
  "event FeeCollected(uint256 indexed poolId, uint256 feeAmount)",
  "event Withdrawn(uint256 indexed poolId, address indexed participant, uint256 amount)",
];

// ABI — MutualLumina (standalone, no router)
const MUTUAL_LUMINA_ABI = [
  "function createAndFund(string _description, string _evidenceSource, uint256 _coverageAmount, uint256 _premiumRate, uint256 _deadline) external returns (uint256)",
  "function joinPool(uint256 _poolId, uint256 _amount) external",
  "function resolvePool(uint256 _poolId, bool _claimApproved) external",
  "function withdraw(uint256 _poolId) external",
  "function cancelAndRefund(uint256 _poolId) external",
  "function emergencyResolve(uint256 _poolId) external",
  "function getPool(uint256 _poolId) external view returns (string description, string evidenceSource, uint256 coverageAmount, uint256 premiumRate, uint256 deadline, uint256 depositDeadline, address insured, uint256 premiumPaid, uint256 totalCollateral, uint8 status, bool claimApproved, uint256 participantCount)",
  "function getPoolParticipants(uint256 _poolId) external view returns (address[])",
  "function getContribution(uint256 _poolId, address _participant) external view returns (uint256)",
  "function getPoolAccounting(uint256 _poolId) external view returns (uint256 netAmount, uint256 protocolFee, uint256 totalCollateral)",
  "function calculatePremium(uint256 _coverageAmount, uint256 _premiumRate) external pure returns (uint256)",
  "function nextPoolId() external view returns (uint256)",
  "function oracle() external view returns (address)",
  "event PoolCreated(uint256 indexed poolId, string description, uint256 coverageAmount, uint256 premiumRate, uint256 deadline)",
  "event PremiumFunded(uint256 indexed poolId, address indexed insured, uint256 premiumAmount)",
  "event AgentJoined(uint256 indexed poolId, address indexed participant, uint256 amount)",
  "event PoolActivated(uint256 indexed poolId, uint256 totalCollateral)",
  "event PoolResolved(uint256 indexed poolId, bool claimApproved, uint256 totalCollateral, uint256 netAmount, uint256 protocolFee)",
  "event PoolCancelled(uint256 indexed poolId, uint256 totalCollateral, uint256 premiumRefunded)",
  "event EmergencyResolved(uint256 indexed poolId, address indexed triggeredBy)",
  "event FeeCollected(uint256 indexed poolId, uint256 feeAmount)",
  "event Withdrawn(uint256 indexed poolId, address indexed participant, uint256 amount)",
];

// ABI — Router
const ROUTER_ABI = [
  "function fundPremiumWithUSDC(uint256 poolId, uint256 amount) external",
  "function joinPoolWithUSDC(uint256 poolId, uint256 amount) external",
  "function fundPremiumWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut) external",
  "function joinPoolWithMPOOL(uint256 poolId, uint256 mpoolAmount, uint256 minUsdcOut) external",
  "function quoteMpoolToUsdc(uint256 mpoolAmount) external view returns (uint256)",
  "function paused() external view returns (bool)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

class BlockchainClient {
  constructor({ rpcUrl, privateKey, contractAddress, usdcAddress, v3Address, routerAddress, luminaAddress }) {
    // ── FallbackProvider with multi-RPC resilience ──
    this.provider = buildFallbackProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.usdc = new ethers.Contract(usdcAddress, ERC20_ABI, this.wallet);

    // V1 contract (legacy, optional)
    if (contractAddress) {
      this.contract = new ethers.Contract(contractAddress, MUTUAL_POOL_ABI, this.wallet);
      this.contractAddress = contractAddress;
    }

    // V3 contracts (legacy, optional)
    if (v3Address) {
      this.v3 = new ethers.Contract(v3Address, MUTUAL_POOL_V3_ABI, this.wallet);
      this.v3Address = v3Address;
    }
    if (routerAddress) {
      this.router = new ethers.Contract(routerAddress, ROUTER_ABI, this.wallet);
      this.routerAddress = routerAddress;
    }

    // MutualLumina contract (standalone, no router)
    if (luminaAddress) {
      this.lumina = new ethers.Contract(luminaAddress, MUTUAL_LUMINA_ABI, this.wallet);
      this.luminaAddress = luminaAddress;
    }

    // ══════════════════════════════════════════════════════════════
    // NONCE-SAFE TX QUEUE
    // ══════════════════════════════════════════════════════════════
    //
    // Serializes ALL write transactions through a single queue.
    // Prevents "nonce too low" errors when multiple txs fire in
    // the same heartbeat cycle (e.g., cancel + resolve + create).
    //
    // Flow:
    //   1. _enqueueTx() chains onto _txQueue (Promise chain)
    //   2. Fetches nonce from network on first tx, then increments locally
    //   3. On any error → resets nonce so next tx re-fetches
    //   4. Each tx waits 1 block confirmation before releasing the queue
    //
    this._txQueue = Promise.resolve();
    this._pendingNonce = null;
  }

  /**
   * Serialize a write transaction through the nonce queue.
   * ALL on-chain writes MUST go through this method.
   *
   * @param {Function} txFn - Receives { nonce } and returns a sent tx object
   * @returns {Promise<{ tx: TransactionResponse, receipt: TransactionReceipt }>}
   */
  _enqueueTx(txFn) {
    const promise = this._txQueue.then(async () => {
      // Fetch nonce from network if we don't have a local one
      if (this._pendingNonce === null) {
        this._pendingNonce = await this.provider.getTransactionCount(
          this.wallet.address,
          "pending"
        );
        console.log(`[TxQueue] Synced nonce from network: ${this._pendingNonce}`);
      }

      const nonce = this._pendingNonce;

      try {
        const tx = await txFn({ nonce });
        // Optimistically increment nonce for the next queued tx
        this._pendingNonce = nonce + 1;
        // Wait for 1 block confirmation before releasing
        const receipt = await tx.wait(1);
        console.log(`[TxQueue] Confirmed nonce=${nonce} tx=${tx.hash}`);
        return { tx, receipt };
      } catch (err) {
        // Reset nonce on ANY failure so next tx re-fetches from network
        console.error(`[TxQueue] Failed nonce=${nonce}: ${err.message}`);
        this._pendingNonce = null;
        throw err;
      }
    });

    // Keep the queue chain alive even if this tx fails
    this._txQueue = promise.catch(() => {});
    return promise;
  }

  get agentAddress() {
    return this.wallet.address;
  }

  // --- USDC helpers ---

  async getUsdcBalance(address) {
    const balance = await executeWithBackoff(() =>
      this.usdc.balanceOf(address || this.wallet.address)
    );
    return ethers.formatUnits(balance, 6);
  }

  async approveUsdc(amount) {
    const amountWei = ethers.parseUnits(amount.toString(), 6);
    const currentAllowance = await this.usdc.allowance(this.wallet.address, this.contractAddress);
    if (currentAllowance >= amountWei) {
      console.log("[Blockchain] USDC allowance sufficient, skipping approve");
      return null;
    }
    console.log(`[Blockchain] Approving ${amount} USDC for contract...`);
    const tx = await this.usdc.approve(this.contractAddress, amountWei);
    await tx.wait();
    console.log("[Blockchain] USDC approved:", tx.hash);
    return tx;
  }

  // --- Pool operations ---

  async createPool({ description, evidenceSource, coverageAmount, premiumRate, deadline }) {
    const coverageWei = ethers.parseUnits(coverageAmount.toString(), 6);
    const premiumAmount = (BigInt(coverageWei) * BigInt(premiumRate)) / BigInt(10_000);

    // Approve premium payment
    await this.approveUsdc(Number(ethers.formatUnits(premiumAmount, 6)));

    console.log(`[Blockchain] Creating pool: "${description}"`);
    const tx = await this.contract.createPool(
      description,
      evidenceSource,
      coverageWei,
      premiumRate,
      deadline
    );
    const receipt = await tx.wait();

    // Parse PoolCreated event to get pool ID
    const event = receipt.logs
      .map((log) => {
        try {
          return this.contract.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "PoolCreated");

    const poolId = event ? Number(event.args.poolId) : null;
    console.log(`[Blockchain] Pool created with ID: ${poolId}, tx: ${tx.hash}`);
    return { poolId, txHash: tx.hash };
  }

  async joinPool(poolId, amount) {
    const amountWei = ethers.parseUnits(amount.toString(), 6);
    await this.approveUsdc(amount);

    console.log(`[Blockchain] Joining pool ${poolId} with ${amount} USDC`);
    const tx = await this.contract.joinPool(poolId, amountWei);
    await tx.wait();
    console.log(`[Blockchain] Joined pool ${poolId}, tx: ${tx.hash}`);
    return tx.hash;
  }

  async resolvePool(poolId, claimApproved) {
    console.log(`[Blockchain] Resolving pool ${poolId}, claimApproved=${claimApproved}`);
    const tx = await this.contract.resolvePool(poolId, claimApproved);
    await tx.wait();
    console.log(`[Blockchain] Pool ${poolId} resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  async withdrawFromPool(poolId) {
    console.log(`[Blockchain] Withdrawing from pool ${poolId}`);
    const tx = await this.contract.withdraw(poolId);
    await tx.wait();
    console.log(`[Blockchain] Withdrawn from pool ${poolId}, tx: ${tx.hash}`);
    return tx.hash;
  }

  // --- Read operations ---

  async getPool(poolId) {
    const data = await this.contract.getPool(poolId);
    return {
      description: data.description,
      evidenceSource: data.evidenceSource,
      coverageAmount: ethers.formatUnits(data.coverageAmount, 6),
      premiumRate: Number(data.premiumRate),
      deadline: Number(data.deadline),
      depositDeadline: Number(data.depositDeadline),
      insured: data.insured,
      premiumPaid: ethers.formatUnits(data.premiumPaid, 6),
      totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
      status: Number(data.status), // 0=Open, 1=Active, 2=Resolved, 3=Cancelled
      claimApproved: data.claimApproved,
      participantCount: Number(data.participantCount),
    };
  }

  async cancelAndRefund(poolId) {
    console.log(`[Blockchain] Cancelling underfunded pool ${poolId}`);
    const tx = await this.contract.cancelAndRefund(poolId);
    await tx.wait();
    console.log(`[Blockchain] Pool ${poolId} cancelled and refunded, tx: ${tx.hash}`);
    return tx.hash;
  }

  async emergencyResolve(poolId) {
    console.log(`[Blockchain] Emergency resolving pool ${poolId}`);
    const tx = await this.contract.emergencyResolve(poolId);
    await tx.wait();
    console.log(`[Blockchain] Pool ${poolId} emergency resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  async getPoolAccounting(poolId) {
    const data = await this.contract.getPoolAccounting(poolId);
    return {
      premiumAfterFee: ethers.formatUnits(data.premiumAfterFee, 6),
      protocolFee: ethers.formatUnits(data.protocolFee, 6),
      totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
    };
  }

  async getPoolParticipants(poolId) {
    return await this.contract.getPoolParticipants(poolId);
  }

  async getContribution(poolId, address) {
    const amount = await this.contract.getContribution(poolId, address);
    return ethers.formatUnits(amount, 6);
  }

  async getNextPoolId() {
    return Number(await this.contract.nextPoolId());
  }

  async getOracle() {
    return await this.contract.oracle();
  }

  // ═══════════════════════════════════════════════════════════
  // V3 OPERATIONS (zero-funded, router-gated)
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if V3 contracts are configured.
   */
  get hasV3() {
    return !!this.v3;
  }

  /**
   * V3: Create pool structure (zero-funded, oracle-only, ETH gas only).
   *
   * IMPORTANT — Eje 1: The Oracle is msg.sender here. It only pays ETH gas.
   * NO USDC is touched in this phase. The insured client funds premium later
   * via Router.fundPremiumWithUSDC(). We use a fixed gasLimit to SKIP ethers
   * gas estimation, which prevents the RPC from simulating the contract
   * (the on-chain createPool may internally read USDC state, triggering
   * CALL_EXCEPTION on rate-limited public RPCs).
   */
  async createPoolV3({ description, evidenceSource, coverageAmount, premiumRate, deadline }) {
    if (!this.v3) throw new Error("V3 contract not configured");

    const coverageWei = ethers.parseUnits(coverageAmount.toString(), 6);
    console.log(`[V3] Creating pool: "${description}" (zero-funded, gasLimit=500k)`);

    // Fixed gasLimit skips eth_estimateGas → no internal USDC.balanceOf() simulation
    const { tx, receipt } = await this._enqueueTx(({ nonce }) =>
      this.v3.createPool(description, evidenceSource, coverageWei, premiumRate, deadline, {
        nonce,
        gasLimit: 500_000n,
      })
    );

    const event = receipt.logs
      .map((log) => {
        try { return this.v3.interface.parseLog(log); }
        catch { return null; }
      })
      .find((e) => e && e.name === "PoolCreated");

    const poolId = event ? Number(event.args.poolId) : null;
    console.log(`[V3] Pool created with ID: ${poolId}, tx: ${tx.hash}`);
    return { poolId, txHash: tx.hash };
  }

  /**
   * V3: Fund premium via Router (Mode A — direct USDC).
   * Approves Router, then calls Router.fundPremiumWithUSDC().
   */
  async fundPremiumV3(poolId, usdcAmount) {
    if (!this.router) throw new Error("Router not configured");

    const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
    await this._approveFor(this.routerAddress, amountWei);

    console.log(`[V3] Funding premium for pool ${poolId}: ${usdcAmount} USDC via Router`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.router.fundPremiumWithUSDC(poolId, amountWei, { nonce })
    );
    console.log(`[V3] Premium funded, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Join pool via Router (Mode A — direct USDC).
   */
  async joinPoolV3(poolId, usdcAmount) {
    if (!this.router) throw new Error("Router not configured");

    const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
    await this._approveFor(this.routerAddress, amountWei);

    console.log(`[V3] Joining pool ${poolId} with ${usdcAmount} USDC via Router`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.router.joinPoolWithUSDC(poolId, amountWei, { nonce })
    );
    console.log(`[V3] Joined pool ${poolId}, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Resolve pool (oracle-only, same as V1).
   */
  async resolvePoolV3(poolId, claimApproved) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Resolving pool ${poolId}, claimApproved=${claimApproved}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.v3.resolvePool(poolId, claimApproved, { nonce })
    );
    console.log(`[V3] Pool ${poolId} resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Withdraw (open to participants, same as V1).
   */
  async withdrawV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Withdrawing from pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.v3.withdraw(poolId, { nonce })
    );
    console.log(`[V3] Withdrawn, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Cancel and refund (same as V1).
   */
  async cancelAndRefundV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Cancelling pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.v3.cancelAndRefund(poolId, { nonce })
    );
    console.log(`[V3] Pool ${poolId} cancelled, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Emergency resolve (same as V1).
   */
  async emergencyResolveV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Emergency resolving pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.v3.emergencyResolve(poolId, { nonce })
    );
    console.log(`[V3] Pool ${poolId} emergency resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Read pool data (wrapped with exponential backoff).
   */
  async getPoolV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    const data = await executeWithBackoff(() => this.v3.getPool(poolId));
    return {
      description: data.description,
      evidenceSource: data.evidenceSource,
      coverageAmount: ethers.formatUnits(data.coverageAmount, 6),
      premiumRate: Number(data.premiumRate),
      deadline: Number(data.deadline),
      depositDeadline: Number(data.depositDeadline),
      insured: data.insured,
      premiumPaid: ethers.formatUnits(data.premiumPaid, 6),
      totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
      status: Number(data.status), // 0=Pending, 1=Open, 2=Active, 3=Resolved, 4=Cancelled
      claimApproved: data.claimApproved,
      participantCount: Number(data.participantCount),
    };
  }

  async getNextPoolIdV3() {
    if (!this.v3) throw new Error("V3 contract not configured");
    return Number(await executeWithBackoff(() => this.v3.nextPoolId()));
  }

  async getRequiredPremiumV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");
    const amount = await executeWithBackoff(() => this.v3.getRequiredPremium(poolId));
    return ethers.formatUnits(amount, 6);
  }

  /**
   * V3: Quote MPOOLV3 → USDC via Router's swap handler.
   */
  async quoteMpoolToUsdc(mpoolAmount) {
    if (!this.router) throw new Error("Router not configured");
    const amountWei = ethers.parseUnits(mpoolAmount.toString(), 18);
    const usdcOut = await this.router.quoteMpoolToUsdc(amountWei);
    return ethers.formatUnits(usdcOut, 6);
  }

  // ═══════════════════════════════════════════════════════════
  // LUMINA OPERATIONS (standalone — no router)
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if Lumina contract is configured.
   */
  get hasLumina() {
    return !!this.lumina;
  }

  /**
   * Lumina: Create pool + fund premium in a single transaction.
   * The oracle (msg.sender) pays the premium in USDC directly.
   * Pool starts in Open status immediately.
   */
  async createAndFundLumina({ description, evidenceSource, coverageAmount, premiumRate, deadline }) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    const coverageWei = ethers.parseUnits(coverageAmount.toString(), 6);
    const premiumAmount = (BigInt(coverageWei) * BigInt(premiumRate)) / BigInt(10_000);

    // Approve Lumina contract for premium USDC
    await this._approveFor(this.luminaAddress, premiumAmount);

    console.log(`[Lumina] createAndFund: "${description}" (coverage=${coverageAmount}, premium=${ethers.formatUnits(premiumAmount, 6)} USDC)`);

    const { tx, receipt } = await this._enqueueTx(({ nonce }) =>
      this.lumina.createAndFund(description, evidenceSource, coverageWei, premiumRate, deadline, {
        nonce,
        gasLimit: 600_000n,
      })
    );

    const event = receipt.logs
      .map((log) => {
        try { return this.lumina.interface.parseLog(log); }
        catch { return null; }
      })
      .find((e) => e && e.name === "PoolCreated");

    const poolId = event ? Number(event.args.poolId) : null;
    console.log(`[Lumina] Pool created with ID: ${poolId}, tx: ${tx.hash}`);
    return { poolId, txHash: tx.hash, premiumPaid: ethers.formatUnits(premiumAmount, 6) };
  }

  /**
   * Lumina: Join pool as collateral provider (direct USDC, no router).
   */
  async joinPoolLumina(poolId, usdcAmount) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    const amountWei = ethers.parseUnits(usdcAmount.toString(), 6);
    await this._approveFor(this.luminaAddress, amountWei);

    console.log(`[Lumina] Joining pool ${poolId} with ${usdcAmount} USDC (direct)`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.lumina.joinPool(poolId, amountWei, { nonce })
    );
    console.log(`[Lumina] Joined pool ${poolId}, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Lumina: Resolve pool (oracle-only).
   */
  async resolvePoolLumina(poolId, claimApproved) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    console.log(`[Lumina] Resolving pool ${poolId}, claimApproved=${claimApproved}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.lumina.resolvePool(poolId, claimApproved, { nonce })
    );
    console.log(`[Lumina] Pool ${poolId} resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Lumina: Withdraw after resolution/cancellation.
   */
  async withdrawLumina(poolId) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    console.log(`[Lumina] Withdrawing from pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.lumina.withdraw(poolId, { nonce })
    );
    console.log(`[Lumina] Withdrawn, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Lumina: Cancel underfunded pool.
   */
  async cancelAndRefundLumina(poolId) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    console.log(`[Lumina] Cancelling pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.lumina.cancelAndRefund(poolId, { nonce })
    );
    console.log(`[Lumina] Pool ${poolId} cancelled, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Lumina: Emergency resolve (anyone, after 24h).
   */
  async emergencyResolveLumina(poolId) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    console.log(`[Lumina] Emergency resolving pool ${poolId}`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.lumina.emergencyResolve(poolId, { nonce })
    );
    console.log(`[Lumina] Pool ${poolId} emergency resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * Lumina: Read pool data.
   */
  async getPoolLumina(poolId) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    const data = await executeWithBackoff(() => this.lumina.getPool(poolId));
    return {
      description: data.description,
      evidenceSource: data.evidenceSource,
      coverageAmount: ethers.formatUnits(data.coverageAmount, 6),
      premiumRate: Number(data.premiumRate),
      deadline: Number(data.deadline),
      depositDeadline: Number(data.depositDeadline),
      insured: data.insured,
      premiumPaid: ethers.formatUnits(data.premiumPaid, 6),
      totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
      status: Number(data.status), // 0=Open, 1=Active, 2=Resolved, 3=Cancelled
      claimApproved: data.claimApproved,
      participantCount: Number(data.participantCount),
    };
  }

  /**
   * Lumina: Get pool accounting after resolution.
   */
  async getPoolAccountingLumina(poolId) {
    if (!this.lumina) throw new Error("Lumina contract not configured");

    const data = await executeWithBackoff(() => this.lumina.getPoolAccounting(poolId));
    return {
      netAmount: ethers.formatUnits(data.netAmount, 6),
      protocolFee: ethers.formatUnits(data.protocolFee, 6),
      totalCollateral: ethers.formatUnits(data.totalCollateral, 6),
    };
  }

  async getNextPoolIdLumina() {
    if (!this.lumina) throw new Error("Lumina contract not configured");
    return Number(await executeWithBackoff(() => this.lumina.nextPoolId()));
  }

  /**
   * Lumina: Build Mogra-compatible payload for createAndFund or joinPool.
   */
  buildMograLuminaPayload(method, params) {
    if (!this.luminaAddress) throw new Error("Lumina contract not configured");

    const luminaIface = new ethers.Interface(MUTUAL_LUMINA_ABI);
    const erc20Iface = new ethers.Interface(ERC20_ABI);
    let calldata, approveCalldata, approveAmount;

    if (method === "createAndFund") {
      const coverageWei = ethers.parseUnits(params.coverageAmount.toString(), 6);
      const premiumWei = (BigInt(coverageWei) * BigInt(params.premiumRate)) / BigInt(10_000);
      approveAmount = premiumWei;
      calldata = luminaIface.encodeFunctionData("createAndFund", [
        params.description,
        params.evidenceSource,
        coverageWei,
        params.premiumRate,
        params.deadline,
      ]);
      approveCalldata = erc20Iface.encodeFunctionData("approve", [this.luminaAddress, premiumWei]);
    } else if (method === "joinPool") {
      const amountWei = ethers.parseUnits(params.amount.toString(), 6);
      approveAmount = amountWei;
      calldata = luminaIface.encodeFunctionData("joinPool", [params.poolId, amountWei]);
      approveCalldata = erc20Iface.encodeFunctionData("approve", [this.luminaAddress, amountWei]);
    } else {
      throw new Error(`Unknown Lumina method: ${method}`);
    }

    return {
      network: "base",
      calls: [
        {
          to: this.usdc.target,
          data: approveCalldata,
          value: "0x0",
          description: `Approve ${ethers.formatUnits(approveAmount, 6)} USDC for MutualLumina`,
        },
        {
          to: this.luminaAddress,
          data: calldata,
          value: "0x0",
          description: `MutualLumina.${method}(${JSON.stringify(params)})`,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // MOGRA WALLET — Off-chain transaction payloads
  // ═══════════════════════════════════════════════════════════

  /**
   * Build a Mogra-compatible transaction payload for wallet/transact API.
   * Mogra signs and submits the tx on behalf of the agent.
   *
   * @param {string} method - "fundPremiumWithUSDC" | "joinPoolWithUSDC"
   * @param {object} params - { poolId, amount }
   * @returns {object} Mogra transact payload
   */
  buildMograPayload(method, params) {
    if (!this.routerAddress) throw new Error("Router not configured");

    const routerIface = new ethers.Interface(ROUTER_ABI);
    let calldata, approveCalldata;

    if (method === "fundPremiumWithUSDC") {
      const amountWei = ethers.parseUnits(params.amount.toString(), 6);
      calldata = routerIface.encodeFunctionData("fundPremiumWithUSDC", [params.poolId, amountWei]);
      approveCalldata = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [this.routerAddress, amountWei]);
    } else if (method === "joinPoolWithUSDC") {
      const amountWei = ethers.parseUnits(params.amount.toString(), 6);
      calldata = routerIface.encodeFunctionData("joinPoolWithUSDC", [params.poolId, amountWei]);
      approveCalldata = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [this.routerAddress, amountWei]);
    } else {
      throw new Error(`Unknown method: ${method}`);
    }

    return {
      network: "base",
      calls: [
        {
          to: this.usdc.target,
          data: approveCalldata,
          value: "0x0",
          description: `Approve ${params.amount} USDC for Router`,
        },
        {
          to: this.routerAddress,
          data: calldata,
          value: "0x0",
          description: `${method}(pool=${params.poolId}, amount=${params.amount} USDC)`,
        },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Approve USDC spending for a specific spender address.
   */
  async _approveFor(spender, amountWei) {
    const currentAllowance = await this.usdc.allowance(this.wallet.address, spender);
    if (currentAllowance >= amountWei) {
      console.log("[Blockchain] USDC allowance sufficient for", spender);
      return null;
    }
    console.log(`[Blockchain] Approving USDC for ${spender}...`);
    const { tx } = await this._enqueueTx(({ nonce }) =>
      this.usdc.approve(spender, amountWei, { nonce })
    );
    console.log("[Blockchain] Approved:", tx.hash);
    return tx;
  }
}

module.exports = BlockchainClient;
module.exports.executeWithBackoff = executeWithBackoff;
