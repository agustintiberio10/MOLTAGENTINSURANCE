/**
 * Railway Combined Runner — runs both MoltBook + MoltX bots in one service.
 * v2.1 — FallbackProvider + retry limits + gasLimit fix
 *
 * Features:
 * - HTTP health check endpoint (Railway uses PORT env var)
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Sequential heartbeats to avoid state.json race conditions
 * - Auto-restart on uncaught errors (logs and continues)
 *
 * Usage:
 *   npm run railway          (both bots)
 *   npm run railway:moltbook (MoltBook only)
 *   npm run railway:moltx    (MoltX only)
 */
require("dotenv").config();
const http = require("http");
const { runHeartbeat } = require("../agent/index.js");
const { runMoltxHeartbeat } = require("../agent/index-moltx.js");

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const BOT_MODE = process.env.BOT_MODE || "both"; // "both" | "moltbook" | "moltx"

let heartbeatTimer = null;
let isShuttingDown = false;
let lastHeartbeat = null;
let heartbeatCount = 0;
let lastError = null;

// ── Health Check Server ─────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const uptime = process.uptime();
    const status = {
      status: "ok",
      mode: BOT_MODE,
      uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      heartbeats: heartbeatCount,
      lastHeartbeat,
      lastError,
      memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ── Heartbeat Cycle ─────────────────────────────────────────
async function runCycle() {
  if (isShuttingDown) return;

  const start = Date.now();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`[Railway] Heartbeat #${heartbeatCount + 1} starting — ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  try {
    if (BOT_MODE === "both" || BOT_MODE === "moltbook") {
      console.log("\n[Railway] ▸ Running MoltBook heartbeat...");
      await runHeartbeat();
      console.log("[Railway] ✓ MoltBook heartbeat complete");
    }

    if (BOT_MODE === "both" || BOT_MODE === "moltx") {
      console.log("\n[Railway] ▸ Running MoltX heartbeat...");
      await runMoltxHeartbeat();
      console.log("[Railway] ✓ MoltX heartbeat complete");
    }

    heartbeatCount++;
    lastHeartbeat = new Date().toISOString();
    lastError = null;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n[Railway] Cycle #${heartbeatCount} done in ${elapsed}s. Next in 10 min.`);
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

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  server.close(() => {
    console.log("[Railway] HTTP server closed.");
    console.log(`[Railway] Total heartbeats completed: ${heartbeatCount}`);
    process.exit(0);
  });

  // Force exit after 10s if server doesn't close
  setTimeout(() => {
    console.error("[Railway] Forced exit after timeout.");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ───────────────────────────────────────────────────
async function start() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         MUTUALBOT — RAILWAY 24/7 RUNNER                 ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║ Mode: ${BOT_MODE.padEnd(51)}║`);
  console.log(`║ Health: http://0.0.0.0:${String(PORT).padEnd(35)}║`);
  console.log(`║ Heartbeat: Every 10 min${" ".repeat(33)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // Start health check server
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Railway] Health check listening on port ${PORT}`);
  });

  // Run first cycle immediately
  await runCycle();

  // Schedule recurring cycles
  heartbeatTimer = setInterval(() => {
    runCycle().catch((err) => {
      console.error("[Railway] Unhandled cycle error:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

start().catch((err) => {
  console.error("[Railway] Fatal startup error:", err);
  process.exit(1);
});
