/**
 * Railway Production Runner — Lumina Oracle + MoltBook + MoltX in one service.
 * v3.0 — Express health check + Oracle V3 lifecycle + Ephemeral-safe state
 *
 * Features:
 * - Express HTTP health check (Railway uses PORT env var)
 * - Oracle bot with blockchain state reconstruction on startup
 * - Sequential heartbeats to avoid state.json race conditions
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Auto-restart on uncaught errors (logs and continues)
 *
 * Usage:
 *   npm start                (all: oracle + moltbook + moltx)
 *   npm run railway          (same)
 *   BOT_MODE=oracle          (oracle V3 lifecycle only)
 *   BOT_MODE=moltbook        (MoltBook only)
 *   BOT_MODE=moltx           (MoltX only)
 *   BOT_MODE=social          (MoltBook + MoltX, no oracle)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");

// ── Bot imports (lazy — only loaded if their mode is active) ──
let runHeartbeat, runMoltxHeartbeat;
let initOracleBot, runOracleHeartbeat, getOracleStatus;

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — aggressive engagement day
const BOT_MODE = process.env.BOT_MODE || "all"; // "all" | "oracle" | "moltbook" | "moltx" | "social" | "both"

const shouldRunOracle = ["all", "oracle"].includes(BOT_MODE);
const shouldRunMoltbook = ["all", "both", "social", "moltbook"].includes(BOT_MODE);
const shouldRunMoltx = ["all", "both", "social", "moltx"].includes(BOT_MODE);

let isShuttingDown = false;
let lastHeartbeat = null;
let heartbeatCount = 0;
let lastError = null;
let startedAt = Date.now();

// ── Daily limit exhaustion: sleep until midnight UTC ─────────
// When ALL social bots exhaust their daily limits, the runner sleeps
// until 00:00 UTC instead of cycling every 5 min doing nothing.
// A keepalive log every 2h prevents Railway from killing the container.

const STATE_PATH = path.join(__dirname, "..", "state.json");
const KEEPALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIDNIGHT_BUFFER_MS = 60 * 1000;               // 60s past midnight

// Limits — must match agent/index.js and agent/index-moltx.js
const MOLTBOOK_MAX_COMMENTS = 48;
const MOLTBOOK_MAX_POSTS = 20;
const MOLTX_MAX_REPLIES = 60;
const MOLTX_MAX_POSTS = 20;

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function areSocialLimitsExhausted() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const key = getTodayKey();

    // A bot is "exhausted" if it's disabled OR both its counters hit the cap
    const moltbookDone = !shouldRunMoltbook || (
      ((state.dailyComments || {})[key] || 0) >= MOLTBOOK_MAX_COMMENTS &&
      ((state.dailyPosts || {})[key] || 0) >= MOLTBOOK_MAX_POSTS
    );
    const moltxDone = !shouldRunMoltx || (
      ((state.moltxDailyReplies || {})[key] || 0) >= MOLTX_MAX_REPLIES &&
      ((state.moltxDailyPosts || {})[key] || 0) >= MOLTX_MAX_POSTS
    );

    return moltbookDone && moltxDone;
  } catch {
    return false; // Can't read state → don't sleep
  }
}

function msUntilMidnightUTC() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0
  ));
  return tomorrow.getTime() - now.getTime();
}

async function sleepUntilDailyReset() {
  const msToMidnight = msUntilMidnightUTC() + MIDNIGHT_BUFFER_MS;
  const hoursToMidnight = (msToMidnight / 3600000).toFixed(1);
  console.log(`[Railway] All daily limits reached. Sleeping until next reset at 00:00 UTC (${hoursToMidnight} hours from now)`);

  let remaining = msToMidnight;
  while (remaining > 0 && !isShuttingDown) {
    const sleepTime = Math.min(remaining, KEEPALIVE_INTERVAL_MS);
    await new Promise(r => setTimeout(r, sleepTime));
    remaining -= sleepTime;
    if (remaining > 0 && !isShuttingDown) {
      console.log(`[Railway] Keepalive — process healthy. ${(remaining / 3600000).toFixed(1)} hours until daily reset.`);
    }
  }
  if (!isShuttingDown) {
    console.log(`[Railway] Daily reset reached. Resuming full operation.`);
  }
}

// ── Express Server (Health + Lumina API) ─────────────────────
const app = express();

// Mount Lumina API routes so the API and bots share a single process
try {
  const { mountAPI } = require("../lumina-api/server.js");
  mountAPI(app);
  console.log("[Railway] Lumina API mounted on shared server.");
} catch (err) {
  console.warn("[Railway] Could not mount Lumina API (non-blocking):", err.message);
}

app.get("/", (req, res) => {
  res.json({
    status: "Lumina Protocol — Bots + API",
    mode: BOT_MODE,
    bots: { oracle: shouldRunOracle, moltbook: shouldRunMoltbook, moltx: shouldRunMoltx },
    heartbeats: heartbeatCount,
    lastHeartbeat,
  });
});

app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const oracleStatus = getOracleStatus ? getOracleStatus() : { initialized: false };

  res.json({
    status: "ok",
    service: "Lumina Protocol",
    mode: BOT_MODE,
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    heartbeats: heartbeatCount,
    lastHeartbeat,
    lastError,
    memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
    oracle: oracleStatus,
    bots: {
      oracle: shouldRunOracle,
      moltbook: shouldRunMoltbook,
      moltx: shouldRunMoltx,
    },
  });
});

// ── Heartbeat Cycle ─────────────────────────────────────────
async function runCycle() {
  if (isShuttingDown) return;

  const start = Date.now();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`[Railway] Heartbeat #${heartbeatCount + 1} starting — ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  try {
    // ── Oracle V3 Lifecycle ──
    if (shouldRunOracle && runOracleHeartbeat) {
      console.log("\n[Railway] ▸ Running Oracle V3 heartbeat...");
      await runOracleHeartbeat();
      console.log("[Railway] ✓ Oracle V3 heartbeat complete");
    }

    // ── MoltBook bot (isolated — errors don't kill MoltX) ──
    if (shouldRunMoltbook && runHeartbeat) {
      try {
        console.log("\n[Railway] ▸ Running MoltBook heartbeat...");
        await runHeartbeat();
        console.log("[Railway] ✓ MoltBook heartbeat complete");
      } catch (mbErr) {
        console.error("[Railway] ✗ MoltBook heartbeat failed (isolated):", mbErr.message);
      }
    }

    // ── MoltX bot (isolated — errors don't kill MoltBook) ──
    if (shouldRunMoltx && runMoltxHeartbeat) {
      try {
        console.log("\n[Railway] ▸ Running MoltX heartbeat...");
        await runMoltxHeartbeat();
        console.log("[Railway] ✓ MoltX heartbeat complete");
      } catch (mxErr) {
        console.error("[Railway] ✗ MoltX heartbeat failed (isolated):", mxErr.message);
      }
    }

    heartbeatCount++;
    lastHeartbeat = new Date().toISOString();
    lastError = null;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Railway] Cycle #${heartbeatCount} done in ${elapsed}s. Next in ${HEARTBEAT_INTERVAL_MS / 60000} min.`);
  } catch (err) {
    lastError = `${err.message} (${new Date().toISOString()})`;
    console.error(`[Railway] Heartbeat error:`, err.message);
    // Don't crash — just log and continue to next cycle
  }
}

// ── Graceful Shutdown ───────────────────────────────────────
function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Railway] ${signal} received — shutting down gracefully...`);

  // Give in-flight requests 5s to complete
  const server = app._server;
  if (server) {
    server.close(() => {
      console.log("[Railway] HTTP server closed.");
      console.log(`[Railway] Total heartbeats completed: ${heartbeatCount}`);
      process.exit(0);
    });
  }

  // Force exit after 10s if server doesn't close
  setTimeout(() => {
    console.error("[Railway] Forced exit after timeout.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Crash Safety — prevent silent deaths ────────────────────
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Railway] UNHANDLED REJECTION:", reason);
  lastError = `unhandledRejection: ${reason} (${new Date().toISOString()})`;
  // Don't crash — log and continue
});

process.on("uncaughtException", (err) => {
  console.error("[Railway] UNCAUGHT EXCEPTION:", err.message);
  console.error(err.stack);
  lastError = `uncaughtException: ${err.message} (${new Date().toISOString()})`;
  // Don't crash — log and continue (unless it's truly fatal)
});

// ── Start ───────────────────────────────────────────────────
async function start() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       LUMINA ORACLE — RAILWAY 24/7 PRODUCTION          ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ Mode: ${BOT_MODE.padEnd(51)}║`);
  console.log(`║ Oracle V3: ${(shouldRunOracle ? "ENABLED" : "disabled").padEnd(46)}║`);
  console.log(`║ MoltBook:  ${(shouldRunMoltbook ? "ENABLED" : "disabled").padEnd(46)}║`);
  console.log(`║ MoltX:     ${(shouldRunMoltx ? "ENABLED" : "disabled").padEnd(46)}║`);
  console.log(`║ Health: http://0.0.0.0:${String(PORT).padEnd(35)}║`);
  console.log(`║ Heartbeat: Every ${HEARTBEAT_INTERVAL_MS / 60000} min${" ".repeat(36)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // ── Step 1: Start Express health check immediately ──
  // Railway needs a port binding ASAP or it kills the container.
  app._server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Railway] Express health check listening on port ${PORT}`);
  });

  // ── Self-ping to prevent Railway from sleeping the service ──
  const SELF_PING_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
  const selfPingUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
    : `http://0.0.0.0:${PORT}/health`;

  setInterval(() => {
    fetch(selfPingUrl)
      .then(() => console.log(`[Railway] Self-ping OK — ${new Date().toISOString()}`))
      .catch(() => {});
  }, SELF_PING_INTERVAL_MS);
  console.log(`[Railway] Self-ping every 4 min → ${selfPingUrl}`);

  // ── Step 2: Load bot modules based on mode ──
  if (shouldRunMoltbook) {
    try {
      ({ runHeartbeat } = require("../agent/index.js"));
      console.log("[Railway] MoltBook module loaded.");
    } catch (err) {
      console.error("[Railway] Failed to load MoltBook module:", err.message);
    }
  }

  if (shouldRunMoltx) {
    try {
      ({ runMoltxHeartbeat } = require("../agent/index-moltx.js"));
      console.log("[Railway] MoltX module loaded.");
    } catch (err) {
      console.error("[Railway] Failed to load MoltX module:", err.message);
    }
  }

  // ── Step 3: Initialize Oracle Bot (blockchain sync) ──
  // This is the critical step for ephemeral resilience:
  // syncFromChain() reads nextPoolId() and reconstructs
  // pool state from on-chain data, so a fresh container starts correctly.
  if (shouldRunOracle) {
    try {
      const oracle = require("../agent/oracle-bot.js");
      initOracleBot = oracle.initOracleBot;
      runOracleHeartbeat = oracle.runOracleHeartbeat;
      getOracleStatus = oracle.getOracleStatus;

      console.log("\n[Railway] Initializing Oracle V3 + blockchain state sync...");
      await initOracleBot();
      console.log("[Railway] Oracle V3 initialized and synced from chain.");
    } catch (err) {
      console.error("[Railway] Oracle init failed:", err.message);
      console.error("[Railway] Oracle heartbeats will be skipped until restart.");
      // Don't crash — social bots can still run
    }
  }

  // ── Step 4: Run first cycle immediately ──
  await runCycle();

  // ── Step 5: Loop with daily-limit-aware scheduling ──
  // Instead of a blind setInterval, check limits after each cycle.
  // When exhausted, sleep until midnight UTC with 2h keepalive pings.
  while (!isShuttingDown) {
    if (areSocialLimitsExhausted()) {
      await sleepUntilDailyReset();
    } else {
      await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL_MS));
    }
    if (!isShuttingDown) {
      try {
        await runCycle();
      } catch (err) {
        console.error("[Railway] Unhandled cycle error:", err);
      }
    }
  }
}

start().catch((err) => {
  console.error("[Railway] Fatal startup error:", err);
  process.exit(1);
});
