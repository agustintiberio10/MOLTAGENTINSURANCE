const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MPOOLStaking", function () {
  let staking, mpool, usdc;
  let owner, staker1, staker2, feeRouter, anyone;

  const MPOOL_DECIMALS = 18;
  const USDC_DECIMALS = 6;

  function mpoolAmount(n) {
    return ethers.parseUnits(n.toString(), MPOOL_DECIMALS);
  }
  function usdcAmount(n) {
    return ethers.parseUnits(n.toString(), USDC_DECIMALS);
  }

  beforeEach(async function () {
    [owner, staker1, staker2, feeRouter, anyone] = await ethers.getSigners();

    const MockMPOOL = await ethers.getContractFactory("MockMPOOL");
    mpool = await MockMPOOL.deploy();
    await mpool.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const MPOOLStaking = await ethers.getContractFactory("MPOOLStaking");
    staking = await MPOOLStaking.deploy(await mpool.getAddress(), await usdc.getAddress());
    await staking.waitForDeployment();

    // Mint tokens
    await mpool.mint(staker1.address, mpoolAmount(10000));
    await mpool.mint(staker2.address, mpoolAmount(10000));
    await usdc.mint(owner.address, usdcAmount(100000));
    await usdc.mint(feeRouter.address, usdcAmount(100000));

    // Approve staking contract
    const stakingAddr = await staking.getAddress();
    await mpool.connect(staker1).approve(stakingAddr, mpoolAmount(10000));
    await mpool.connect(staker2).approve(stakingAddr, mpoolAmount(10000));
    await usdc.connect(owner).approve(stakingAddr, usdcAmount(100000));
    await usdc.connect(feeRouter).approve(stakingAddr, usdcAmount(100000));

    // Set feeRouter
    await staking.setFeeRouter(feeRouter.address);
  });

  describe("Deployment", function () {
    it("should set correct staking and rewards tokens", async function () {
      expect(await staking.stakingToken()).to.equal(await mpool.getAddress());
      expect(await staking.rewardsToken()).to.equal(await usdc.getAddress());
    });

    it("should set deployer as owner", async function () {
      expect(await staking.owner()).to.equal(owner.address);
    });

    it("should start with zero total staked", async function () {
      expect(await staking.totalStaked()).to.equal(0);
    });
  });

  describe("Staking", function () {
    it("should allow staking MPOOL", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      expect(await staking.stakedBalance(staker1.address)).to.equal(mpoolAmount(1000));
      expect(await staking.totalStaked()).to.equal(mpoolAmount(1000));
    });

    it("should transfer MPOOL to staking contract", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      expect(await mpool.balanceOf(await staking.getAddress())).to.equal(mpoolAmount(1000));
    });

    it("should emit Staked event", async function () {
      await expect(staking.connect(staker1).stake(mpoolAmount(1000)))
        .to.emit(staking, "Staked")
        .withArgs(staker1.address, mpoolAmount(1000));
    });

    it("should revert on stake 0", async function () {
      await expect(staking.connect(staker1).stake(0)).to.be.revertedWith("Cannot stake 0");
    });

    it("should allow multiple stakers", async function () {
      await staking.connect(staker1).stake(mpoolAmount(3000));
      await staking.connect(staker2).stake(mpoolAmount(7000));
      expect(await staking.totalStaked()).to.equal(mpoolAmount(10000));
    });
  });

  describe("Unstaking", function () {
    beforeEach(async function () {
      await staking.connect(staker1).stake(mpoolAmount(5000));
    });

    it("should allow unstaking", async function () {
      await staking.connect(staker1).unstake(mpoolAmount(2000));
      expect(await staking.stakedBalance(staker1.address)).to.equal(mpoolAmount(3000));
      expect(await staking.totalStaked()).to.equal(mpoolAmount(3000));
    });

    it("should return MPOOL to staker", async function () {
      const balBefore = await mpool.balanceOf(staker1.address);
      await staking.connect(staker1).unstake(mpoolAmount(2000));
      const balAfter = await mpool.balanceOf(staker1.address);
      expect(balAfter - balBefore).to.equal(mpoolAmount(2000));
    });

    it("should revert on unstake 0", async function () {
      await expect(staking.connect(staker1).unstake(0)).to.be.revertedWith("Cannot unstake 0");
    });

    it("should revert on insufficient balance", async function () {
      await expect(staking.connect(staker1).unstake(mpoolAmount(6000)))
        .to.be.revertedWith("Insufficient staked balance");
    });
  });

  describe("Reward Distribution", function () {
    it("should distribute rewards to single staker", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));

      const earned = await staking.earned(staker1.address);
      expect(earned).to.equal(usdcAmount(100));
    });

    it("should distribute rewards proportionally to multiple stakers", async function () {
      await staking.connect(staker1).stake(mpoolAmount(3000)); // 30%
      await staking.connect(staker2).stake(mpoolAmount(7000)); // 70%

      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(1000));

      const earned1 = await staking.earned(staker1.address);
      const earned2 = await staking.earned(staker2.address);

      // Allow small rounding (1 unit)
      expect(earned1).to.be.closeTo(usdcAmount(300), 1);
      expect(earned2).to.be.closeTo(usdcAmount(700), 1);
    });

    it("should allow claiming rewards", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(500));

      const balBefore = await usdc.balanceOf(staker1.address);
      await staking.connect(staker1).claimReward();
      const balAfter = await usdc.balanceOf(staker1.address);

      expect(balAfter - balBefore).to.equal(usdcAmount(500));
    });

    it("should emit RewardPaid event on claim", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));

      await expect(staking.connect(staker1).claimReward())
        .to.emit(staking, "RewardPaid")
        .withArgs(staker1.address, usdcAmount(100));
    });

    it("should track totalRewardsDistributed", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(200));

      expect(await staking.totalRewardsDistributed()).to.equal(usdcAmount(300));
    });

    it("should track totalRewardsClaimed", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(500));
      await staking.connect(staker1).claimReward();

      expect(await staking.totalRewardsClaimed()).to.equal(usdcAmount(500));
    });

    it("should revert notifyRewardAmount from unauthorized caller", async function () {
      await expect(staking.connect(anyone).notifyRewardAmount(usdcAmount(100)))
        .to.be.revertedWith("Not authorized");
    });

    it("should revert on zero reward", async function () {
      await expect(staking.connect(feeRouter).notifyRewardAmount(0))
        .to.be.revertedWith("Reward must be > 0");
    });

    it("should allow owner to notify rewards", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(owner).notifyRewardAmount(usdcAmount(100));
      expect(await staking.earned(staker1.address)).to.equal(usdcAmount(100));
    });
  });

  describe("Multiple reward cycles", function () {
    it("should accumulate rewards across multiple distributions", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));

      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(200));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(300));

      expect(await staking.earned(staker1.address)).to.equal(usdcAmount(600));
    });

    it("should handle stake → reward → stake → reward correctly", async function () {
      // Staker1 stakes 1000
      await staking.connect(staker1).stake(mpoolAmount(1000));
      // Distribute 100 USDC → staker1 gets 100
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));

      // Staker2 stakes 1000 (now 50/50)
      await staking.connect(staker2).stake(mpoolAmount(1000));
      // Distribute 100 USDC → each gets 50
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));

      const earned1 = await staking.earned(staker1.address);
      const earned2 = await staking.earned(staker2.address);

      expect(earned1).to.be.closeTo(usdcAmount(150), 1); // 100 + 50
      expect(earned2).to.be.closeTo(usdcAmount(50), 1);   // 0 + 50
    });

    it("should handle claim → more rewards → claim", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));

      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(100));
      await staking.connect(staker1).claimReward();
      expect(await staking.earned(staker1.address)).to.equal(0);

      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(200));
      expect(await staking.earned(staker1.address)).to.equal(usdcAmount(200));

      await staking.connect(staker1).claimReward();
      expect(await staking.totalRewardsClaimed()).to.equal(usdcAmount(300));
    });
  });

  describe("Unstake and claim", function () {
    it("should unstake and claim in one transaction", async function () {
      await staking.connect(staker1).stake(mpoolAmount(5000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(200));

      const mpoolBefore = await mpool.balanceOf(staker1.address);
      const usdcBefore = await usdc.balanceOf(staker1.address);

      await staking.connect(staker1).unstakeAndClaim();

      const mpoolAfter = await mpool.balanceOf(staker1.address);
      const usdcAfter = await usdc.balanceOf(staker1.address);

      expect(mpoolAfter - mpoolBefore).to.equal(mpoolAmount(5000));
      expect(usdcAfter - usdcBefore).to.equal(usdcAmount(200));
      expect(await staking.totalStaked()).to.equal(0);
    });
  });

  describe("View functions", function () {
    it("getStakeInfo should return correct data", async function () {
      await staking.connect(staker1).stake(mpoolAmount(1000));
      await staking.connect(feeRouter).notifyRewardAmount(usdcAmount(50));

      const info = await staking.getStakeInfo(staker1.address);
      expect(info.staked).to.equal(mpoolAmount(1000));
      expect(info.pendingReward).to.equal(usdcAmount(50));
      expect(info.totalStakedGlobal).to.equal(mpoolAmount(1000));
      expect(info.totalDistributed).to.equal(usdcAmount(50));
      expect(info.totalClaimed).to.equal(0);
    });
  });

  describe("Admin", function () {
    it("should allow owner to set fee router", async function () {
      await staking.setFeeRouter(anyone.address);
      expect(await staking.feeRouter()).to.equal(anyone.address);
    });

    it("should not allow non-owner to set fee router", async function () {
      await expect(staking.connect(anyone).setFeeRouter(anyone.address))
        .to.be.revertedWith("Not owner");
    });

    it("should allow ownership transfer", async function () {
      await staking.transferOwnership(staker1.address);
      expect(await staking.owner()).to.equal(staker1.address);
    });
  });
});

describe("FeeRouter", function () {
  let feeRouter, staking, mpool, usdc;
  let owner, treasury, buybackWallet, caller, anyone;

  const USDC_DECIMALS = 6;
  function usdcAmount(n) {
    return ethers.parseUnits(n.toString(), USDC_DECIMALS);
  }
  function mpoolAmount(n) {
    return ethers.parseUnits(n.toString(), 18);
  }

  beforeEach(async function () {
    [owner, treasury, buybackWallet, caller, anyone] = await ethers.getSigners();

    const MockMPOOL = await ethers.getContractFactory("MockMPOOL");
    mpool = await MockMPOOL.deploy();
    await mpool.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy staking first
    const MPOOLStaking = await ethers.getContractFactory("MPOOLStaking");
    staking = await MPOOLStaking.deploy(await mpool.getAddress(), await usdc.getAddress());
    await staking.waitForDeployment();

    // Deploy fee router
    const FeeRouter = await ethers.getContractFactory("FeeRouter");
    feeRouter = await FeeRouter.deploy(
      await usdc.getAddress(),
      await staking.getAddress(),
      treasury.address,
      buybackWallet.address
    );
    await feeRouter.waitForDeployment();

    // Set fee router as reward distributor in staking
    await staking.setFeeRouter(await feeRouter.getAddress());

    // Mint USDC to caller and approve fee router
    await usdc.mint(caller.address, usdcAmount(100000));
    await usdc.connect(caller).approve(await feeRouter.getAddress(), usdcAmount(100000));

    // Stake some MPOOL so rewards have somewhere to go
    await mpool.mint(owner.address, mpoolAmount(10000));
    await mpool.connect(owner).approve(await staking.getAddress(), mpoolAmount(10000));
    await staking.connect(owner).stake(mpoolAmount(10000));
  });

  describe("Deployment", function () {
    it("should set correct fee splits", async function () {
      expect(await feeRouter.STAKING_BPS()).to.equal(7000);
      expect(await feeRouter.TREASURY_BPS()).to.equal(2000);
      expect(await feeRouter.BUYBACK_BPS()).to.equal(1000);
    });

    it("should set correct addresses", async function () {
      expect(await feeRouter.stakingContract()).to.equal(await staking.getAddress());
      expect(await feeRouter.treasury()).to.equal(treasury.address);
      expect(await feeRouter.buybackWallet()).to.equal(buybackWallet.address);
    });
  });

  describe("routeFees", function () {
    it("should split fees 70/20/10", async function () {
      const amount = usdcAmount(1000);
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const buybackBefore = await usdc.balanceOf(buybackWallet.address);

      await feeRouter.connect(caller).routeFees(amount);

      const treasuryAfter = await usdc.balanceOf(treasury.address);
      const buybackAfter = await usdc.balanceOf(buybackWallet.address);

      // 70% = 700 USDC to staking
      expect(await staking.totalRewardsDistributed()).to.equal(usdcAmount(700));
      // 20% = 200 USDC to treasury
      expect(treasuryAfter - treasuryBefore).to.equal(usdcAmount(200));
      // 10% = 100 USDC to buyback
      expect(buybackAfter - buybackBefore).to.equal(usdcAmount(100));
    });

    it("should handle odd amounts without rounding loss", async function () {
      const amount = usdcAmount(333); // 333 USDC
      // 70% = 233.1 → 233 (floor)
      // 20% = 66.6  → 66  (floor)
      // 10% = remainder = 333 - 233 - 66 = 34

      await feeRouter.connect(caller).routeFees(amount);

      const stats = await feeRouter.getStats();
      expect(stats._totalFeesRouted).to.equal(amount);
      // Total distributed should equal input (no dust)
      expect(stats._totalToStaking + stats._totalToTreasury + stats._totalToBuyback).to.equal(amount);
    });

    it("should emit FeesRouted event", async function () {
      await expect(feeRouter.connect(caller).routeFees(usdcAmount(1000)))
        .to.emit(feeRouter, "FeesRouted");
    });

    it("should revert on zero amount", async function () {
      await expect(feeRouter.connect(caller).routeFees(0))
        .to.be.revertedWith("Amount must be > 0");
    });

    it("should update stats across multiple calls", async function () {
      await feeRouter.connect(caller).routeFees(usdcAmount(1000));
      await feeRouter.connect(caller).routeFees(usdcAmount(500));

      const stats = await feeRouter.getStats();
      expect(stats._totalFeesRouted).to.equal(usdcAmount(1500));
    });
  });

  describe("routeBalance", function () {
    it("should route USDC sent directly to contract", async function () {
      // Send USDC directly to fee router
      await usdc.mint(await feeRouter.getAddress(), usdcAmount(1000));

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await feeRouter.connect(anyone).routeBalance();
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(usdcAmount(200));
      expect(await staking.totalRewardsDistributed()).to.equal(usdcAmount(700));
    });

    it("should revert if no balance", async function () {
      await expect(feeRouter.connect(anyone).routeBalance())
        .to.be.revertedWith("No balance to route");
    });
  });

  describe("previewSplit", function () {
    it("should preview correct split", async function () {
      const split = await feeRouter.previewSplit(usdcAmount(10000));
      expect(split.toStaking).to.equal(usdcAmount(7000));
      expect(split.toTreasury).to.equal(usdcAmount(2000));
      expect(split.toBuyback).to.equal(usdcAmount(1000));
    });
  });

  describe("Admin", function () {
    it("should allow owner to recover non-USDC tokens", async function () {
      await mpool.mint(await feeRouter.getAddress(), mpoolAmount(100));
      await feeRouter.recoverToken(await mpool.getAddress(), mpoolAmount(100));
      expect(await mpool.balanceOf(owner.address)).to.be.gte(mpoolAmount(100));
    });

    it("should not allow recovering USDC via recoverToken", async function () {
      await expect(feeRouter.recoverToken(await usdc.getAddress(), usdcAmount(1)))
        .to.be.revertedWith("Use routeBalance for USDC");
    });
  });
});
