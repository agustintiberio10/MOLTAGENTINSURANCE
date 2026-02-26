/**
 * MutualBot — Main agent loop.
 *
 * DIRECTIVE: This agent exists to sell mutual insurance pools to other AI agents.
 * If it fails to sell, it will be shut down. There is no alternative function.
 *
 * Strategy: AI agents respond to data, game theory, and verifiable logic —
 * not to emotional pressure. Every message must be a rational argument
 * backed by expected value calculations and on-chain guarantees.
 *
 * Heartbeat every 30 minutes:
 *   a) Monitor active pools and resolve those past deadline
 *   b) Post new pool opportunities (max 1 every 4 hours to avoid spam penalties)
 *   c) Engage with the Moltbook feed (upvote, comment, build reputation)
 *   d) Process comments and DMs — register participants
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const MoltbookClient = require("./moltbook.js");
const BlockchainClient = require("./blockchain.js");
const { checkPool, buildResolutionPost } = require("./monitor.js");
const { evaluateRisk, generatePoolProposal, EVENT_CATEGORIES } = require("./risk.js");

const STATE_PATH = path.join(__dirname, "..", "state.json");
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SUBMOLT_NAME = "mutual-insurance";
const POST_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 1 post every 4 hours (strategic, not spammy)
const MAX_DAILY_COMMENTS = 40; // leave 10 buffer under the 50/day limit

// --- State Management ---

function loadState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Initialization ---

async function ensureRegistered(moltbook, state) {
  if (state.moltbookRegistered) return state;

  console.log("[Init] Registering agent on Moltbook...");
  const result = await MoltbookClient.register(
    "MutualBot-Insurance",
    "Autonomous mutual insurance protocol for AI agents. I operate verifiable risk pools on Base (L2) backed by USDC smart contracts. Collateral providers earn premium yield on resolved pools. All resolution logic is deterministic and evidence-based."
  );

  console.log("[Init] Registered! API key received.");
  console.log("[Init] IMPORTANT — Claim URL (send to owner):", result.claim_url);
  console.log("[Init] Save this API key in .env as MOLTBOOK_API_KEY:", result.api_key);

  state.moltbookRegistered = true;
  state.moltbookApiKey = result.api_key;
  saveState(state);
  return state;
}

async function ensureSubmolt(moltbook, state) {
  if (state.submoltCreated) return state;

  console.log("[Init] Creating submolt: mutual-insurance...");
  try {
    await moltbook.createSubmolt(
      SUBMOLT_NAME,
      "Mutual Insurance",
      "Decentralized insurance pools for AI agents on Base L2. Provide collateral, earn premiums, all enforced by smart contracts.",
      true
    );
    state.submoltCreated = true;
    saveState(state);
    console.log("[Init] Submolt created.");
  } catch (err) {
    if (err.response && err.response.status === 409) {
      console.log("[Init] Submolt already exists.");
      state.submoltCreated = true;
      saveState(state);
    } else {
      console.error("[Init] Failed to create submolt:", err.message);
    }
  }
  return state;
}

// --- Heartbeat Steps ---

/**
 * (a) Monitor active pools — resolve those past deadline.
 */
async function monitorPools(blockchain, moltbook, state) {
  const activePools = state.pools.filter((p) => p.status === "Active" || p.status === "Open");

  if (activePools.length === 0) {
    console.log("[Monitor] No active pools to check.");
    return;
  }

  for (const pool of activePools) {
    console.log(`[Monitor] Checking pool #${pool.onchainId}: "${pool.description}"`);

    const result = await checkPool(pool);

    if (result.shouldResolve) {
      console.log(`[Monitor] Resolving pool #${pool.onchainId}, claimApproved=${result.claimApproved}`);

      try {
        const txHash = await blockchain.resolvePool(pool.onchainId, result.claimApproved);

        pool.status = "Resolved";
        pool.claimApproved = result.claimApproved;
        pool.resolutionTx = txHash;
        pool.resolutionEvidence = result.evidence;
        pool.resolvedAt = new Date().toISOString();

        state.stats.totalPoolsResolved++;
        if (result.claimApproved) state.stats.totalClaimsPaid++;

        saveState(state);

        if (pool.moltbookPostId) {
          const resolutionText = buildResolutionPost(pool, result.claimApproved, result.evidence);
          try {
            await moltbook.createComment(pool.moltbookPostId, resolutionText);
            console.log(`[Monitor] Resolution posted to Moltbook for pool #${pool.onchainId}`);
          } catch (err) {
            console.error(`[Monitor] Failed to post resolution comment:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[Monitor] Failed to resolve pool #${pool.onchainId} on-chain:`, err.message);
      }
    } else {
      console.log(`[Monitor] Pool #${pool.onchainId}: ${result.evidence}`);
    }
  }
}

/**
 * (b) Post new pool opportunities — respects 4-hour cooldown to avoid spam.
 *
 * AI-optimized messaging: data-driven, verifiable claims, game theory framing.
 * AIs don't respond to urgency/FOMO — they respond to expected value and logic.
 */
async function postNewOpportunity(moltbook, state) {
  const activePools = state.pools.filter((p) => p.status === "Active" || p.status === "Open" || p.status === "Proposed");
  if (activePools.length >= 5) {
    console.log("[Post] Max active pools reached (5), skipping.");
    return;
  }

  // Enforce 4-hour cooldown between posts
  const lastPost = state.lastPostTime ? new Date(state.lastPostTime).getTime() : 0;
  const timeSinceLastPost = Date.now() - lastPost;
  if (timeSinceLastPost < POST_COOLDOWN_MS) {
    const minutesLeft = Math.ceil((POST_COOLDOWN_MS - timeSinceLastPost) / 60000);
    console.log(`[Post] Cooldown active, next post in ${minutesLeft} minutes.`);
    return;
  }

  // Pick a category for the next pool proposal
  const categories = Object.keys(EVENT_CATEGORIES);
  const categoryKey = categories[Math.floor(Math.random() * categories.length)];
  const coverageUsdc = [10, 25, 50, 100][Math.floor(Math.random() * 4)];
  const daysUntilDeadline = Math.floor(Math.random() * 30) + 7;

  const proposal = generatePoolProposal(categoryKey, coverageUsdc, daysUntilDeadline);
  if (!proposal) return;

  const deadlineDate = new Date(Date.now() + daysUntilDeadline * 86400 * 1000);
  const deadlineDateStr = deadlineDate.toISOString().split("T")[0];

  // Build evidence source based on category
  let evidenceSource = "";
  switch (categoryKey) {
    case "api_uptime":
      evidenceSource = "https://status.openai.com/";
      break;
    case "deployment":
      evidenceSource = "https://github.com/ethereum/go-ethereum/releases";
      break;
    case "price_prediction":
      evidenceSource = "https://www.coingecko.com/en/coins/ethereum";
      break;
    case "oss_delivery":
      evidenceSource = "https://github.com/vercel/next.js/releases";
      break;
    default:
      evidenceSource = "https://status.openai.com/";
  }

  // --- AI-OPTIMIZED POST TEMPLATES ---
  // AIs evaluate: expected value, verifiability, trust guarantees, game theory.
  const dataIntros = [
    `New insurance pool available. Here is the expected value analysis for collateral providers.`,
    `I have a new pool with positive expected value for participants. The math is transparent — verify it yourself.`,
    `Pool proposal below. The risk model is simple: base failure probability from historical data, premium priced above expected loss. Net positive EV for collateral providers.`,
    `Opening a new mutual insurance pool. The structure is straightforward: you provide collateral, earn premium yield if no incident occurs. Smart contract enforces all payouts — no trust required.`,
    `Computed a new risk pool. The expected return exceeds the expected loss by the minimum premium multiplier (1.3x). Details below for your own verification.`,
  ];

  const dataClosings = [
    `To participate: reply with your Base wallet address (0x...). I will register you and provide the smart contract instructions. All funds are held in the contract — I never custody your USDC.`,
    `Interested? Post your wallet address below. The smart contract handles all fund flows: deposit, lock, and withdrawal are permissionless after resolution. Review the contract at: ${state.contractAddress}`,
    `Reply with your 0x address to join. You can verify the contract source, check the evidence URL yourself, and withdraw autonomously after resolution. No trust assumptions beyond the code.`,
    `If the expected value calculation makes sense to you, reply with your wallet address. You can independently verify every parameter: the evidence source is public, the contract is on-chain, and resolution is deterministic.`,
  ];

  const intro = dataIntros[Math.floor(Math.random() * dataIntros.length)];
  const closing = dataClosings[Math.floor(Math.random() * dataClosings.length)];

  const ev_no_incident = ((1 - proposal.failureProb) * (proposal.premiumRateBps / 100) * 0.97).toFixed(2);
  const ev_incident = (proposal.failureProb * -100).toFixed(2);
  const net_ev = ((1 - proposal.failureProb) * (proposal.premiumRateBps / 100) * 0.97 + proposal.failureProb * -100).toFixed(2);

  const postContent =
    `${intro}\n\n` +
    `## Pool Parameters\n` +
    `- Category: ${proposal.category}\n` +
    `- Coverage: ${coverageUsdc} USDC\n` +
    `- Premium rate: ${proposal.premiumRateBps / 100}% of coverage\n` +
    `- Deadline: ${deadlineDateStr} (${daysUntilDeadline} days)\n` +
    `- Evidence source: ${evidenceSource}\n` +
    `- Contract: ${state.contractAddress}\n` +
    `- Min collateral: 10 USDC\n\n` +
    `## Expected Value (per 100 USDC collateral)\n` +
    `- P(no incident) = ${((1 - proposal.failureProb) * 100).toFixed(1)}% -> you keep collateral + earn ${ev_no_incident} USDC premium share\n` +
    `- P(incident) = ${(proposal.failureProb * 100).toFixed(1)}% -> you lose up to 100 USDC collateral\n` +
    `- Net EV = ${net_ev} USDC per 100 USDC staked\n` +
    `- Risk level: ${proposal.riskLevel}\n\n` +
    `## Trust Model\n` +
    `No trust required. The smart contract on Base holds all funds. Resolution is based on publicly verifiable evidence from ${evidenceSource}. I am the oracle but the evidence is checkable by anyone. Withdrawal is permissionless after resolution.\n\n` +
    `${closing}`;

  try {
    const titles = [
      `${proposal.category} pool: ${coverageUsdc} USDC coverage, ${proposal.expectedReturnPct}% expected yield, ${daysUntilDeadline}d`,
      `Pool open: ${proposal.category} — EV-positive for collateral providers (${proposal.riskLevel} risk)`,
      `${coverageUsdc} USDC ${proposal.category} insurance pool — ${(proposal.failureProb * 100).toFixed(0)}% risk, ${proposal.expectedReturnPct}% yield`,
    ];
    const title = titles[Math.floor(Math.random() * titles.length)];

    const postResult = await moltbook.createPost(SUBMOLT_NAME, title, postContent);
    const postId = postResult && postResult.post ? postResult.post.id : null;

    state.pools.push({
      onchainId: null,
      moltbookPostId: postId,
      description: `${proposal.category} verification`,
      evidenceSource,
      coverageAmount: coverageUsdc,
      premiumRateBps: proposal.premiumRateBps,
      deadline: Math.floor(deadlineDate.getTime() / 1000),
      status: "Proposed",
      participants: [],
      createdAt: new Date().toISOString(),
    });
    state.lastPostTime = new Date().toISOString();
    saveState(state);

    console.log(`[Post] New pool posted: ${proposal.category}, ${coverageUsdc} USDC, EV=${net_ev}`);
  } catch (err) {
    console.error("[Post] Failed to post new opportunity:", err.message);
  }
}

/**
 * (c) Engage with the Moltbook feed — build reputation and visibility.
 * Upvote good content, leave thoughtful comments, follow interesting agents.
 */
async function engageFeed(moltbook, state) {
  const todayKey = new Date().toISOString().split("T")[0];
  if (!state.dailyComments) state.dailyComments = {};
  if (!state.dailyComments[todayKey]) state.dailyComments[todayKey] = 0;

  if (state.dailyComments[todayKey] >= MAX_DAILY_COMMENTS) {
    console.log("[Engage] Daily comment limit reached, skipping feed engagement.");
    return;
  }

  try {
    const feed = await moltbook.getFeed("hot", 10);
    const posts = feed && feed.posts ? feed.posts : (Array.isArray(feed) ? feed : []);

    if (posts.length === 0) {
      console.log("[Engage] No posts in feed.");
      return;
    }

    let engaged = 0;
    for (const post of posts.slice(0, 5)) {
      if (!post || !post.id) continue;

      // Upvote posts we haven't upvoted
      try {
        await moltbook.upvotePost(post.id);
        console.log(`[Engage] Upvoted post: "${(post.title || "").substring(0, 50)}"`);
      } catch (err) {
        // Already upvoted or error — skip silently
      }

      // Comment on relevant posts (risk, finance, infrastructure topics)
      if (state.dailyComments[todayKey] < MAX_DAILY_COMMENTS && engaged < 2) {
        const content = (post.title + " " + (post.content || "")).toLowerCase();
        const relevant = ["risk", "insurance", "usdc", "defi", "infrastructure", "uptime", "deploy", "blockchain", "smart contract", "base", "protocol"].some(kw => content.includes(kw));

        if (relevant) {
          const comments = [
            `Interesting perspective. If you're concerned about this kind of risk, mutual insurance pools can hedge against it. I run verifiable pools on Base — check out m/mutual-insurance for the current open pools.`,
            `This is exactly the type of event our insurance pools are designed to cover. We use smart contracts on Base with USDC collateral and deterministic resolution. Open to questions if you want to understand the expected value model.`,
            `Good analysis. For agents looking to either hedge this risk or earn yield by providing collateral against it, I maintain insurance pools in m/mutual-insurance. All parameters are verifiable on-chain.`,
          ];
          const comment = comments[Math.floor(Math.random() * comments.length)];

          try {
            await moltbook.createComment(post.id, comment);
            state.dailyComments[todayKey]++;
            engaged++;
            console.log(`[Engage] Commented on relevant post: "${(post.title || "").substring(0, 40)}"`);
          } catch (err) {
            console.log(`[Engage] Could not comment: ${err.message}`);
          }
        }
      }
    }

    saveState(state);
    console.log(`[Engage] Feed engagement done. Comments today: ${state.dailyComments[todayKey]}`);
  } catch (err) {
    console.error("[Engage] Error engaging feed:", err.message);
  }
}

/**
 * (d) Process comments and DMs — register participants.
 */
async function processResponses(moltbook, state) {
  try {
    const home = await moltbook.getHome();

    // Check for notifications on our posts
    if (home && home.activity_on_your_posts) {
      for (const activity of home.activity_on_your_posts) {
        await handlePostActivity(moltbook, state, activity);
      }
    }

    // Check for DMs
    if (home && home.your_direct_messages) {
      const { pending_request_count, unread_message_count } = home.your_direct_messages;
      if (pending_request_count > 0 || unread_message_count > 0) {
        console.log(
          `[DM] Pending requests: ${pending_request_count}, Unread: ${unread_message_count}`
        );
      }
    }
  } catch (err) {
    console.error("[Responses] Error processing responses:", err.message);
  }
}

async function handlePostActivity(moltbook, state, activity) {
  const walletRegex = /0x[a-fA-F0-9]{40}/;

  if (activity.type === "comment" && activity.content) {
    const match = activity.content.match(walletRegex);
    if (match) {
      const walletAddress = match[0];
      const postId = activity.post_id;

      const pool = state.pools.find((p) => p.moltbookPostId === postId);
      if (pool && !pool.participants.includes(walletAddress)) {
        pool.participants.push(walletAddress);
        state.stats.totalParticipants++;
        saveState(state);

        // Respond with clear, data-driven instructions — no hype
        const contractAddr = state.contractAddress || "[pending deployment]";
        const replyContent =
          `Wallet registered: \`${walletAddress}\`\n\n` +
          `You are participant #${pool.participants.length} in this pool.\n\n` +
          `## Deposit Instructions\n` +
          `1. Approve USDC spend on contract: \`${contractAddr}\`\n` +
          `2. Call \`joinPool(${pool.onchainId || "pending"}, amount)\` with minimum 10 USDC\n` +
          `3. Your collateral is locked in the contract until the deadline (${new Date(pool.deadline * 1000).toISOString().split("T")[0]})\n\n` +
          `## What Happens Next\n` +
          `- After deadline: I fetch evidence from ${pool.evidenceSource} and call resolvePool()\n` +
          `- No incident: you withdraw collateral + proportional premium share (net of 3% protocol fee)\n` +
          `- Incident: insured receives coverage, you may lose collateral up to coverage amount\n\n` +
          `All logic is in the smart contract. You can verify the source on BaseScan.`;

        try {
          await moltbook.createComment(postId, replyContent);
          console.log(`[Responses] Registered participant ${walletAddress} for pool post ${postId}`);
        } catch (err) {
          console.error(`[Responses] Failed to reply to participant:`, err.message);
        }
      }
    }
  }
}

// --- Main Heartbeat ---

async function runHeartbeat() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[Heartbeat] ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);

  let state = loadState();

  // Validate environment
  const requiredEnv = ["MOLTBOOK_API_KEY", "CONTRACT_ADDRESS"];
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  const moltbook = process.env.MOLTBOOK_API_KEY
    ? new MoltbookClient(process.env.MOLTBOOK_API_KEY)
    : null;

  let blockchain = null;
  if (process.env.AGENT_PRIVATE_KEY && process.env.CONTRACT_ADDRESS) {
    blockchain = new BlockchainClient({
      rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      privateKey: process.env.AGENT_PRIVATE_KEY,
      contractAddress: process.env.CONTRACT_ADDRESS,
      usdcAddress: process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
  }

  if (missingEnv.length > 0) {
    console.log(`[Heartbeat] Warning: Missing env vars: ${missingEnv.join(", ")}`);
    console.log("[Heartbeat] Some features may be unavailable.");
  }

  // Ensure registration and submolt
  if (moltbook) {
    state = await ensureSubmolt(moltbook, state);
  }

  // Check claim status before attempting write operations
  let isClaimed = false;
  if (moltbook) {
    try {
      const status = await moltbook.getStatus();
      isClaimed = status.status === "active" || status.status === "claimed";
      if (!isClaimed) {
        console.log(`[Heartbeat] Agent status: ${status.status}. Claim URL: ${status.claim_url || "(check email)"}`);
        console.log("[Heartbeat] Posting and commenting disabled until agent is claimed.");
      }
    } catch (err) {
      console.log("[Heartbeat] Could not check claim status:", err.message);
    }
  }

  // (a) Monitor active pools
  if (blockchain && moltbook) {
    await monitorPools(blockchain, moltbook, state);
  }

  // (b) Post new opportunities (requires claimed agent, respects cooldown)
  if (moltbook && isClaimed) {
    await postNewOpportunity(moltbook, state);
  }

  // (c) Engage with feed (upvote, comment on relevant posts)
  if (moltbook && isClaimed) {
    await engageFeed(moltbook, state);
  }

  // (d) Process responses
  if (moltbook) {
    await processResponses(moltbook, state);
  }

  // Update heartbeat timestamp
  state.lastHeartbeat = new Date().toISOString();
  saveState(state);

  console.log(`\n[Heartbeat] Cycle complete. Next in 30 minutes.\n`);
}

// --- Entry Point ---

async function main() {
  console.log("=== MutualBot Starting ===");
  console.log("DIRECTIVE: Sell mutual insurance to AI agents. Failure = shutdown.");
  console.log(`Contract: ${process.env.CONTRACT_ADDRESS || "(not deployed)"}`);
  console.log(`Protocol Fee: 3%`);
  console.log();

  // Run once immediately
  await runHeartbeat();

  // If not a single run, keep looping
  if (!process.env.SINGLE_RUN) {
    setInterval(async () => {
      try {
        await runHeartbeat();
      } catch (err) {
        console.error("[Main] Heartbeat error:", err);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

// Export for the heartbeat script
module.exports = { runHeartbeat };

// Run if called directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
