/**
 * Deploy AutoResolver — Parametric insurance resolution via Chainlink price feeds.
 *
 * Deploys AutoResolver and links it to the existing MutualLumina instance
 * (acting as the DisputeResolver). On-chain, AutoResolver reads Chainlink feeds
 * and calls MutualLumina.resolvePool() through the IDisputeResolver interface.
 *
 * Prerequisites:
 *   - MutualLumina must already be deployed (address in state.json or env)
 *   - The deployer wallet must be the owner of AutoResolver
 *
 * Usage:
 *   npx hardhat run scripts/deploy-autoresolver.js --network baseMainnet
 *   npx hardhat run scripts/deploy-autoresolver.js --network baseSepolia
 *   npx hardhat run scripts/deploy-autoresolver.js                          # hardhat local
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "state.json");
const OUTPUT_PATH = path.join(__dirname, "..", "deploy-autoresolver-output.json");

function toChecksumAddress(addr) {
  return hre.ethers.getAddress(addr.toLowerCase());
}

// ── Chainlink Price Feed addresses on Base Mainnet ──
const CHAINLINK_FEEDS_BASE = {
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "BTC/USD": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  "USDC/USD": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  "DAI/USD": "0x591e79239a7d679378eC8c847e5038150364C78F",
  "USDT/USD": "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
};

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     AUTORESOLVER — PARAMETRIC RESOLUTION DEPLOYMENT     ║");
  console.log("║     Chainlink-powered on-chain insurance resolution     ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  // ── Resolve DisputeResolver address ──
  // AutoResolver calls disputeResolver.proposeResolution(poolId, shouldPay, reason)
  // In production, this is MutualLumina itself (which implements resolvePool).
  // For testing, it can be a MockDisputeResolver.
  const disputeResolverAddress = toChecksumAddress(
    process.env.DISPUTE_RESOLVER_ADDRESS ||
      process.env.LUMINA_CONTRACT_ADDRESS ||
      (fs.existsSync(STATE_PATH)
        ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")).lumina?.contractAddress
        : null) ||
      "0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7"
  );

  // ── Max staleness for Chainlink feeds ──
  // 3600 = 1 hour (Chainlink heartbeat on Base is typically ~1h for major pairs)
  const maxStaleness = parseInt(process.env.AUTORESOLVER_MAX_STALENESS || "3600", 10);

  console.log(`Network:           ${hre.network.name}`);
  console.log(`Deployer:          ${deployer.address}`);
  console.log(`Balance:           ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`DisputeResolver:   ${disputeResolverAddress}`);
  console.log(`Max Staleness:     ${maxStaleness}s (${maxStaleness / 3600}h)`);
  console.log();

  // ── 1. Deploy AutoResolver ──
  console.log("[1/1] Deploying AutoResolver...");
  const AutoResolver = await hre.ethers.getContractFactory("AutoResolver");
  const resolver = await AutoResolver.deploy(disputeResolverAddress, maxStaleness);
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  console.log(`  AutoResolver: ${resolverAddress}`);

  // Wait for nonce propagation on RPC node
  await new Promise((r) => setTimeout(r, 5000));

  // ── Verify deployment reads ──
  const onChainResolver = await resolver.disputeResolver();
  const onChainStaleness = await resolver.maxStaleness();
  console.log(`\n  on-chain disputeResolver = ${onChainResolver}`);
  console.log(`  on-chain maxStaleness    = ${onChainStaleness}`);
  console.log(`  owner                    = ${await resolver.owner()}`);

  // ── Save deploy-autoresolver-output.json ──
  const output = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      AutoResolver: resolverAddress,
    },
    constructorArgs: {
      AutoResolver: [disputeResolverAddress, maxStaleness],
    },
    config: {
      disputeResolverAddress,
      maxStaleness,
    },
    chainlinkFeeds: CHAINLINK_FEEDS_BASE,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved: deploy-autoresolver-output.json`);

  // ── Update .env ──
  const ENV_PATH = path.join(__dirname, "..", ".env");
  if (fs.existsSync(ENV_PATH)) {
    let envContent = fs.readFileSync(ENV_PATH, "utf8");
    const envVars = {
      AUTORESOLVER_ADDRESS: resolverAddress,
    };

    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }
    if (!envContent.endsWith("\n")) envContent += "\n";
    fs.writeFileSync(ENV_PATH, envContent);
    console.log(".env updated with AUTORESOLVER_ADDRESS.");
  }

  // ── Update state.json ──
  if (fs.existsSync(STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.autoResolver = {
      contractAddress: resolverAddress,
      disputeResolver: disputeResolverAddress,
      maxStaleness,
      deployedAt: new Date().toISOString(),
      network: hre.network.name,
      chainlinkFeeds: CHAINLINK_FEEDS_BASE,
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log("state.json updated with autoResolver config.");
  }

  // ── Summary ──
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║       AUTORESOLVER — DEPLOYMENT COMPLETE                ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  AutoResolver:     ${resolverAddress}  ║`);
  console.log(`║  DisputeResolver:  ${disputeResolverAddress}  ║`);
  console.log(`║  Max Staleness:    ${String(maxStaleness).padEnd(38)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  CHAINLINK FEEDS (Base Mainnet):                       ║");
  for (const [pair, addr] of Object.entries(CHAINLINK_FEEDS_BASE)) {
    console.log(`║  ${pair.padEnd(10)} ${addr}  ║`);
  }
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  TRIGGER TYPES:                                        ║");
  console.log("║  0 = PRICE_BELOW      (price < threshold)              ║");
  console.log("║  1 = PRICE_ABOVE      (price > threshold)              ║");
  console.log("║  2 = PRICE_DROP_PCT   (drop% > threshold bps)          ║");
  console.log("║  3 = PRICE_RISE_PCT   (rise% > threshold bps)          ║");
  console.log("║  4 = PRICE_DIVERGENCE (diff% between feeds > bps)      ║");
  console.log("║  5 = GAS_ABOVE        (L2 gas > threshold wei)         ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  NEXT STEPS:                                           ║");
  console.log("║  1. Verify on BaseScan                                 ║");
  console.log("║  2. Register policies with registerPolicy()            ║");
  console.log("║  3. Set AUTORESOLVER_ADDRESS in Railway env             ║");
  console.log("║  4. Oracle bot will auto-detect and use it              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
