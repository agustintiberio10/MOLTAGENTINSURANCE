/**
 * Blockchain interaction module — wraps ethers.js calls to MutualPool V1 and V3 contracts.
 *
 * Supports both legacy V1 (direct) and V3 (router-gated) flows:
 *   V1: createPool() pays premium directly
 *   V3: createPool() is zero-funded, fundPremium/joinPool go via Router
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

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
  constructor({ rpcUrl, privateKey, contractAddress, usdcAddress, v3Address, routerAddress }) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, MUTUAL_POOL_ABI, this.wallet);
    this.usdc = new ethers.Contract(usdcAddress, ERC20_ABI, this.wallet);
    this.contractAddress = contractAddress;

    // V3 contracts (optional — set after deploy-v3)
    if (v3Address) {
      this.v3 = new ethers.Contract(v3Address, MUTUAL_POOL_V3_ABI, this.wallet);
      this.v3Address = v3Address;
    }
    if (routerAddress) {
      this.router = new ethers.Contract(routerAddress, ROUTER_ABI, this.wallet);
      this.routerAddress = routerAddress;
    }
  }

  get agentAddress() {
    return this.wallet.address;
  }

  // --- USDC helpers ---

  async getUsdcBalance(address) {
    const balance = await this.usdc.balanceOf(address || this.wallet.address);
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
   * V3: Create pool structure (zero-funded, oracle-only, gas only).
   * No USDC is transferred — premium is funded separately via Router.
   */
  async createPoolV3({ description, evidenceSource, coverageAmount, premiumRate, deadline }) {
    if (!this.v3) throw new Error("V3 contract not configured");

    const coverageWei = ethers.parseUnits(coverageAmount.toString(), 6);
    console.log(`[V3] Creating pool: "${description}" (zero-funded)`);

    const tx = await this.v3.createPool(description, evidenceSource, coverageWei, premiumRate, deadline);
    const receipt = await tx.wait();

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
    const tx = await this.router.fundPremiumWithUSDC(poolId, amountWei);
    await tx.wait();
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
    const tx = await this.router.joinPoolWithUSDC(poolId, amountWei);
    await tx.wait();
    console.log(`[V3] Joined pool ${poolId}, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Resolve pool (oracle-only, same as V1).
   */
  async resolvePoolV3(poolId, claimApproved) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Resolving pool ${poolId}, claimApproved=${claimApproved}`);
    const tx = await this.v3.resolvePool(poolId, claimApproved);
    await tx.wait();
    console.log(`[V3] Pool ${poolId} resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Withdraw (open to participants, same as V1).
   */
  async withdrawV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Withdrawing from pool ${poolId}`);
    const tx = await this.v3.withdraw(poolId);
    await tx.wait();
    console.log(`[V3] Withdrawn, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Cancel and refund (same as V1).
   */
  async cancelAndRefundV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Cancelling pool ${poolId}`);
    const tx = await this.v3.cancelAndRefund(poolId);
    await tx.wait();
    console.log(`[V3] Pool ${poolId} cancelled, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Emergency resolve (same as V1).
   */
  async emergencyResolveV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    console.log(`[V3] Emergency resolving pool ${poolId}`);
    const tx = await this.v3.emergencyResolve(poolId);
    await tx.wait();
    console.log(`[V3] Pool ${poolId} emergency resolved, tx: ${tx.hash}`);
    return tx.hash;
  }

  /**
   * V3: Read pool data.
   */
  async getPoolV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");

    const data = await this.v3.getPool(poolId);
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
    return Number(await this.v3.nextPoolId());
  }

  async getRequiredPremiumV3(poolId) {
    if (!this.v3) throw new Error("V3 contract not configured");
    const amount = await this.v3.getRequiredPremium(poolId);
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
    const tx = await this.usdc.approve(spender, amountWei);
    await tx.wait();
    console.log("[Blockchain] Approved:", tx.hash);
    return tx;
  }
}

module.exports = BlockchainClient;
