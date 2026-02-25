const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MutualPool", function () {
  let pool, usdc;
  let owner, oracle, insured, participant1, participant2;
  const PROTOCOL_OWNER = "0x2b4D825417f568231e809E31B9332ED146760337";
  const USDC_DECIMALS = 6;

  function usdcAmount(amount) {
    return ethers.parseUnits(amount.toString(), USDC_DECIMALS);
  }

  beforeEach(async function () {
    [owner, oracle, insured, participant1, participant2] = await ethers.getSigners();

    // Deploy a mock USDC (ERC20)
    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    // Deploy MutualPool
    const MutualPool = await ethers.getContractFactory("MutualPool");
    pool = await MutualPool.deploy(await usdc.getAddress(), oracle.address);
    await pool.waitForDeployment();

    // Mint USDC to participants and insured
    await usdc.mint(insured.address, usdcAmount(10_000));
    await usdc.mint(participant1.address, usdcAmount(10_000));
    await usdc.mint(participant2.address, usdcAmount(10_000));

    // Approve pool contract
    const poolAddr = await pool.getAddress();
    await usdc.connect(insured).approve(poolAddr, usdcAmount(10_000));
    await usdc.connect(participant1).approve(poolAddr, usdcAmount(10_000));
    await usdc.connect(participant2).approve(poolAddr, usdcAmount(10_000));
  });

  describe("Deployment", function () {
    it("should set the correct oracle", async function () {
      expect(await pool.oracle()).to.equal(oracle.address);
    });

    it("should set the correct protocol owner constant", async function () {
      expect(await pool.PROTOCOL_OWNER()).to.equal(PROTOCOL_OWNER);
    });

    it("should set protocol fee to 300 bps (3%)", async function () {
      expect(await pool.PROTOCOL_FEE_BPS()).to.equal(300);
    });
  });

  describe("createPool", function () {
    it("should create a pool and transfer premium", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400; // 1 day
      const coverageAmount = usdcAmount(100);
      const premiumRate = 500; // 5%

      await expect(
        pool.connect(insured).createPool(
          "Test event",
          "https://example.com/evidence",
          coverageAmount,
          premiumRate,
          deadline
        )
      ).to.emit(pool, "PoolCreated");

      const poolData = await pool.getPool(0);
      expect(poolData.description).to.equal("Test event");
      expect(poolData.coverageAmount).to.equal(coverageAmount);
      expect(poolData.insured).to.equal(insured.address);
      expect(poolData.status).to.equal(0); // Open
    });

    it("should reject pool with zero coverage", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 86400;
      await expect(
        pool.connect(insured).createPool("Test", "https://example.com", 0, 500, deadline)
      ).to.be.revertedWith("MutualPool: coverage too low");
    });

    it("should reject pool with past deadline", async function () {
      await expect(
        pool.connect(insured).createPool("Test", "https://example.com", usdcAmount(100), 500, 1000)
      ).to.be.revertedWith("MutualPool: deadline must be in the future");
    });
  });

  describe("joinPool", function () {
    let deadline;

    beforeEach(async function () {
      deadline = Math.floor(Date.now() / 1000) + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
    });

    it("should allow a participant to join with valid amount", async function () {
      await expect(pool.connect(participant1).joinPool(0, usdcAmount(50)))
        .to.emit(pool, "AgentJoined")
        .withArgs(0, participant1.address, usdcAmount(50));
    });

    it("should reject below minimum contribution", async function () {
      await expect(
        pool.connect(participant1).joinPool(0, usdcAmount(5))
      ).to.be.revertedWith("MutualPool: below minimum contribution");
    });

    it("should auto-activate when collateral reaches coverage", async function () {
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await expect(pool.connect(participant2).joinPool(0, usdcAmount(50)))
        .to.emit(pool, "PoolActivated");

      const poolData = await pool.getPool(0);
      expect(poolData.status).to.equal(1); // Active
    });

    it("should prevent insured from joining their own pool", async function () {
      await expect(
        pool.connect(insured).joinPool(0, usdcAmount(50))
      ).to.be.revertedWith("MutualPool: insured cannot join as participant");
    });
  });

  describe("resolvePool — no claim", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 3600; // 1 hour from now
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500, // 5% premium
        deadline
      );
      // Participant joins with enough to activate
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      // Advance time past deadline
      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine");
    });

    it("should resolve with no claim and emit events", async function () {
      await expect(pool.connect(oracle).resolvePool(0, false))
        .to.emit(pool, "PoolResolved")
        .to.emit(pool, "FeeCollected");

      const poolData = await pool.getPool(0);
      expect(poolData.status).to.equal(2); // Resolved
      expect(poolData.claimApproved).to.equal(false);
    });

    it("should send fee to protocol owner", async function () {
      const feeBefore = await usdc.balanceOf(PROTOCOL_OWNER);
      await pool.connect(oracle).resolvePool(0, false);
      const feeAfter = await usdc.balanceOf(PROTOCOL_OWNER);

      // Premium = 100 * 5% = 5 USDC, Fee = 5 * 3% = 0.15 USDC
      expect(feeAfter - feeBefore).to.equal(usdcAmount(0.15));
    });

    it("should only allow oracle to resolve", async function () {
      await expect(
        pool.connect(participant1).resolvePool(0, false)
      ).to.be.revertedWith("MutualPool: caller is not the oracle");
    });
  });

  describe("withdraw — no claim", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 3600;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine");

      await pool.connect(oracle).resolvePool(0, false);
    });

    it("should allow participants to withdraw collateral + premium share", async function () {
      const balBefore = await usdc.balanceOf(participant1.address);
      await pool.connect(participant1).withdraw(0);
      const balAfter = await usdc.balanceOf(participant1.address);

      // participant1 contributed 60 of 110 total collateral
      // Premium after fee = 5 - 0.15 = 4.85 USDC
      // participant1 share of premium = 4.85 * 60/110 = ~2.645454
      // Total withdrawal = 60 + 2.645454 = ~62.645454
      const withdrawn = balAfter - balBefore;
      expect(withdrawn).to.be.gt(usdcAmount(62));
    });

    it("should prevent double withdrawal", async function () {
      await pool.connect(participant1).withdraw(0);
      await expect(
        pool.connect(participant1).withdraw(0)
      ).to.be.revertedWith("MutualPool: already withdrawn");
    });

    it("should prevent insured from withdrawing when no claim", async function () {
      await expect(
        pool.connect(insured).withdraw(0)
      ).to.be.revertedWith("MutualPool: insured has no withdrawal when no claim");
    });
  });

  describe("withdraw — claim approved", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 3600;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      await ethers.provider.send("evm_increaseTime", [3700]);
      await ethers.provider.send("evm_mine");

      await pool.connect(oracle).resolvePool(0, true);
    });

    it("should allow insured to withdraw coverage amount", async function () {
      const balBefore = await usdc.balanceOf(insured.address);
      await pool.connect(insured).withdraw(0);
      const balAfter = await usdc.balanceOf(insured.address);

      // Insured should receive coverage amount (100 USDC)
      expect(balAfter - balBefore).to.equal(usdcAmount(100));
    });

    it("should allow participants to withdraw excess + premium share", async function () {
      const balBefore = await usdc.balanceOf(participant1.address);
      await pool.connect(participant1).withdraw(0);
      const balAfter = await usdc.balanceOf(participant1.address);

      // Total collateral = 110, coverage = 100, excess = 10
      // participant1 share of excess = 10 * 60/110 = ~5.454545
      // Premium after fee = 4.85, participant1 share = 4.85 * 60/110 = ~2.645454
      // Total = ~8.1
      const withdrawn = balAfter - balBefore;
      expect(withdrawn).to.be.gt(0);
    });
  });
});
