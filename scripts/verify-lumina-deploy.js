/**
 * Post-deploy verification — deploys Lumina stack on local Hardhat then reads
 * on-chain state to verify all constructor args and cross-contract links.
 *
 * On persistent networks (baseSepolia, baseMainnet), reads from deploy-lumina-output.json.
 * On ephemeral hardhat network, deploys fresh then verifies.
 *
 * Usage:
 *   npx hardhat run scripts/verify-lumina-deploy.js                    # local (deploy+verify)
 *   npx hardhat run scripts/verify-lumina-deploy.js --network baseSepolia  # read from output.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(__dirname, "..", "deploy-lumina-output.json");

function toChecksumAddress(addr) {
  return hre.ethers.getAddress(addr.toLowerCase());
}

async function deployFresh() {
  const [deployer] = await hre.ethers.getSigners();
  const usdcAddress = toChecksumAddress(process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  const mpoolTokenAddress = toChecksumAddress(process.env.MPOOLV3_TOKEN_ADDRESS || process.env.MPOOL_TOKEN_ADDRESS || "0x0757504597288140731888f94F33156e2070191f");
  const oracleAddress = process.env.ORACLE_ADDRESS ? toChecksumAddress(process.env.ORACLE_ADDRESS) : deployer.address;
  const treasuryWallet = toChecksumAddress(process.env.TREASURY_ADDRESS || process.env.PROTOCOL_OWNER || "0x2b4D825417f568231e809E31B9332ED146760337");
  const buybackWallet = toChecksumAddress(process.env.BUYBACK_ADDRESS || process.env.PROTOCOL_OWNER || "0x2b4D825417f568231e809E31B9332ED146760337");

  const MutualLumina = await hre.ethers.getContractFactory("MutualLumina");
  const lumina = await MutualLumina.deploy(usdcAddress, oracleAddress);
  await lumina.waitForDeployment();

  const MPOOLStaking = await hre.ethers.getContractFactory("MPOOLStaking");
  const staking = await MPOOLStaking.deploy(mpoolTokenAddress, usdcAddress);
  await staking.waitForDeployment();

  const stakingAddress = await staking.getAddress();
  const FeeRouter = await hre.ethers.getContractFactory("FeeRouter");
  const feeRouter = await FeeRouter.deploy(usdcAddress, stakingAddress, treasuryWallet, buybackWallet);
  await feeRouter.waitForDeployment();

  const tx = await staking.setFeeRouter(await feeRouter.getAddress());
  await tx.wait();

  return {
    contracts: {
      MutualLumina: await lumina.getAddress(),
      MPOOLStaking: stakingAddress,
      FeeRouter: await feeRouter.getAddress(),
    },
    config: { usdcAddress, mpoolTokenAddress, oracleAddress, treasuryWallet, buybackWallet },
  };
}

async function main() {
  let output;

  if (hre.network.name === "hardhat") {
    console.log("[verify] Ephemeral network — deploying fresh for verification...\n");
    output = await deployFresh();
  } else {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error("deploy-lumina-output.json not found. Run deploy-lumina.js first.");
      process.exit(1);
    }
    output = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  }

  const { MutualLumina: luminaAddr, MPOOLStaking: stakingAddr, FeeRouter: feeRouterAddr } = output.contracts;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        LUMINA DEPLOY — ON-CHAIN VERIFICATION            ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`Network: ${hre.network.name}\n`);

  // ── MutualLumina.oracle() ──
  const lumina = await hre.ethers.getContractAt("MutualLumina", luminaAddr);
  const oracle = await lumina.oracle();
  console.log(`[MutualLumina] ${luminaAddr}`);
  console.log(`  oracle()     = ${oracle}`);
  console.log(`  expected     = ${output.config.oracleAddress}`);
  console.log(`  match        = ${oracle.toLowerCase() === output.config.oracleAddress.toLowerCase() ? "YES" : "NO"}\n`);

  // ── MutualLumina.usdc() ──
  const luminaUsdc = await lumina.usdc();
  console.log(`  usdc()       = ${luminaUsdc}`);
  console.log(`  expected     = ${output.config.usdcAddress}`);
  console.log(`  match        = ${luminaUsdc.toLowerCase() === output.config.usdcAddress.toLowerCase() ? "YES" : "NO"}\n`);

  // ── MPOOLStaking.feeRouter() ──
  const staking = await hre.ethers.getContractAt("MPOOLStaking", stakingAddr);
  const feeRouter = await staking.feeRouter();
  console.log(`[MPOOLStaking] ${stakingAddr}`);
  console.log(`  feeRouter()  = ${feeRouter}`);
  console.log(`  expected     = ${feeRouterAddr}`);
  console.log(`  match        = ${feeRouter.toLowerCase() === feeRouterAddr.toLowerCase() ? "YES" : "NO"}\n`);

  // ── MPOOLStaking.stakingToken() ──
  const stakingToken = await staking.stakingToken();
  console.log(`  stakingToken() = ${stakingToken}`);
  console.log(`  expected       = ${output.config.mpoolTokenAddress}`);
  console.log(`  match          = ${stakingToken.toLowerCase() === output.config.mpoolTokenAddress.toLowerCase() ? "YES" : "NO"}\n`);

  // ── FeeRouter addresses ──
  const router = await hre.ethers.getContractAt("FeeRouter", feeRouterAddr);
  const rUsdc = await router.usdc();
  const rStaking = await router.stakingContract();
  const rTreasury = await router.treasury();
  const rBuyback = await router.buybackWallet();
  console.log(`[FeeRouter] ${feeRouterAddr}`);
  console.log(`  usdc()            = ${rUsdc}`);
  console.log(`  stakingContract() = ${rStaking}  (expected: ${stakingAddr})`);
  console.log(`  treasury()        = ${rTreasury}  (expected: ${output.config.treasuryWallet})`);
  console.log(`  buyback()         = ${rBuyback}  (expected: ${output.config.buybackWallet})`);

  const allMatch =
    rUsdc.toLowerCase() === output.config.usdcAddress.toLowerCase() &&
    rStaking.toLowerCase() === stakingAddr.toLowerCase() &&
    rTreasury.toLowerCase() === output.config.treasuryWallet.toLowerCase() &&
    rBuyback.toLowerCase() === output.config.buybackWallet.toLowerCase();
  console.log(`  all match         = ${allMatch ? "YES" : "NO"}\n`);

  // ── Summary ──
  const oracleOk = oracle.toLowerCase() === output.config.oracleAddress.toLowerCase();
  const feeRouterOk = feeRouter.toLowerCase() === feeRouterAddr.toLowerCase();

  if (oracleOk && feeRouterOk && allMatch) {
    console.log("ALL CHECKS PASSED — deployment is consistent.");
  } else {
    console.error("SOME CHECKS FAILED — review output above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
