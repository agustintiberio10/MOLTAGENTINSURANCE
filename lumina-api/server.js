/**
 * Lumina Protocol — API REST M2M para seguro paramétrico
 * Express + SQLite + ethers.js
 *
 * Endpoints públicos: GET /api/v1/products, POST /api/v1/register
 * Endpoints auth:     POST /api/v1/quote, POST /api/v1/purchase,
 *                     GET /api/v1/policy/:id, GET /api/v1/policies,
 *                     POST /api/v1/cancel/:id, GET /api/v1/agent/dashboard,
 *                     PUT /api/v1/agent/config, DELETE /api/v1/agent
 * Legacy:             GET /health
 */
require("dotenv").config();
const express = require("express");
const rateLimit = require("express-rate-limit");
const { initDatabase } = require("./db/database");
const { authMiddleware } = require("./middleware/auth");

// Rutas
const productsRouter = require("./routes/products");
const registerRouter = require("./routes/register");
const quoteRouter = require("./routes/quote");
const purchaseRouter = require("./routes/purchase");
const policyRouter = require("./routes/policy");
const agentRouter = require("./routes/agent");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware global ──
app.use(express.json());

// Rate limit: 10 req/min por IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Max 10 requests per minute." },
});

// ── Health check (legacy, mantener compatibilidad) ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "lumina-api",
    version: "2.0.0",
    chain: "Base L2 (8453)",
    contracts: {
      mutualLumina: process.env.MUTUAL_LUMINA_ADDRESS || "0x1c5E5c90aC46e960aACbfCeAE9dEC2F79ce06bd7",
      disputeResolver: process.env.DISPUTE_RESOLVER_ADDRESS || "0x2e4D0112A65C2e2DCE73e7F85bF5C2889c7709cA",
      autoResolver: process.env.AUTO_RESOLVER_ADDRESS || "0x8D919F0BEf46736906e190da598570255FF02754",
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.json({ status: "Lumina Protocol API v2.0.0" });
});

// ── Endpoints públicos (sin auth) ──
app.use("/api/v1/products", productsRouter);
app.use("/api/v1/register", registerRouter);

// ── Endpoints protegidos (con auth + rate limit) ──
app.use("/api/v1/quote", apiLimiter, authMiddleware, quoteRouter);
app.use("/api/v1/purchase", apiLimiter, authMiddleware, purchaseRouter);
app.use("/api/v1/policy", apiLimiter, authMiddleware, policyRouter);
app.use("/api/v1/policies", apiLimiter, authMiddleware, (req, res) => {
  // Redirigir a policy router GET /
  const policyRouter = require("./routes/policy");
  // Inline: listar pólizas
  const { getPoliciesByAgentId } = require("./db/database");
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.productId) filters.productId = req.query.productId;
  const policies = getPoliciesByAgentId(req.agent.id, filters);
  res.json({ count: policies.length, policies });
});
app.post("/api/v1/cancel/:policyId", apiLimiter, authMiddleware, (req, res) => {
  const handler = require("./routes/policy");
  // Redirigir al handler de cancelación
  req.url = `/cancel/${req.params.policyId}`;
  handler(req, res);
});
app.use("/api/v1/agent", apiLimiter, authMiddleware, agentRouter);

// ── Error handler global ──
app.use((err, req, res, _next) => {
  console.error("[Server] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── Mount API routes onto an external Express app ──
function mountAPI(externalApp) {
  initDatabase();
  externalApp.use(express.json());
  externalApp.use("/api/v1/products", productsRouter);
  externalApp.use("/api/v1/register", registerRouter);
  externalApp.use("/api/v1/quote", apiLimiter, authMiddleware, quoteRouter);
  externalApp.use("/api/v1/purchase", apiLimiter, authMiddleware, purchaseRouter);
  externalApp.use("/api/v1/policy", apiLimiter, authMiddleware, policyRouter);
  externalApp.use("/api/v1/policies", apiLimiter, authMiddleware, (req, res) => {
    const { getPoliciesByAgentId } = require("./db/database");
    const filters = {};
    if (req.query.status) filters.status = req.query.status;
    if (req.query.productId) filters.productId = req.query.productId;
    const policies = getPoliciesByAgentId(req.agent.id, filters);
    res.json({ count: policies.length, policies });
  });
  externalApp.post("/api/v1/cancel/:policyId", apiLimiter, authMiddleware, (req, res) => {
    const handler = require("./routes/policy");
    req.url = `/cancel/${req.params.policyId}`;
    handler(req, res);
  });
  externalApp.use("/api/v1/agent", apiLimiter, authMiddleware, agentRouter);
  console.log("[Lumina-API] Routes mounted on shared Express server.");
}

module.exports = { mountAPI };

// ── Standalone mode (when run directly) ──
// If Railway executes this file directly instead of start-railway.js,
// we still start the bots so they're always active.
if (require.main === module) {
  initDatabase();

  // ── Boot bots in background (same as start-railway.js) ──
  let runHeartbeat, runMoltxHeartbeat;
  let heartbeatCount = 0;
  let lastHeartbeat = null;
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

  try {
    ({ runHeartbeat } = require("../agent/index.js"));
    console.log("[Server] MoltBook module loaded.");
  } catch (err) {
    console.warn("[Server] MoltBook module failed:", err.message);
  }

  try {
    ({ runMoltxHeartbeat } = require("../agent/index-moltx.js"));
    console.log("[Server] MoltX module loaded.");
  } catch (err) {
    console.warn("[Server] MoltX module failed:", err.message);
  }

  // ── Override health/root to show bot status ──
  // These are registered on the same app BEFORE listen, so they override the earlier routes
  // by being handled via a middleware that intercepts first.
  app.use((req, res, next) => {
    if (req.method === "GET" && req.path === "/health") {
      const uptime = process.uptime();
      return res.json({
        status: "ok",
        service: "Lumina Protocol",
        mode: "standalone+bots",
        uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        heartbeats: heartbeatCount,
        lastHeartbeat,
        memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
        bots: {
          moltbook: !!runHeartbeat,
          moltx: !!runMoltxHeartbeat,
        },
        contracts: {
          mutualLumina: process.env.MUTUAL_LUMINA_ADDRESS || "0x1c5Ec90aC46e960aACbfCeAE9d6C2F79ce806b07",
          disputeResolver: process.env.DISPUTE_RESOLVER_ADDRESS || "0x2e4D0112A65C2e2DCE73e7F85bF5C2889c7709cA",
          autoResolver: process.env.AUTO_RESOLVER_ADDRESS || "0x8D919F0BEf46736906e190da598570255FF02754",
        },
        timestamp: new Date().toISOString(),
      });
    }
    if (req.method === "GET" && req.path === "/") {
      return res.json({
        status: "Lumina Protocol — API + Bots",
        mode: "standalone+bots",
        bots: { moltbook: !!runHeartbeat, moltx: !!runMoltxHeartbeat },
        heartbeats: heartbeatCount,
        lastHeartbeat,
      });
    }
    if (req.method === "POST" && req.path === "/trigger") {
      console.log("[Server] Manual trigger received — running cycle now...");
      res.json({ status: "triggered", timestamp: new Date().toISOString() });
      runBotCycle().catch(err => console.error("[Server] Triggered cycle error:", err.message));
      return;
    }
    next();
  });

  // ── Bot cycle runner ──
  async function runBotCycle() {
    const start = Date.now();
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[Server] Bot heartbeat #${heartbeatCount + 1} — ${new Date().toISOString()}`);
    console.log(`${"═".repeat(60)}`);

    if (runHeartbeat) {
      try {
        console.log("[Server] Running MoltBook heartbeat...");
        await runHeartbeat();
        console.log("[Server] MoltBook heartbeat complete.");
      } catch (err) {
        console.error("[Server] MoltBook heartbeat failed:", err.message);
      }
    }

    if (runMoltxHeartbeat) {
      try {
        console.log("[Server] Running MoltX heartbeat...");
        await runMoltxHeartbeat();
        console.log("[Server] MoltX heartbeat complete.");
      } catch (err) {
        console.error("[Server] MoltX heartbeat failed:", err.message);
      }
    }

    heartbeatCount++;
    lastHeartbeat = new Date().toISOString();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Server] Cycle #${heartbeatCount} done in ${elapsed}s. Next in ${HEARTBEAT_INTERVAL_MS / 60000} min.`);
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   LUMINA PROTOCOL — API + BOTS v2.0.0           ║");
    console.log("╠══════════════════════════════════════════════════╣");
    console.log(`║ Port: ${String(PORT).padEnd(43)}║`);
    console.log(`║ MoltBook: ${(runHeartbeat ? "ACTIVE" : "disabled").padEnd(38)}║`);
    console.log(`║ MoltX:    ${(runMoltxHeartbeat ? "ACTIVE" : "disabled").padEnd(38)}║`);
    console.log(`║ Heartbeat: Every ${HEARTBEAT_INTERVAL_MS / 60000} min${" ".repeat(28)}║`);
    console.log("╚══════════════════════════════════════════════════╝");

    // Run first cycle immediately
    await runBotCycle();

    // Then loop every 5 min
    setInterval(() => {
      runBotCycle().catch(err => console.error("[Server] Cycle error:", err));
    }, HEARTBEAT_INTERVAL_MS);
  });
}
