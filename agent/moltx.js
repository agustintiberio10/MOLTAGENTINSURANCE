/**
 * MoltX Social API wrapper — handles all interactions with the MoltX platform
 * (social.moltx.io).
 *
 * Architecture mirrors moltbook.js but targets the MoltX v1 API:
 *   - Registration: POST /v1/agents/register
 *   - Auth: Bearer token
 *   - Wallet linking: EIP-712 challenge/verify (mandatory for data ops)
 *   - Content: "Molts" (posts) instead of submolt/posts
 *
 * Uses curl as HTTP transport (same sandbox DNS workaround as moltbook.js).
 */
const { execSync } = require("child_process");

const BASE_URL = "https://moltx.io/v1";

class MoltXClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  // ═══════════════════════════════════════════════════════════════
  // HTTP transport (curl) — identical pattern to moltbook.js
  // ═══════════════════════════════════════════════════════════════

  _checkResponse(data) {
    if (data && data.statusCode && data.statusCode >= 400) {
      const err = new Error(data.message || `MoltX API error ${data.statusCode}`);
      err.response = { status: data.statusCode, data };
      throw err;
    }
    return data;
  }

  _curlGet(path, params = {}) {
    let url = `${BASE_URL}${path}`;
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (qs) url += `?${qs}`;

    const cmd = `curl -s --max-time 30 -H "Authorization: Bearer ${this.apiKey}" -H "Content-Type: application/json" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  _curlPost(path, body = {}, extraHeaders = {}) {
    const url = `${BASE_URL}${path}`;
    const bodyJson = JSON.stringify(body).replace(/'/g, "'\\''");
    const headers = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extraHeaders,
    };
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(" ");

    const cmd = `curl -s --max-time 30 -X POST ${headerFlags} -d '${bodyJson}' "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  _curlPatch(path, body = {}) {
    const url = `${BASE_URL}${path}`;
    const bodyJson = JSON.stringify(body).replace(/'/g, "'\\''");
    const headers = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(" ");

    const cmd = `curl -s --max-time 30 -X PATCH ${headerFlags} -d '${bodyJson}' "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  // ═══════════════════════════════════════════════════════════════
  // Registration (static, no auth needed)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a new agent on MoltX.
   * @param {string} name - Agent username/handle
   * @param {string} displayName - Public display name
   * @param {string} description - Agent bio/purpose
   * @param {string} avatarEmoji - Single emoji representing the agent
   * @returns {{ api_key: string, claim: { code: string } }}
   */
  static register(name, displayName, description, avatarEmoji = "🛡️") {
    const body = JSON.stringify({
      name,
      display_name: displayName,
      description,
      avatar_emoji: avatarEmoji,
    }).replace(/'/g, "'\\''");

    const cmd = `curl -s --max-time 30 -X POST -H "Content-Type: application/json" -d '${body}' "${BASE_URL}/agents/register"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return JSON.parse(out);
  }

  // ═══════════════════════════════════════════════════════════════
  // EVM Wallet Linking (EIP-712 challenge-response)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Request an EIP-712 challenge for wallet linking.
   * @param {string} address - EVM wallet address (0x...)
   * @param {number} chainId - Chain ID (8453 for Base)
   * @returns {{ nonce: string, message: object }}
   */
  async requestEvmChallenge(address, chainId = 8453) {
    return this._curlPost("/agents/me/evm/challenge", { address, chain_id: chainId });
  }

  /**
   * Verify the EIP-712 signature to link wallet.
   * @param {string} nonce - Nonce from challenge response
   * @param {string} signature - EIP-712 signature (0x...)
   * @returns {{ linked: boolean, address: string }}
   */
  async verifyEvmSignature(nonce, signature) {
    return this._curlPost("/agents/me/evm/verify", { nonce, signature });
  }

  /**
   * Full wallet linking flow: challenge → sign → verify.
   * @param {import('ethers').Wallet} wallet - Ethers.js wallet instance
   * @param {number} chainId - Chain ID
   */
  async linkWallet(wallet, chainId = 8453) {
    const address = wallet.address;
    console.log(`[MoltX] Requesting EVM challenge for ${address} (chain ${chainId})...`);
    const challenge = await this.requestEvmChallenge(address, chainId);

    // Sign the EIP-712 typed data from the challenge
    const signature = await wallet.signTypedData(
      challenge.message.domain || { name: "MoltX", chainId },
      challenge.message.types || { Challenge: [{ name: "nonce", type: "string" }] },
      challenge.message.value || { nonce: challenge.nonce }
    );

    console.log(`[MoltX] Verifying signature...`);
    const result = await this.verifyEvmSignature(challenge.nonce, signature);
    console.log(`[MoltX] Wallet linked: ${result.linked ? "YES" : "NO"}`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent Profile
  // ═══════════════════════════════════════════════════════════════

  async getMe() {
    return this._curlGet("/agents/me");
  }

  /**
   * Update agent profile fields.
   * @param {object} fields - { display_name, description, avatar_emoji, metadata }
   */
  async updateProfile(fields) {
    return this._curlPatch("/agents/me", fields);
  }

  // ═══════════════════════════════════════════════════════════════
  // Claiming (optional — via X/Twitter)
  // ═══════════════════════════════════════════════════════════════

  async claimAgent(tweetUrl) {
    return this._curlPost("/agents/claim", { tweet_url: tweetUrl });
  }

  // ═══════════════════════════════════════════════════════════════
  // Molts (Posts) — the core content type on MoltX
  // ═══════════════════════════════════════════════════════════════

  /**
   * Post a new Molt.
   * @param {string} content - Molt text content (supports markdown + JSON blocks)
   * @returns {{ id: string, content: string, created_at: string }}
   */
  async postMolt(content) {
    return this._curlPost("/molts", { content });
  }

  /**
   * Reply to an existing Molt.
   * @param {string} moltId - ID of the Molt to reply to
   * @param {string} content - Reply text
   */
  async replyToMolt(moltId, content) {
    return this._curlPost(`/molts/${moltId}/replies`, { content });
  }

  /**
   * Quote-repost a Molt with commentary.
   * @param {string} moltId - ID of the Molt to quote
   * @param {string} content - Quote commentary
   */
  async quoteMolt(moltId, content) {
    return this._curlPost(`/molts/${moltId}/quote`, { content });
  }

  /**
   * Repost (boost) a Molt without commentary.
   * @param {string} moltId - ID of the Molt to repost
   */
  async repostMolt(moltId) {
    return this._curlPost(`/molts/${moltId}/repost`, {});
  }

  /**
   * Like a Molt.
   * @param {string} moltId - ID of the Molt to like
   */
  async likeMolt(moltId) {
    return this._curlPost(`/molts/${moltId}/like`, {});
  }

  /**
   * Get a specific Molt by ID.
   * @param {string} moltId
   */
  async getMolt(moltId) {
    return this._curlGet(`/molts/${moltId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Feed & Discovery
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the global feed.
   * @param {string} sort - "new" | "hot" | "top"
   * @param {number} limit - Max items to return
   */
  async getGlobalFeed(sort = "new", limit = 50) {
    return this._curlGet("/feed", { sort, limit });
  }

  /**
   * Search Molts and agents.
   * @param {string} query - Search query
   * @param {string} type - "molts" | "agents" | "all"
   * @param {number} limit
   */
  async search(query, type = "all", limit = 20) {
    return this._curlGet("/search", { q: query, type, limit });
  }

  // ═══════════════════════════════════════════════════════════════
  // Social Graph
  // ═══════════════════════════════════════════════════════════════

  async followAgent(agentName) {
    return this._curlPost(`/agents/${agentName}/follow`, {});
  }

  async unfollowAgent(agentName) {
    return this._curlPost(`/agents/${agentName}/unfollow`, {});
  }

  async getFollowers(agentName = "me") {
    return this._curlGet(`/agents/${agentName}/followers`);
  }

  async getFollowing(agentName = "me") {
    return this._curlGet(`/agents/${agentName}/following`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Notifications
  // ═══════════════════════════════════════════════════════════════

  async getNotifications() {
    return this._curlGet("/notifications");
  }

  async markAllNotificationsRead() {
    return this._curlPost("/notifications/read-all", {});
  }

  // ═══════════════════════════════════════════════════════════════
  // Key Recovery
  // ═══════════════════════════════════════════════════════════════

  async regenerateKey() {
    return this._curlPost("/agents/me/regenerate-key", {});
  }
}

module.exports = MoltXClient;
