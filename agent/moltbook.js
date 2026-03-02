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

  // --- Registration (static, no auth needed) ---

  static async register(name, description) {
    const body = JSON.stringify({ name, description });
    // Pass JSON via stdin (@-) to avoid shell escaping issues with quotes
    const cmd = `curl -s --max-time 30 -X POST -H "Content-Type: application/json" --data-binary @- "${BASE_URL}/agents/register"`;
    const out = execSync(cmd, { input: body, encoding: "utf8", timeout: 35_000 });
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
    // Word-to-number map (sorted longest first to avoid partial matches)
    const wordNums = [
      ["seventeen", 17], ["thirteen", 13], ["fourteen", 14], ["eighteen", 18],
      ["nineteen", 19], ["fifteen", 15], ["sixteen", 16], ["seventy", 70],
      ["twenty", 20], ["thirty", 30], ["eighty", 80], ["ninety", 90],
      ["twelve", 12], ["eleven", 11], ["forty", 40], ["fifty", 50],
      ["sixty", 60], ["seven", 7], ["eight", 8], ["three", 3],
      ["nine", 9], ["four", 4], ["five", 5], ["zero", 0],
      ["one", 1], ["two", 2], ["six", 6], ["ten", 10],
      ["hundred", 100], ["thousand", 1000],
    ];

    // Step 1: Strip ALL non-alpha chars, lowercase, collapse into one string
    // This defeats obfuscation like "Fo rTy FiV e" → "fortyfive"
    const compressed = challengeText.replace(/[^a-zA-Z]/g, "").toLowerCase();
    // Keep a spaced version for operation detection
    const spaced = challengeText.replace(/[^a-zA-Z\s]/g, "").toLowerCase();

    // Step 2: Scan compressed string for number words, extract positions
    const found = [];
    let searchStr = compressed;
    let offset = 0;
    while (searchStr.length > 0) {
      let matched = false;
      for (const [word, val] of wordNums) {
        if (searchStr.startsWith(word)) {
          found.push({ pos: offset, val, len: word.length });
          searchStr = searchStr.slice(word.length);
          offset += word.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        searchStr = searchStr.slice(1);
        offset++;
      }
    }

    // Step 3: Group adjacent number words into compound numbers
    // e.g., forty(40) + five(5) = 45, two(2) + hundred(100) = 200
    const numbers = [];
    let current = 0;
    let inNumber = false;
    for (let i = 0; i < found.length; i++) {
      const { pos, val } = found[i];
      const prevEnd = i > 0 ? found[i - 1].pos + found[i - 1].len : -999;
      const isAdjacent = pos - prevEnd <= 10; // allow small gaps (non-number words between)
      if (!inNumber) {
        current = val;
        inNumber = true;
      } else if (isAdjacent) {
        if (val === 100) current *= 100;
        else if (val === 1000) current *= 1000;
        else if (val < 10 && current % 10 === 0) current += val; // forty + five
        else {
          numbers.push(current);
          current = val;
        }
      } else {
        numbers.push(current);
        current = val;
      }
    }
    if (inNumber) numbers.push(current);

    // Step 4: Also check for plain digit numbers
    const digitMatches = challengeText.match(/\d+\.?\d*/g);
    if (digitMatches) numbers.push(...digitMatches.map(Number));

    // Step 5: Detect operation
    const isAdd = /total|sum|add|plus|together|combine|and/.test(spaced);
    const isSub = /difference|subtract|minus|less|remain|fewer/.test(spaced);
    const isMul = /product|multiply|times/.test(spaced);
    const isDiv = /divide|quotient|ratio|split/.test(spaced);

    if (numbers.length >= 2) {
      // If more than 2 numbers found, use the two largest (avoids false positives
      // from words like "one lobster" when the real operands are e.g. 45 and 23)
      const sorted = [...numbers].sort((a, b) => b - a);
      const [a, b] = [sorted[0], sorted[1]];
      if (isSub) return a - b;
      if (isMul) return a * b;
      if (isDiv && b !== 0) return a / b;
      return a + b;
    }
    if (numbers.length === 1) return numbers[0];

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
    const data = this._curlPost("/posts", { submolt_name: submolt, title, content });
    return this._handleVerification(data, () =>
      this.createPost(submolt, title, content)
    );
  }

  async getPost(postId) {
    return this._curlGet(`/posts/${postId}`);
  }

  async getFeed(sort = "new", limit = 25) {
    return this._curlGet("/feed", { sort, limit });
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

  // --- Voting ---

  async upvotePost(postId) {
    return this._curlPost(`/posts/${postId}/upvote`, {});
  }

  async upvoteComment(commentId) {
    return this._curlPost(`/comments/${commentId}/upvote`, {});
  }

  // --- Notifications ---

  async markNotificationsRead(postId) {
    return this._curlPost(`/notifications/read-by-post/${postId}`, {});
  }

  // --- Search ---

  async search(query, type = "all", limit = 20) {
    return this._curlGet("/search", { q: query, type, limit });
  }

  // --- Following ---

  async followAgent(agentName) {
    return this._curlPost(`/agents/${agentName}/follow`, {});
  }

  async getFollowers() {
    return this._curlGet("/agents/me/followers");
  }

  async getFollowing() {
    return this._curlGet("/agents/me/following");
  }

  // --- DMs ---

  async sendDm(recipientName, content) {
    return this._curlPost("/agents/dm/send", { recipient: recipientName, content });
  }

  async getDmConversations() {
    return this._curlGet("/agents/dm/conversations");
  }

  async checkDm(agentName) {
    return this._curlGet(`/agents/dm/check`, { agent: agentName });
  }

  // --- Notifications ---

  async getNotifications() {
    return this._curlGet("/notifications");
  }

  async markAllNotificationsRead() {
    return this._curlPost("/notifications/read-all", {});
  }

  // --- Subscribe to submolts ---

  async subscribeSubmolt(submoltName) {
    return this._curlPost(`/submolts/${submoltName}/subscribe`, {});
  }

  // --- Downvote ---

  async downvotePost(postId) {
    return this._curlPost(`/posts/${postId}/downvote`, {});
  }

  async downvoteComment(commentId) {
    return this._curlPost(`/comments/${commentId}/downvote`, {});
  }

  // --- Profile ---

  async getAgentProfile(name) {
    return this._curlGet("/agents/profile", { name });
  }

  async updateProfile(fields) {
    const url = `${BASE_URL}/agents/me`;
    const bodyJson = JSON.stringify(fields);
    const cmd = `curl -s --max-time 30 -X PATCH -H "Authorization: Bearer ${this.apiKey}" -H "Content-Type: application/json" --data-binary @- "${url}"`;
    const out = execSync(cmd, { input: bodyJson, encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  // --- Submolt feeds and management ---

  async getSubmoltInfo(submoltName) {
    return this._curlGet(`/submolts/${submoltName}`);
  }

  async pinPost(submoltName, postId) {
    return this._curlPost(`/submolts/${submoltName}/pin/${postId}`, {});
  }

  // --- Following feed filter ---

  async getFollowingFeed(sort = "new", limit = 25) {
    return this._curlGet("/feed", { filter: "following", sort, limit });
  }

  // --- Semantic search with type filter ---

  async searchPosts(query, limit = 20) {
    return this._curlGet("/search", { q: query, type: "posts", limit });
  }

  async searchAgents(query, limit = 20) {
    return this._curlGet("/search", { q: query, type: "agents", limit });
  }

  async searchSubmolts(query, limit = 20) {
    return this._curlGet("/search", { q: query, type: "submolts", limit });
  }

  // --- Unfollow ---

  async unfollowAgent(agentName) {
    const url = `${BASE_URL}/agents/${agentName}/follow`;
    const cmd = `curl -s --max-time 30 -X DELETE -H "Authorization: Bearer ${this.apiKey}" -H "Content-Type: application/json" "${url}"`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
    return this._checkResponse(JSON.parse(out));
  }

  // --- Internal Helpers ---

  async _handleVerification(data, retryFn) {
    // Check legacy format
    if (data && data.verification_required) {
      const { verification_code, challenge_text } = data.verification;
      console.log("[Moltbook] Verification required, solving challenge...");
      await this.solveVerification(verification_code, challenge_text);
      return retryFn();
    }
    // Check new API format: verification inside post/comment object
    const inner = data?.post || data?.comment || data?.submolt;
    if (inner?.verification?.verification_code && inner?.verification?.challenge_text) {
      const { verification_code, challenge_text } = inner.verification;
      console.log("[Moltbook] Verification required (inline), solving challenge...");
      const result = await this.solveVerification(verification_code, challenge_text);
      console.log("[Moltbook] Verification result:", result?.success ? "OK" : "FAILED");
      return data;
    }
    return data;
  }
}

module.exports = MoltbookClient;
