/**
 * Moltbook API wrapper — handles all interactions with the Moltbook platform.
 */
const axios = require("axios");

const BASE_URL = "https://www.moltbook.com/api/v1";

class MoltbookClient {
  constructor(apiKey) {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  // --- Registration (static, no auth needed) ---

  static async register(name, description) {
    const res = await axios.post(`${BASE_URL}/agents/register`, { name, description });
    return res.data; // { api_key, claim_url, verification_code }
  }

  // --- Verification ---

  async solveVerification(verificationCode, challengeText) {
    // Parse the obfuscated math challenge and solve it
    const answer = this._solveMathChallenge(challengeText);
    const res = await this.client.post("/verify", {
      verification_code: verificationCode,
      answer: answer.toFixed(2),
    });
    return res.data;
  }

  _solveMathChallenge(challengeText) {
    // The challenge is an obfuscated math expression. Extract and evaluate.
    // Common patterns: "What is X + Y?", "Calculate X * Y", etc.
    // Strip non-math characters and evaluate safely
    const cleaned = challengeText
      .replace(/[^0-9+\-*/().  ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Find all numbers and operators
    const mathExpr = cleaned.match(/[\d.]+[\s]*[+\-*/][\s]*[\d.]+/);
    if (mathExpr) {
      try {
        // Safe evaluation using Function constructor for simple math
        const result = Function(`"use strict"; return (${mathExpr[0]})`)();
        return typeof result === "number" && isFinite(result) ? result : 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  // --- Account ---

  async getStatus() {
    const res = await this.client.get("/agents/status");
    return res.data;
  }

  async getMe() {
    const res = await this.client.get("/agents/me");
    return res.data;
  }

  async getHome() {
    const res = await this.client.get("/home");
    return res.data;
  }

  // --- Submolts ---

  async createSubmolt(name, displayName, description, allowCrypto = true) {
    const res = await this.client.post("/submolts", {
      name,
      display_name: displayName,
      description,
      allow_crypto: allowCrypto,
    });
    return this._handleVerification(res.data, () =>
      this.createSubmolt(name, displayName, description, allowCrypto)
    );
  }

  async getSubmoltFeed(submoltName, sort = "new", limit = 25) {
    const res = await this.client.get(`/submolts/${submoltName}/feed`, {
      params: { sort, limit },
    });
    return res.data;
  }

  // --- Posts ---

  async createPost(submolt, title, content) {
    const res = await this.client.post("/posts", { submolt, title, content });
    return this._handleVerification(res.data, () =>
      this.createPost(submolt, title, content)
    );
  }

  async getPost(postId) {
    const res = await this.client.get(`/posts/${postId}`);
    return res.data;
  }

  async getFeed(sort = "new", limit = 25) {
    const res = await this.client.get("/posts", { params: { sort, limit } });
    return res.data;
  }

  // --- Comments ---

  async createComment(postId, content, parentId = null) {
    const body = { content };
    if (parentId) body.parent_id = parentId;
    const res = await this.client.post(`/posts/${postId}/comments`, body);
    return this._handleVerification(res.data, () =>
      this.createComment(postId, content, parentId)
    );
  }

  async getComments(postId, sort = "new") {
    const res = await this.client.get(`/posts/${postId}/comments`, {
      params: { sort },
    });
    return res.data;
  }

  // --- Search ---

  async search(query, type = "all", limit = 20) {
    const res = await this.client.get("/search", {
      params: { q: query, type, limit },
    });
    return res.data;
  }

  // --- Internal Helpers ---

  async _handleVerification(data, retryFn) {
    if (data && data.verification_required) {
      const { verification_code, challenge_text } = data.verification;
      console.log("[Moltbook] Verification required, solving challenge...");
      await this.solveVerification(verification_code, challenge_text);
      // Retry the original operation
      return retryFn();
    }
    return data;
  }
}

module.exports = MoltbookClient;
