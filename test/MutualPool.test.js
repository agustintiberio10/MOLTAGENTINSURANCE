const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MutualPool", function () {
  let pool, usdc;
  let owner, oracle, insured, participant1, participant2, anyone;
  const PROTOCOL_OWNER = "0x2b4D825417f568231e809E31B9332ED146760337";
  const USDC_DECIMALS = 6;
  const TWO_HOURS = 2 * 60 * 60;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60;

  function usdcAmount(amount) {
    return ethers.parseUnits(amount.toString(), USDC_DECIMALS);
  }

  beforeEach(async function () {
    [owner, oracle, insured, participant1, participant2, anyone] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const MutualPool = await ethers.getContractFactory("MutualPool");
    pool = await MutualPool.deploy(await usdc.getAddress(), oracle.address);
    await pool.waitForDeployment();

    await usdc.mint(insured.address, usdcAmount(10_000));
    await usdc.mint(participant1.address, usdcAmount(10_000));
    await usdc.mint(participant2.address, usdcAmount(10_000));

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

    it("should set DEPOSIT_WINDOW_BUFFER to 2 hours", async function () {
      expect(await pool.DEPOSIT_WINDOW_BUFFER()).to.equal(TWO_HOURS);
    });

    it("should set EMERGENCY_RESOLVE_DELAY to 24 hours", async function () {
      expect(await pool.EMERGENCY_RESOLVE_DELAY()).to.equal(TWENTY_FOUR_HOURS);
    });
  });

  describe("createPool", function () {
    it("should create a pool with depositDeadline = deadline - 2h", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400; // 1 day

      await expect(
        pool.connect(insured).createPool(
          "Test event",
          "https://example.com/evidence",
          usdcAmount(100),
          500,
          deadline
        )
      ).to.emit(pool, "PoolCreated");

      const poolData = await pool.getPool(0);
      expect(poolData.description).to.equal("Test event");
      expect(poolData.coverageAmount).to.equal(usdcAmount(100));
      expect(poolData.insured).to.equal(insured.address);
      expect(poolData.status).to.equal(0); // Open
      expect(poolData.depositDeadline).to.equal(deadline - TWO_HOURS);
    });

    it("should reject pool with deadline too soon (< 2h from now)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 3600; // Only 1 hour from now
      await expect(
        pool.connect(insured).createPool("Test", "https://example.com", usdcAmount(100), 500, deadline)
      ).to.be.revertedWith("MutualPool: deadline too soon");
    });

    it("should reject pool with zero coverage", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;
      await expect(
        pool.connect(insured).createPool("Test", "https://example.com", 0, 500, deadline)
      ).to.be.revertedWith("MutualPool: coverage too low");
    });
  });

  describe("joinPool", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400; // 1 day
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
    });

    it("should allow a participant to join before depositDeadline", async function () {
      await expect(pool.connect(participant1).joinPool(0, usdcAmount(50)))
        .to.emit(pool, "AgentJoined")
        .withArgs(0, participant1.address, usdcAmount(50));
    });

    it("should reject join after depositDeadline (anti front-running)", async function () {
      // Advance time past depositDeadline (deadline - 2h)
      await ethers.provider.send("evm_increaseTime", [86400 - TWO_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        pool.connect(participant1).joinPool(0, usdcAmount(50))
      ).to.be.revertedWith("MutualPool: deposit window closed");
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

  describe("cancelAndRefund — underfunded pools", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      // Join with less than coverage amount (underfunded)
      await pool.connect(participant1).joinPool(0, usdcAmount(40));
    });

    it("should revert before depositDeadline", async function () {
      await expect(
        pool.connect(anyone).cancelAndRefund(0)
      ).to.be.revertedWith("MutualPool: deposit window still open");
    });

    it("should cancel and refund premium to insured after depositDeadline", async function () {
      // Advance to depositDeadline
      await ethers.provider.send("evm_increaseTime", [86400 - TWO_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      const insuredBalBefore = await usdc.balanceOf(insured.address);

      await expect(pool.connect(anyone).cancelAndRefund(0))
        .to.emit(pool, "PoolCancelled");

      const insuredBalAfter = await usdc.balanceOf(insured.address);
      // Premium = 100 * 5% = 5 USDC
      expect(insuredBalAfter - insuredBalBefore).to.equal(usdcAmount(5));

      const poolData = await pool.getPool(0);
      expect(poolData.status).to.equal(3); // Cancelled
    });

    it("should allow providers to withdraw collateral after cancel", async function () {
      await ethers.provider.send("evm_increaseTime", [86400 - TWO_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      await pool.connect(anyone).cancelAndRefund(0);

      const balBefore = await usdc.balanceOf(participant1.address);
      await pool.connect(participant1).withdraw(0);
      const balAfter = await usdc.balanceOf(participant1.address);

      // Should get back full 40 USDC collateral
      expect(balAfter - balBefore).to.equal(usdcAmount(40));
    });

    it("should reject cancel if pool is fully funded (auto-activated)", async function () {
      // Fund fully — pool auto-activates to Active status
      await pool.connect(participant2).joinPool(0, usdcAmount(60));

      await ethers.provider.send("evm_increaseTime", [86400 - TWO_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      // Pool is now Active, not Open — cancelAndRefund requires Open
      await expect(
        pool.connect(anyone).cancelAndRefund(0)
      ).to.be.revertedWith("MutualPool: pool is not open");
    });
  });

  describe("resolvePool — no claim (with segregated accounting)", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");
    });

    it("should resolve with no claim and segregate funds", async function () {
      await expect(pool.connect(oracle).resolvePool(0, false))
        .to.emit(pool, "PoolResolved")
        .to.emit(pool, "FeeCollected");

      const poolData = await pool.getPool(0);
      expect(poolData.status).to.equal(2); // Resolved
      expect(poolData.claimApproved).to.equal(false);

      // Check segregated accounting
      const accounting = await pool.getPoolAccounting(0);
      // Premium = 100 * 5% = 5 USDC, Fee = 5 * 3% = 0.15 USDC
      expect(accounting.protocolFee).to.equal(usdcAmount(0.15));
      expect(accounting.premiumAfterFee).to.equal(usdcAmount(4.85));
    });

    it("should send fee to protocol owner", async function () {
      const feeBefore = await usdc.balanceOf(PROTOCOL_OWNER);
      await pool.connect(oracle).resolvePool(0, false);
      const feeAfter = await usdc.balanceOf(PROTOCOL_OWNER);

      expect(feeAfter - feeBefore).to.equal(usdcAmount(0.15));
    });

    it("should only allow oracle to resolve", async function () {
      await expect(
        pool.connect(participant1).resolvePool(0, false)
      ).to.be.revertedWith("MutualPool: caller is not the oracle");
    });
  });

  describe("emergencyResolve — oracle timeout", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));
    });

    it("should revert before deadline + 24h", async function () {
      // Only advance to deadline (not deadline + 24h)
      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        pool.connect(anyone).emergencyResolve(0)
      ).to.be.revertedWith("MutualPool: emergency resolve not yet available");
    });

    it("should allow anyone to emergency resolve after deadline + 24h", async function () {
      // Advance past deadline + 24h
      await ethers.provider.send("evm_increaseTime", [86400 + TWENTY_FOUR_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      await expect(pool.connect(anyone).emergencyResolve(0))
        .to.emit(pool, "EmergencyResolved")
        .to.emit(pool, "PoolResolved");

      const poolData = await pool.getPool(0);
      expect(poolData.status).to.equal(2); // Resolved
      expect(poolData.claimApproved).to.equal(false); // Safety default
    });

    it("should allow providers to withdraw after emergency resolve", async function () {
      await ethers.provider.send("evm_increaseTime", [86400 + TWENTY_FOUR_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      await pool.connect(anyone).emergencyResolve(0);

      const balBefore = await usdc.balanceOf(participant1.address);
      await pool.connect(participant1).withdraw(0);
      const balAfter = await usdc.balanceOf(participant1.address);

      // Should get collateral + premium share
      expect(balAfter - balBefore).to.be.gt(usdcAmount(60));
    });
  });

  describe("withdraw — no claim (segregated)", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
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

  describe("withdraw — claim approved (segregated accounting)", function () {
    let deadline;

    beforeEach(async function () {
      const block = await ethers.provider.getBlock("latest");
      deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(60));
      await pool.connect(participant2).joinPool(0, usdcAmount(50));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await pool.connect(oracle).resolvePool(0, true);
    });

    it("should allow insured to withdraw coverage amount", async function () {
      const balBefore = await usdc.balanceOf(insured.address);
      await pool.connect(insured).withdraw(0);
      const balAfter = await usdc.balanceOf(insured.address);

      expect(balAfter - balBefore).to.equal(usdcAmount(100));
    });

    it("should allow participants to withdraw premium share + excess collateral", async function () {
      const balBefore = await usdc.balanceOf(participant1.address);
      await pool.connect(participant1).withdraw(0);
      const balAfter = await usdc.balanceOf(participant1.address);

      // Total collateral = 110, coverage = 100, excess = 10
      // participant1 contribution = 60 of 110 total
      // Premium after fee = 4.85 USDC
      // Premium share = 4.85 * 60/110 = ~2.645454
      // Excess share = 10 * 60/110 = ~5.454545
      // Total = ~8.1
      const withdrawn = balAfter - balBefore;
      expect(withdrawn).to.be.gt(0);
    });

    it("should never revert for providers (segregated funds)", async function () {
      // Both the insured and both providers should be able to withdraw
      await pool.connect(insured).withdraw(0);
      await pool.connect(participant1).withdraw(0);
      await pool.connect(participant2).withdraw(0);

      // Verify all withdrew successfully (no reverts)
      expect(await pool.insuredWithdrawn(0)).to.equal(true);
      expect(await pool.hasWithdrawn(0, participant1.address)).to.equal(true);
      expect(await pool.hasWithdrawn(0, participant2.address)).to.equal(true);
    });
  });

  describe("Solvency check — all funds accounted for", function () {
    it("should have zero dust after all withdrawals (no claim)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      await pool.connect(participant1).joinPool(0, usdcAmount(100));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await pool.connect(oracle).resolvePool(0, false);

      // Withdraw
      await pool.connect(participant1).withdraw(0);

      // Contract should only hold rounding dust (< 1 wei ideally)
      const contractBalance = await usdc.balanceOf(await pool.getAddress());
      expect(contractBalance).to.be.lte(1); // At most 1 wei rounding
    });

    it("should have zero dust after all withdrawals (claim approved, no excess)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;
      await pool.connect(insured).createPool(
        "Test event",
        "https://example.com/evidence",
        usdcAmount(100),
        500,
        deadline
      );
      // Exactly coverage amount
      await pool.connect(participant1).joinPool(0, usdcAmount(100));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await pool.connect(oracle).resolvePool(0, true);

      await pool.connect(insured).withdraw(0);
      await pool.connect(participant1).withdraw(0);

      const contractBalance = await usdc.balanceOf(await pool.getAddress());
      expect(contractBalance).to.be.lte(1);
    });
  });
});
