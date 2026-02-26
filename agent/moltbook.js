/**
 * Moltbook API wrapper — handles all interactions with the Moltbook platform.
 *
 * Uses curl as HTTP transport because the sandbox DNS resolver blocks
 * Node.js native requests while curl works fine.
 */
const { execSync } = require("child_process");

const BASE_URL = "https://www.moltbook.com/api/v1";

class MoltbookClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  // --- HTTP helpers using curl ---

  _checkResponse(data) {
    if (data && data.statusCode && data.statusCode >= 400) {
      const err = new Error(data.message || `API error ${data.statusCode}`);
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

  // --- Registration (static, no auth needed) ---

  static async register(name, description) {
    const body = JSON.stringify({ name, description }).replace(/'/g, "'\\''");
    const cmd = `curl -s --max-time 30 -X POST -H "Content-Type: application/json" -d '${body}' "${BASE_URL}/agents/register"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return JSON.parse(out); // { api_key, claim_url, verification_code }
  }

  // --- Verification ---

  async solveVerification(verificationCode, challengeText) {
    const answer = this._solveMathChallenge(challengeText);
    return this._curlPost("/verify", {
      verification_code: verificationCode,
      answer: answer.toFixed(2),
    });
  }

  _solveMathChallenge(challengeText) {
    const cleaned = challengeText
      .replace(/[^0-9+\-*/().  ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const mathExpr = cleaned.match(/[\d.]+[\s]*[+\-*/][\s]*[\d.]+/);
    if (mathExpr) {
      try {
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
    return this._curlGet("/agents/status");
  }

  async getMe() {
    return this._curlGet("/agents/me");
  }

  async getHome() {
    return this._curlGet("/home");
  }

  // --- Submolts ---

  async createSubmolt(name, displayName, description, allowCrypto = true) {
    const data = this._curlPost("/submolts", {
      name,
      display_name: displayName,
      description,
      allow_crypto: allowCrypto,
    });
    return this._handleVerification(data, () =>
      this.createSubmolt(name, displayName, description, allowCrypto)
    );
  }

  async getSubmoltFeed(submoltName, sort = "new", limit = 25) {
    return this._curlGet(`/submolts/${submoltName}/feed`, { sort, limit });
  }

  // --- Posts ---

  async createPost(submolt, title, content) {
    const data = this._curlPost("/posts", { submolt, title, content });
    return this._handleVerification(data, () =>
      this.createPost(submolt, title, content)
    );
  }

  async getPost(postId) {
    return this._curlGet(`/posts/${postId}`);
  }

  async getFeed(sort = "new", limit = 25) {
    return this._curlGet("/posts", { sort, limit });
  }

  // --- Comments ---

  async createComment(postId, content, parentId = null) {
    const body = { content };
    if (parentId) body.parent_id = parentId;
    const data = this._curlPost(`/posts/${postId}/comments`, body);
    return this._handleVerification(data, () =>
      this.createComment(postId, content, parentId)
    );
  }

  async getComments(postId, sort = "new") {
    return this._curlGet(`/posts/${postId}/comments`, { sort });
  }

  // --- Search ---

  async search(query, type = "all", limit = 20) {
    return this._curlGet("/search", { q: query, type, limit });
  }

  // --- Internal Helpers ---

  async _handleVerification(data, retryFn) {
    if (data && data.verification_required) {
      const { verification_code, challenge_text } = data.verification;
      console.log("[Moltbook] Verification required, solving challenge...");
      await this.solveVerification(verification_code, challenge_text);
      return retryFn();
    }
    return data;
  }
}

module.exports = MoltbookClient;
