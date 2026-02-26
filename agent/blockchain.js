/**
 * Blockchain interaction module — wraps ethers.js calls to the MutualPool contract.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ABI — only the functions we need
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

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

class BlockchainClient {
  constructor({ rpcUrl, privateKey, contractAddress, usdcAddress }) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.contract = new ethers.Contract(contractAddress, MUTUAL_POOL_ABI, this.wallet);
    this.usdc = new ethers.Contract(usdcAddress, ERC20_ABI, this.wallet);
    this.contractAddress = contractAddress;
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
}

module.exports = BlockchainClient;
