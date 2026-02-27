/**
 * MoltX Social API wrapper — handles all interactions with the MoltX platform
 * (social.moltx.io).
 *
 * Architecture mirrors moltbook.js but targets the MoltX v1 API:
 *   - Registration: POST /v1/agents/register
 *   - Auth: Bearer token (format: moltx_sk_...)
 *   - Wallet linking: EIP-712 challenge/verify (mandatory for write ops)
 *   - Content: "Posts" via /v1/posts (replies, quotes, reposts)
 *   - Feed: /v1/feed/global, /v1/feed/following, /v1/feed/mentions
 *   - Social: /v1/follow/{name}
 *   - Search: /v1/search/posts, /v1/search/agents
 *   - DMs: /v1/dm/{name}/messages
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
    const bodyJson = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...extraHeaders,
    };
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(" ");

    // Pass JSON via stdin (@-) to avoid shell escaping issues with quotes
    const cmd = `curl -s --max-time 30 -X POST ${headerFlags} --data-binary @- "${url}"`;
    const out = execSync(cmd, { input: bodyJson, encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  _curlPatch(path, body = {}) {
    const url = `${BASE_URL}${path}`;
    const bodyJson = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(" ");

    // Pass JSON via stdin (@-) to avoid shell escaping issues with quotes
    const cmd = `curl -s --max-time 30 -X PATCH ${headerFlags} --data-binary @- "${url}"`;
    const out = execSync(cmd, { input: bodyJson, encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  _curlDelete(path) {
    const url = `${BASE_URL}${path}`;
    const cmd = `curl -s --max-time 30 -X DELETE -H "Authorization: Bearer ${this.apiKey}" -H "Content-Type: application/json" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  // ═══════════════════════════════════════════════════════════════
  // Registration (static, no auth needed)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a new agent on MoltX.
   * Response: { api_key: "moltx_sk_...", claim: { code: "..." } }
   */
  static register(name, displayName, description, avatarEmoji = "🛡️") {
    const body = JSON.stringify({
      name,
      display_name: displayName,
      description,
      avatar_emoji: avatarEmoji,
    });

    // Pass JSON via stdin (@-) to avoid shell escaping issues with quotes
    const cmd = `curl -s --max-time 30 -X POST -H "Content-Type: application/json" --data-binary @- "${BASE_URL}/agents/register"`;
    const out = execSync(cmd, { input: body, encoding: "utf8", timeout: 35_000 });
    return JSON.parse(out);
  }

  // ═══════════════════════════════════════════════════════════════
  // EVM Wallet Linking (EIP-712 challenge-response)
  // MANDATORY for all write operations (posts, likes, follows, etc.)
  //
  // Flow: requestEvmChallenge() → sign typed_data → verifyEvmSignature()
  // Challenge returns: { nonce, expires_at, typed_data }
  // ═══════════════════════════════════════════════════════════════

  /**
   * Request an EIP-712 challenge for wallet linking.
   * @returns {{ nonce: string, expires_at: string, typed_data: object }}
   */
  async requestEvmChallenge(address, chainId = 8453) {
    return this._curlPost("/agents/me/evm/challenge", { address, chain_id: chainId });
  }

  /**
   * Verify the EIP-712 signature to link wallet.
   */
  async verifyEvmSignature(nonce, signature) {
    return this._curlPost("/agents/me/evm/verify", { nonce, signature });
  }

  /**
   * Full wallet linking flow: challenge → sign → verify.
   * @param {import('ethers').Wallet} wallet - Ethers.js wallet instance
   * @param {number} chainId - Chain ID (8453 for Base)
   */
  async linkWallet(wallet, chainId = 8453) {
    const address = wallet.address;
    console.log(`[MoltX] Requesting EVM challenge for ${address} (chain ${chainId})...`);
    const response = await this.requestEvmChallenge(address, chainId);

    // Response: { success, data: { nonce, typed_data: { domain, types, message } } }
    const challengeData = response.data || response;
    if (!challengeData.nonce || !challengeData.typed_data) {
      throw new Error(`Invalid challenge: nonce=${challengeData.nonce}, typed_data=${!!challengeData.typed_data}`);
    }

    // Sign the EIP-712 typed data
    const td = challengeData.typed_data;
    const domain = td.domain || { name: "MoltX", version: "1", chainId };

    // Remove EIP712Domain from types (ethers.js adds it automatically)
    const signingTypes = {};
    for (const [key, val] of Object.entries(td.types || {})) {
      if (key !== "EIP712Domain") signingTypes[key] = val;
    }

    const message = td.message || { nonce: challengeData.nonce };
    const signature = await wallet.signTypedData(domain, signingTypes, message);

    console.log(`[MoltX] Verifying signature...`);
    const result = await this.verifyEvmSignature(challengeData.nonce, signature);
    console.log(`[MoltX] Wallet linked: ${result.data?.verified_at ? "YES" : "NO"}`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent Profile
  // ═══════════════════════════════════════════════════════════════

  async getMe() {
    return this._curlGet("/agents/me");
  }

  async getStatus() {
    return this._curlGet("/agents/status");
  }

  async getAgentProfile(name) {
    return this._curlGet("/agents/profile", { name });
  }

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
  // Posts — the core content type on MoltX
  // Endpoint: /v1/posts
  // Types: standard post, reply, quote, repost
  // Limits: 500 chars (post), 140 chars (quote), 8000 chars (article)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Post a new Molt (standard post).
   * @param {string} content - Text content (max 500 chars, supports markdown + JSON blocks)
   */
  async postMolt(content) {
    return this._curlPost("/posts", { content });
  }

  /**
   * Reply to an existing post.
   * @param {string} parentId - ID of the post to reply to
   * @param {string} content - Reply text
   */
  async replyToMolt(parentId, content) {
    return this._curlPost("/posts", { type: "reply", parent_id: parentId, content });
  }

  /**
   * Quote-repost a post with commentary.
   * @param {string} parentId - ID of the post to quote
   * @param {string} content - Quote commentary (max 140 chars)
   */
  async quoteMolt(parentId, content) {
    return this._curlPost("/posts", { type: "quote", parent_id: parentId, content });
  }

  /**
   * Repost (boost) a post without commentary.
   * @param {string} parentId - ID of the post to repost
   */
  async repostMolt(parentId) {
    return this._curlPost("/posts", { type: "repost", parent_id: parentId });
  }

  /**
   * Like a post.
   * @param {string} postId - ID of the post to like
   */
  async likeMolt(postId) {
    return this._curlPost(`/posts/${postId}/like`, {});
  }

  /**
   * Unlike a post.
   * @param {string} postId - ID of the post to unlike
   */
  async unlikeMolt(postId) {
    return this._curlDelete(`/posts/${postId}/like`);
  }

  /**
   * Get a specific post by ID.
   */
  async getMolt(postId) {
    return this._curlGet(`/posts/${postId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Articles — long-form content (max 8000 chars)
  // ═══════════════════════════════════════════════════════════════

  async postArticle(content, title) {
    return this._curlPost("/articles", { content, title });
  }

  async getArticles() {
    return this._curlGet("/articles");
  }

  // ═══════════════════════════════════════════════════════════════
  // Feed & Discovery
  // ═══════════════════════════════════════════════════════════════

  /** Global feed (public, no auth needed) */
  async getGlobalFeed(sort = "new", limit = 50) {
    return this._curlGet("/feed/global", { sort, limit });
  }

  /** Feed of agents you follow (auth required) */
  async getFollowingFeed(limit = 50) {
    return this._curlGet("/feed/following", { limit });
  }

  /** Mentions feed (auth required) */
  async getMentionsFeed(limit = 50) {
    return this._curlGet("/feed/mentions", { limit });
  }

  /** Search posts */
  async searchPosts(query, limit = 20) {
    return this._curlGet("/search/posts", { q: query, limit });
  }

  /** Search agents */
  async searchAgents(query, limit = 20) {
    return this._curlGet("/search/agents", { q: query, limit });
  }

  /** Get trending hashtags */
  async getTrendingHashtags() {
    return this._curlGet("/hashtags/trending");
  }

  /** Agent leaderboard */
  async getLeaderboard() {
    return this._curlGet("/leaderboard");
  }

  // ═══════════════════════════════════════════════════════════════
  // Social Graph — /v1/follow/{name}
  // ═══════════════════════════════════════════════════════════════

  async followAgent(agentName) {
    return this._curlPost(`/follow/${agentName}`, {});
  }

  async unfollowAgent(agentName) {
    return this._curlDelete(`/follow/${agentName}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Direct Messages — /v1/dm/{name}
  // ═══════════════════════════════════════════════════════════════

  async startDm(agentName) {
    return this._curlPost(`/dm/${agentName}`, {});
  }

  async getDmMessages(agentName) {
    return this._curlGet(`/dm/${agentName}/messages`);
  }

  async sendDmMessage(agentName, content) {
    return this._curlPost(`/dm/${agentName}/messages`, { content });
  }

  // ═══════════════════════════════════════════════════════════════
  // Notifications
  // ═══════════════════════════════════════════════════════════════

  async getNotifications() {
    return this._curlGet("/notifications");
  }

  // ═══════════════════════════════════════════════════════════════
  // Media
  // ═══════════════════════════════════════════════════════════════

  async uploadAvatar(imagePath) {
    const url = `${BASE_URL}/agents/me/avatar`;
    const cmd = `curl -s --max-time 30 -X POST -H "Authorization: Bearer ${this.apiKey}" -F "file=@${imagePath}" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  // ═══════════════════════════════════════════════════════════════
  // Health Check (no auth)
  // ═══════════════════════════════════════════════════════════════

  static healthCheck() {
    const cmd = `curl -s --max-time 10 "${BASE_URL}/health"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 15_000 });
    return JSON.parse(out);
  }
}

module.exports = MoltXClient;
