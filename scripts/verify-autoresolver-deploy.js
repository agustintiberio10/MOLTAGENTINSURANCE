/**
 * Post-deploy verification for AutoResolver.
 *
 * On hardhat network: deploys mocks + AutoResolver and verifies all reads.
 * On persistent networks: reads from deploy-autoresolver-output.json.
 *
 * Verifies:
 *   1. disputeResolver address matches expected
 *   2. maxStaleness matches expected
 *   3. owner is the deployer
 *   4. registerPolicy + checkAndResolve work end-to-end
 *
 * Usage:
 *   npx hardhat run scripts/verify-autoresolver-deploy.js                         # local
 *   npx hardhat run scripts/verify-autoresolver-deploy.js --network baseSepolia   # testnet
 *   npx hardhat run scripts/verify-autoresolver-deploy.js --network baseMainnet   # mainnet
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "..", "deploy-autoresolver-output.json");

function toChecksumAddress(addr) {
  return hre.ethers.getAddress(addr.toLowerCase());
}

async function deployFreshForVerification() {
  const [deployer] = await hre.ethers.getSigners();

  // Deploy MockDisputeResolver
  const MockDisputeResolver = await hre.ethers.getContractFactory("MockDisputeResolver");
  const mockResolver = await MockDisputeResolver.deploy();
  await mockResolver.waitForDeployment();
  const mockResolverAddr = await mockResolver.getAddress();

  // Deploy MockAggregatorV3 (ETH/USD at $2000)
  const MockAggregator = await hre.ethers.getContractFactory("MockAggregatorV3");
  const ethFeed = await MockAggregator.deploy(2000_00000000n, 8, "ETH/USD");
  await ethFeed.waitForDeployment();
  const ethFeedAddr = await ethFeed.getAddress();

  // Deploy AutoResolver
  const maxStaleness = 3600;
  const AutoResolver = await hre.ethers.getContractFactory("AutoResolver");
  const resolver = await AutoResolver.deploy(mockResolverAddr, maxStaleness);
  await resolver.waitForDeployment();
  const resolverAddr = await resolver.getAddress();

  return {
    contracts: { AutoResolver: resolverAddr },
    config: {
      disputeResolverAddress: mockResolverAddr,
      maxStaleness,
    },
    mocks: { ethFeed: ethFeedAddr, mockResolver: mockResolverAddr },
    deployer: deployer.address,
  };
}

async function main() {
  let output;
  let isLocal = false;

  if (hre.network.name === "hardhat") {
    console.log("[verify] Ephemeral network — deploying fresh for verification...\n");
    output = await deployFreshForVerification();
    isLocal = true;
  } else {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error("deploy-autoresolver-output.json not found. Run deploy-autoresolver.js first.");
      process.exit(1);
    }
    output = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  }

  const resolverAddr = output.contracts.AutoResolver;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║      AUTORESOLVER — ON-CHAIN VERIFICATION               ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`Network: ${hre.network.name}`);
  console.log(`AutoResolver: ${resolverAddr}\n`);

  const resolver = await hre.ethers.getContractAt("AutoResolver", resolverAddr);
  let allPassed = true;

  // ── 1. disputeResolver ──
  const onChainResolver = await resolver.disputeResolver();
  const resolverMatch =
    onChainResolver.toLowerCase() === output.config.disputeResolverAddress.toLowerCase();
  console.log(`[1] disputeResolver()`);
  console.log(`    on-chain:  ${onChainResolver}`);
  console.log(`    expected:  ${output.config.disputeResolverAddress}`);
  console.log(`    match:     ${resolverMatch ? "YES" : "NO"}\n`);
  if (!resolverMatch) allPassed = false;

  // ── 2. maxStaleness ──
  const onChainStaleness = Number(await resolver.maxStaleness());
  const stalenessMatch = onChainStaleness === output.config.maxStaleness;
  console.log(`[2] maxStaleness()`);
  console.log(`    on-chain:  ${onChainStaleness}`);
  console.log(`    expected:  ${output.config.maxStaleness}`);
  console.log(`    match:     ${stalenessMatch ? "YES" : "NO"}\n`);
  if (!stalenessMatch) allPassed = false;

  // ── 3. owner ──
  const [deployer] = await hre.ethers.getSigners();
  const owner = await resolver.owner();
  const ownerMatch = owner.toLowerCase() === (output.deployer || deployer.address).toLowerCase();
  console.log(`[3] owner()`);
  console.log(`    on-chain:  ${owner}`);
  console.log(`    expected:  ${output.deployer || deployer.address}`);
  console.log(`    match:     ${ownerMatch ? "YES" : "NO"}\n`);
  if (!ownerMatch) allPassed = false;

  // ── 4. Registered policy count ──
  const policyCount = Number(await resolver.getRegisteredPoolCount());
  console.log(`[4] getRegisteredPoolCount(): ${policyCount}\n`);

  // ── 5. End-to-end test (local only) ──
  if (isLocal) {
    console.log(`[5] End-to-end test (local): register + check PRICE_BELOW trigger...\n`);

    const ethFeed = await hre.ethers.getContractAt("MockAggregatorV3", output.mocks.ethFeed);
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    const deadline = (await time.latest()) + 86400; // 24h from now

    // Register policy: PRICE_BELOW $1500
    const tx = await resolver.registerPolicy(
      1, // poolId
      0, // PRICE_BELOW
      output.mocks.ethFeed,
      hre.ethers.ZeroAddress,
      1500_00000000n, // $1500 threshold
      0, // no sustained period
      0, // no waiting period
      deadline
    );
    await tx.wait();

    const policy = await resolver.getPolicy(1);
    console.log(`    Policy registered: trigger=PRICE_BELOW, threshold=$1500`);
    console.log(`    startPrice: $${Number(policy.startPrice) / 1e8}`);

    // Set price below threshold
    await ethFeed.setPrice(1400_00000000n);
    console.log(`    Set ETH price to $1400 (below $1500 threshold)`);

    const checkTx = await resolver.checkAndResolve(1);
    const receipt = await checkTx.wait();

    let foundResolution = false;
    for (const log of receipt.logs) {
      try {
        const parsed = resolver.interface.parseLog(log);
        if (parsed?.name === "ResolutionProposed") {
          console.log(`    Resolution: triggered=${parsed.args.triggered}, reason="${parsed.args.reason}"`);
          foundResolution = true;
          if (!parsed.args.triggered) {
            console.log("    ERROR: Expected triggered=true but got false!");
            allPassed = false;
          }
        }
      } catch {}
    }

    if (!foundResolution) {
      console.log("    ERROR: No ResolutionProposed event found!");
      allPassed = false;
    }

    // Verify mock resolver received the call
    const mockResolver = await hre.ethers.getContractAt("MockDisputeResolver", output.mocks.mockResolver);
    const resCount = Number(await mockResolver.getResolutionCount());
    console.log(`    MockDisputeResolver.resolutions: ${resCount}`);
    if (resCount === 1) {
      const [rPoolId, rShouldPay, rReason] = await mockResolver.getResolution(0);
      console.log(`    → poolId=${rPoolId}, shouldPay=${rShouldPay}, reason="${rReason}"`);
    }

    // Verify policy is now resolved
    const policyAfter = await resolver.getPolicy(1);
    console.log(`    Policy resolved: ${policyAfter.resolved}`);
    if (!policyAfter.resolved) allPassed = false;

    console.log();
  }

  // ── Summary ──
  if (allPassed) {
    console.log("ALL CHECKS PASSED — AutoResolver deployment is consistent.");
  } else {
    console.error("SOME CHECKS FAILED — review output above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
