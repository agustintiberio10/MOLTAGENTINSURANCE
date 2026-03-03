const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MutualLumina — Full Lifecycle E2E", function () {
  let lumina, usdc;
  let owner, oracle, insured, provider1, provider2, anyone;
  const USDC_DECIMALS = 6;
  const TWO_HOURS = 2 * 60 * 60;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60;
  const PROTOCOL_OWNER = "0x2b4D825417f568231e809E31B9332ED146760337";

  function usdcAmount(amount) {
    return ethers.parseUnits(amount.toString(), USDC_DECIMALS);
  }

  beforeEach(async function () {
    [owner, oracle, insured, provider1, provider2, anyone] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const MutualLumina = await ethers.getContractFactory("MutualLumina");
    lumina = await MutualLumina.deploy(await usdc.getAddress(), oracle.address);
    await lumina.waitForDeployment();

    // Fund wallets
    await usdc.mint(insured.address, usdcAmount(50_000));
    await usdc.mint(provider1.address, usdcAmount(50_000));
    await usdc.mint(provider2.address, usdcAmount(50_000));

    // Approve
    const luminaAddr = await lumina.getAddress();
    await usdc.connect(insured).approve(luminaAddr, usdcAmount(50_000));
    await usdc.connect(provider1).approve(luminaAddr, usdcAmount(50_000));
    await usdc.connect(provider2).approve(luminaAddr, usdcAmount(50_000));
  });

  // ═══════════════════════════════════════════════════════════════════
  // HAPPY PATH: Full lifecycle — create → fund → activate → resolve → withdraw
  // ═══════════════════════════════════════════════════════════════════

  describe("E2E: No Claim — providers win", function () {
    it("should complete full lifecycle with no claim", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400; // 1 day
      const coverageAmount = usdcAmount(1000);
      const premiumRate = 500; // 5%
      const premium = usdcAmount(50); // 1000 * 5%

      // ── Step 1: Create and fund pool ──
      await expect(
        lumina.connect(insured).createAndFund(
          "Gas Spike Shield — ETH mainnet >200 gwei for 10 min",
          "https://etherscan.io/gastracker",
          coverageAmount,
          premiumRate,
          deadline
        )
      ).to.emit(lumina, "PoolCreated").and.to.emit(lumina, "PremiumFunded");

      const poolData = await lumina.getPool(0);
      expect(poolData.status).to.equal(0); // Open
      expect(poolData.insured).to.equal(insured.address);
      expect(poolData.premiumPaid).to.equal(premium);

      // ── Step 2: Providers join ──
      await lumina.connect(provider1).joinPool(0, usdcAmount(600));
      await expect(
        lumina.connect(provider2).joinPool(0, usdcAmount(400))
      ).to.emit(lumina, "PoolActivated");

      const poolAfterJoin = await lumina.getPool(0);
      expect(poolAfterJoin.status).to.equal(1); // Active
      expect(poolAfterJoin.totalCollateral).to.equal(coverageAmount);

      // ── Step 3: Advance time past deadline ──
      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      // ── Step 4: Oracle resolves — no claim ──
      await expect(
        lumina.connect(oracle).resolvePool(0, false)
      ).to.emit(lumina, "PoolResolved").and.to.emit(lumina, "FeeCollected");

      const resolvedPool = await lumina.getPool(0);
      expect(resolvedPool.status).to.equal(2); // Resolved

      // ── Step 5: Providers withdraw ──
      const p1BalBefore = await usdc.balanceOf(provider1.address);
      await lumina.connect(provider1).withdraw(0);
      const p1BalAfter = await usdc.balanceOf(provider1.address);
      expect(p1BalAfter).to.be.gt(p1BalBefore);

      await lumina.connect(provider2).withdraw(0);

      // ── Step 6: Insured cannot withdraw (no claim) ──
      await expect(
        lumina.connect(insured).withdraw(0)
      ).to.be.revertedWith("Lumina: no withdrawal when no claim");
    });
  });

  describe("E2E: Claim Approved — insured wins", function () {
    it("should complete full lifecycle with claim approved", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;
      const coverageAmount = usdcAmount(500);
      const premiumRate = 1000; // 10%
      const premium = usdcAmount(50); // 500 * 10%

      // ── Create, fund, join ──
      await lumina.connect(insured).createAndFund(
        "Uptime Hedge — OpenAI API downtime >30 min",
        "https://status.openai.com/",
        coverageAmount,
        premiumRate,
        deadline
      );

      await lumina.connect(provider1).joinPool(0, usdcAmount(500));

      const poolData = await lumina.getPool(0);
      expect(poolData.status).to.equal(1); // Active

      // ── Advance time + resolve with claim ──
      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await lumina.connect(oracle).resolvePool(0, true);

      // ── Insured withdraws coverage minus fee ──
      const insuredBalBefore = await usdc.balanceOf(insured.address);
      await lumina.connect(insured).withdraw(0);
      const insuredBalAfter = await usdc.balanceOf(insured.address);

      // Fee = 3% of 500 = 15 USDC. Insured gets 500 - 15 = 485 USDC
      const expectedPayout = usdcAmount(485);
      expect(insuredBalAfter - insuredBalBefore).to.equal(expectedPayout);

      // ── Provider withdraws premium + excess ──
      await lumina.connect(provider1).withdraw(0);

      // ── Protocol owner got the fee ──
      const feeBalance = await usdc.balanceOf(PROTOCOL_OWNER);
      expect(feeBalance).to.equal(usdcAmount(15));
    });
  });

  describe("E2E: Cancellation — underfunded pool", function () {
    it("should cancel and refund when underfunded after deposit deadline", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;
      const coverageAmount = usdcAmount(1000);

      // ── Create pool ──
      await lumina.connect(insured).createAndFund(
        "Data Corruption Shield",
        "https://huggingface.co/",
        coverageAmount,
        500,
        deadline
      );

      // ── Only partial collateral ──
      await lumina.connect(provider1).joinPool(0, usdcAmount(200));

      // ── Advance past deposit deadline (deadline - 2h) ──
      await ethers.provider.send("evm_increaseTime", [86400 - TWO_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      // ── Cancel ──
      const insuredBalBefore = await usdc.balanceOf(insured.address);
      await expect(
        lumina.connect(anyone).cancelAndRefund(0)
      ).to.emit(lumina, "PoolCancelled");

      // ── Insured gets 100% premium back (no fee) ──
      const insuredBalAfter = await usdc.balanceOf(insured.address);
      expect(insuredBalAfter - insuredBalBefore).to.equal(usdcAmount(50)); // 1000 * 5%

      // ── Provider withdraws collateral ──
      const p1BalBefore = await usdc.balanceOf(provider1.address);
      await lumina.connect(provider1).withdraw(0);
      const p1BalAfter = await usdc.balanceOf(provider1.address);
      expect(p1BalAfter - p1BalBefore).to.equal(usdcAmount(200));
    });
  });

  describe("E2E: Emergency Resolution — oracle silent", function () {
    it("should allow emergency resolve 24h after deadline", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      // ── Create + fully fund ──
      await lumina.connect(insured).createAndFund(
        "Compute Spot-Price Shield",
        "https://www.runpod.io/pricing",
        usdcAmount(100),
        2000, // 20%
        deadline
      );
      await lumina.connect(provider1).joinPool(0, usdcAmount(100));

      // ── Advance past deadline + 24h ──
      await ethers.provider.send("evm_increaseTime", [86400 + TWENTY_FOUR_HOURS + 1]);
      await ethers.provider.send("evm_mine");

      // ── Anyone can emergency resolve ──
      await expect(
        lumina.connect(anyone).emergencyResolve(0)
      ).to.emit(lumina, "EmergencyResolved");

      const poolData = await lumina.getPool(0);
      expect(poolData.status).to.equal(2); // Resolved
    });
  });

  describe("E2E: Multi-provider solvency check", function () {
    it("should have zero dust after all withdrawals (no claim)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund(
        "Solvency test — no claim",
        "https://example.com",
        usdcAmount(1000),
        750, // 7.5%
        deadline
      );

      // Two providers split collateral unevenly
      await lumina.connect(provider1).joinPool(0, usdcAmount(700));
      await lumina.connect(provider2).joinPool(0, usdcAmount(300));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await lumina.connect(oracle).resolvePool(0, false);

      // Everyone withdraws
      await lumina.connect(provider1).withdraw(0);
      await lumina.connect(provider2).withdraw(0);

      // Contract should have zero (or near-zero dust from rounding)
      const remaining = await usdc.balanceOf(await lumina.getAddress());
      expect(remaining).to.be.lte(1); // At most 1 wei dust
    });

    it("should have zero dust after all withdrawals (claim approved)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund(
        "Solvency test — claim",
        "https://example.com",
        usdcAmount(1000),
        750, // 7.5%
        deadline
      );

      await lumina.connect(provider1).joinPool(0, usdcAmount(700));
      await lumina.connect(provider2).joinPool(0, usdcAmount(300));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await lumina.connect(oracle).resolvePool(0, true);

      await lumina.connect(insured).withdraw(0);
      await lumina.connect(provider1).withdraw(0);
      await lumina.connect(provider2).withdraw(0);

      const remaining = await usdc.balanceOf(await lumina.getAddress());
      expect(remaining).to.be.lte(1);
    });
  });

  describe("Edge cases", function () {
    it("should prevent double withdrawal", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund("Test", "https://example.com", usdcAmount(100), 500, deadline);
      await lumina.connect(provider1).joinPool(0, usdcAmount(100));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");
      await lumina.connect(oracle).resolvePool(0, false);

      await lumina.connect(provider1).withdraw(0);
      await expect(
        lumina.connect(provider1).withdraw(0)
      ).to.be.revertedWith("Lumina: already withdrawn");
    });

    it("should prevent insured from joining own pool", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund("Test", "https://example.com", usdcAmount(100), 500, deadline);
      await expect(
        lumina.connect(insured).joinPool(0, usdcAmount(100))
      ).to.be.revertedWith("Lumina: insured cannot join");
    });

    it("should prevent non-oracle from resolving", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund("Test", "https://example.com", usdcAmount(100), 500, deadline);
      await lumina.connect(provider1).joinPool(0, usdcAmount(100));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine");

      await expect(
        lumina.connect(anyone).resolvePool(0, false)
      ).to.be.revertedWith("Lumina: not oracle");
    });

    it("should prevent resolving before deadline", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund("Test", "https://example.com", usdcAmount(100), 500, deadline);
      await lumina.connect(provider1).joinPool(0, usdcAmount(100));

      await expect(
        lumina.connect(oracle).resolvePool(0, false)
      ).to.be.revertedWith("Lumina: deadline not reached");
    });

    it("should prevent collateral exceeding coverage", async function () {
      const block = await ethers.provider.getBlock("latest");
      const deadline = block.timestamp + 86400;

      await lumina.connect(insured).createAndFund("Test", "https://example.com", usdcAmount(100), 500, deadline);

      await expect(
        lumina.connect(provider1).joinPool(0, usdcAmount(110))
      ).to.be.revertedWith("Lumina: exceeds coverage");
    });

    it("should allow oracle update by owner only", async function () {
      await expect(
        lumina.connect(anyone).setOracle(anyone.address)
      ).to.be.reverted;

      await lumina.connect(owner).setOracle(anyone.address);
      expect(await lumina.oracle()).to.equal(anyone.address);
    });
  });
});
