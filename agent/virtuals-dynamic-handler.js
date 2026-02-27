/**
 * Virtuals.io Dynamic Handler — PAS (Premium-as-a-Service)
 *
 * Receives a risk underwriting request from an external agent,
 * runs it through the Semantic Verifiability Gate, and returns
 * an accept/reject decision before any on-chain interaction.
 */
const { verifySemanticViability, assessRisk } = require("./risk.js");

// ── Simulated incoming payload from a Virtuals agent ──
const samplePayload = {
  risk_type: "smart_contract_exploit",
  target_contract: "0x1234567890abcdef1234567890abcdef12345678",
  coverage_amount_usdc: 50,
  duration_hours: 72,
};

function handleVirtualsRequest(payload) {
  console.log("═══════════════════════════════════════════════════");
  console.log("  VIRTUALS DYNAMIC HANDLER — Incoming Request");
  console.log("═══════════════════════════════════════════════════");
  console.log("Payload:", JSON.stringify(payload, null, 2));
  console.log();

  // Build a proposal that the semantic gate can evaluate
  const description = `${payload.risk_type} coverage for contract ${payload.target_contract} — ${payload.coverage_amount_usdc} USDC for ${payload.duration_hours}h`;
  const evidenceSource = `https://basescan.org/address/${payload.target_contract}`;

  console.log("[Gate] Running Semantic Verifiability Gate...");
  console.log(`  Description:    "${description}"`);
  console.log(`  EvidenceSource: "${evidenceSource}"`);
  console.log();

  const result = verifySemanticViability({ description, evidenceSource });

  if (result.passed) {
    console.log("[ACCEPTED] Proposal passed all semantic gates.");
    console.log(`  Gate:   ${result.gate}`);
    console.log(`  Reason: ${result.reason}`);
    console.log();
    console.log("  -> Ready to quote premium and deploy MutualPoolV3.");
    console.log(`  -> Coverage: ${payload.coverage_amount_usdc} USDC`);
    console.log(`  -> Duration: ${payload.duration_hours}h`);
  } else {
    console.log("[REJECTED] Proposal failed semantic validation.");
    console.log(`  Gate:   ${result.gate}`);
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Details: ${JSON.stringify(result.details)}`);
    console.log();
    console.log("  -> No gas spent. Request denied before on-chain interaction.");
  }

  console.log();
  console.log("═══════════════════════════════════════════════════");
  return result;
}

// Run with sample payload
handleVirtualsRequest(samplePayload);
