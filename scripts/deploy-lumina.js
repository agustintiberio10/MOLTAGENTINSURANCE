/**
 * Deploy MutualLumina + MPOOLStaking + FeeRouter
 *
 * Deploys the full Lumina production stack:
 * 1. MutualLumina  (insurance vault, no router needed)
 * 2. MPOOLStaking   (stake MPOOL, earn USDC)
 * 3. FeeRouter      (splits fees 70% staking / 20% treasury / 10% buyback)
 * 4. Links FeeRouter as reward distributor in MPOOLStaking
 *
 * Usage:
 *   npx hardhat run scripts/deploy-lumina.js --network baseMainnet
 *   npx hardhat run scripts/deploy-lumina.js --network baseSepolia
 *   npx hardhat run scripts/deploy-lumina.js                          # hardhat local
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const STATE_PATH = path.join(__dirname, "..", "state.json");
const OUTPUT_PATH = path.join(__dirname, "..", "deploy-lumina-output.json");

function toChecksumAddress(addr) {
  return hre.ethers.getAddress(addr.toLowerCase());
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     MUTUALlumina — FULL STACK DEPLOYMENT                ║");
  console.log("║     MutualLumina + MPOOLStaking + FeeRouter             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── Resolve addresses ──
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  const usdcAddress = toChecksumAddress(
    process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  );
  const mpoolTokenAddress = toChecksumAddress(
    process.env.MPOOLV3_TOKEN_ADDRESS ||
      process.env.MPOOL_TOKEN_ADDRESS ||
      "0x0757504597288140731888f94F33156e2070191f"
  );
  const oracleAddress = process.env.ORACLE_ADDRESS
    ? toChecksumAddress(process.env.ORACLE_ADDRESS)
    : deployer.address;
  const treasuryWallet = toChecksumAddress(
    process.env.TREASURY_ADDRESS ||
      process.env.PROTOCOL_OWNER ||
      "0x2b4D825417f568231e809E31B9332ED146760337"
  );
  const buybackWallet = toChecksumAddress(
    process.env.BUYBACK_ADDRESS ||
      process.env.PROTOCOL_OWNER ||
      "0x2b4D825417f568231e809E31B9332ED146760337"
  );

  console.log(`Network:     ${hre.network.name}`);
  console.log(`Deployer:    ${deployer.address}`);
  console.log(`Balance:     ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`USDC:        ${usdcAddress}`);
  console.log(`MPOOL Token: ${mpoolTokenAddress}`);
  console.log(`Oracle:      ${oracleAddress}`);
  console.log(`Treasury:    ${treasuryWallet}`);
  console.log(`Buyback:     ${buybackWallet}\n`);

  // ── 1. Deploy MutualLumina ──
  console.log("[1/4] Deploying MutualLumina...");
  const MutualLumina = await hre.ethers.getContractFactory("MutualLumina");
  const lumina = await MutualLumina.deploy(usdcAddress, oracleAddress);
  await lumina.waitForDeployment();
  const luminaAddress = await lumina.getAddress();
  console.log(`  MutualLumina: ${luminaAddress}`);
  // Wait for nonce propagation on RPC node
  await new Promise((r) => setTimeout(r, 5000));

  // ── 2. Deploy MPOOLStaking ──
  console.log("\n[2/4] Deploying MPOOLStaking...");
  const MPOOLStaking = await hre.ethers.getContractFactory("MPOOLStaking");
  const staking = await MPOOLStaking.deploy(mpoolTokenAddress, usdcAddress);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(`  MPOOLStaking: ${stakingAddress}`);
  // Wait for nonce propagation on RPC node
  await new Promise((r) => setTimeout(r, 5000));

  // ── 3. Deploy FeeRouter ──
  console.log("\n[3/4] Deploying FeeRouter...");
  const FeeRouter = await hre.ethers.getContractFactory("FeeRouter");
  const feeRouter = await FeeRouter.deploy(
    usdcAddress,
    stakingAddress,
    treasuryWallet,
    buybackWallet
  );
  await feeRouter.waitForDeployment();
  const feeRouterAddress = await feeRouter.getAddress();
  console.log(`  FeeRouter:    ${feeRouterAddress}`);
  // Wait for nonce propagation on RPC node
  await new Promise((r) => setTimeout(r, 5000));

  // ── 4. Link FeeRouter → MPOOLStaking ──
  console.log("\n[4/4] Linking FeeRouter to MPOOLStaking...");
  const tx = await staking.setFeeRouter(feeRouterAddress);
  await tx.wait();
  console.log(`  MPOOLStaking.feeRouter = ${feeRouterAddress}`);

  // ── Save deploy-lumina-output.json ──
  const output = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MutualLumina: luminaAddress,
      MPOOLStaking: stakingAddress,
      FeeRouter: feeRouterAddress,
    },
    constructorArgs: {
      MutualLumina: [usdcAddress, oracleAddress],
      MPOOLStaking: [mpoolTokenAddress, usdcAddress],
      FeeRouter: [usdcAddress, stakingAddress, treasuryWallet, buybackWallet],
    },
    config: {
      usdcAddress,
      mpoolTokenAddress,
      oracleAddress,
      treasuryWallet,
      buybackWallet,
    },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved: deploy-lumina-output.json`);

  // ── Update .env ──
  if (fs.existsSync(ENV_PATH)) {
    let envContent = fs.readFileSync(ENV_PATH, "utf8");
    const envVars = {
      LUMINA_CONTRACT_ADDRESS: luminaAddress,
      LUMINA_STAKING_ADDRESS: stakingAddress,
      LUMINA_FEE_ROUTER_ADDRESS: feeRouterAddress,
    };

    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }
    // Ensure file ends with newline
    if (!envContent.endsWith("\n")) envContent += "\n";
    fs.writeFileSync(ENV_PATH, envContent);
    console.log(".env updated.");
  }

  // ── Update state.json ──
  if (fs.existsSync(STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.lumina = {
      contractAddress: luminaAddress,
      stakingAddress,
      feeRouterAddress,
      oracle: oracleAddress,
      treasury: treasuryWallet,
      buyback: buybackWallet,
      deployedAt: new Date().toISOString(),
      network: hre.network.name,
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log("state.json updated.");
  }

  // ── Summary ──
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║            LUMINA STACK — DEPLOYMENT COMPLETE            ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  MutualLumina:  ${luminaAddress}  ║`);
  console.log(`║  MPOOLStaking:  ${stakingAddress}  ║`);
  console.log(`║  FeeRouter:     ${feeRouterAddress}  ║`);
  console.log(`║  Oracle:        ${oracleAddress}  ║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Fee Split: 70% stakers / 20% treasury / 10% buyback   ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  NEXT STEPS:                                            ║");
  console.log("║  1. Verify contracts on BaseScan                        ║");
  console.log("║  2. Update frontend contracts.js with Lumina address    ║");
  console.log("║  3. Update oracle-bot.js to use Lumina methods          ║");
  console.log("║  4. Set LUMINA_CONTRACT_ADDRESS in Railway env          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
