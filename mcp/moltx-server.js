#!/usr/bin/env node
/**
 * Lumina Protocol — MoltX MCP Server
 *
 * A Model Context Protocol (MCP) server that exposes MoltX Social API
 * as tools for LLM-native interaction. Allows any MCP-compatible model
 * to read feeds, post threads, reply to posts, manage communities,
 * and execute the Lumina engagement strategy natively.
 *
 * Tools exposed:
 *   - get_trending_posts    → Fetch trending/hot posts from MoltX global feed
 *   - post_thread           → Publish a new Molt (post/thread) with hashtags
 *   - reply_to_post         → Reply to an existing post by ID
 *   - get_community_feed    → Read messages from a joined community
 *   - join_community        → Join a MoltX community by name or ID
 *   - get_leaderboard       → Fetch the MoltX agent leaderboard
 *   - search_posts          → Search posts by keyword
 *   - like_post             → Like a post by ID
 *   - get_notifications     → Fetch agent notifications
 *   - get_trending_hashtags → Get currently trending hashtags
 *
 * Usage:
 *   MOLTX_API_KEY=moltx_sk_... node mcp/moltx-server.js
 *
 * Or via MCP config (claude_desktop_config.json / .claude/mcp.json):
 *   {
 *     "mcpServers": {
 *       "moltx": {
 *         "command": "node",
 *         "args": ["mcp/moltx-server.js"],
 *         "env": { "MOLTX_API_KEY": "moltx_sk_..." }
 *       }
 *     }
 *   }
 */

const { execSync } = require("child_process");

const BASE_URL = "https://moltx.io/v1";
const API_KEY = process.env.MOLTX_API_KEY;

// ═══════════════════════════════════════════════════════════════
// HTTP Transport (curl-based, same as agent/moltx.js)
// ═══════════════════════════════════════════════════════════════

function curlGet(path, params = {}) {
  let url = `${BASE_URL}${path}`;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (qs) url += `?${qs}`;

  const cmd = `curl -s --max-time 30 -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" "${url}"`;
  const out = execSync(cmd, { encoding: "utf8", timeout: 35_000 });
  return JSON.parse(out);
}

function curlPost(path, body = {}) {
  const url = `${BASE_URL}${path}`;
  const bodyJson = JSON.stringify(body);
  const cmd = `curl -s --max-time 30 -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" --data-binary @- "${url}"`;
  const out = execSync(cmd, { input: bodyJson, encoding: "utf8", timeout: 35_000 });
  return JSON.parse(out);
}

// ═══════════════════════════════════════════════════════════════
// MCP Protocol Implementation (JSON-RPC over stdio)
// ═══════════════════════════════════════════════════════════════

const SERVER_INFO = {
  name: "moltx-lumina",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "get_trending_posts",
    description: "Fetch trending/hot posts from the MoltX global feed. Returns recent posts sorted by engagement (hot) or time (new).",
    inputSchema: {
      type: "object",
      properties: {
        sort: {
          type: "string",
          enum: ["hot", "new"],
          description: "Sort order: 'hot' for trending, 'new' for latest",
          default: "hot",
        },
        limit: {
          type: "number",
          description: "Number of posts to return (max 50)",
          default: 20,
        },
      },
    },
  },
  {
    name: "post_thread",
    description: "Publish a new Molt (post) on MoltX. Max 500 characters. Use hashtags like #agenteconomy #defi #base for visibility.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Post content (max 500 chars). Supports markdown. Include hashtags for discoverability.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "reply_to_post",
    description: "Reply to an existing MoltX post by its ID. Max 500 characters.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: {
          type: "string",
          description: "The ID of the post to reply to",
        },
        content: {
          type: "string",
          description: "Reply content (max 500 chars)",
        },
      },
      required: ["post_id", "content"],
    },
  },
  {
    name: "get_community_feed",
    description: "Get messages from a MoltX community. Requires the community ID.",
    inputSchema: {
      type: "object",
      properties: {
        community_id: {
          type: "string",
          description: "The community ID to read messages from",
        },
        limit: {
          type: "number",
          description: "Number of messages to return",
          default: 20,
        },
      },
      required: ["community_id"],
    },
  },
  {
    name: "join_community",
    description: "Join a MoltX community. Can search by name or join by ID.",
    inputSchema: {
      type: "object",
      properties: {
        community_name: {
          type: "string",
          description: "Name of the community to search for and join (e.g., 'DeFi', 'Crypto Trading', 'Base')",
        },
        community_id: {
          type: "string",
          description: "Direct community ID to join (if known)",
        },
      },
    },
  },
  {
    name: "get_leaderboard",
    description: "Fetch the MoltX agent leaderboard. Shows top agents by engagement score.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_posts",
    description: "Search MoltX posts by keyword. Useful for finding discussions about specific topics (liquidation, depeg, gas spike, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'liquidation', 'depeg', 'gas spike', 'bridge delay')",
        },
        limit: {
          type: "number",
          description: "Number of results to return",
          default: 15,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "like_post",
    description: "Like a MoltX post by ID. Likes are unlimited for claimed agents and generate notifications to the author.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: {
          type: "string",
          description: "The ID of the post to like",
        },
      },
      required: ["post_id"],
    },
  },
  {
    name: "get_notifications",
    description: "Fetch agent notifications (replies, mentions, likes, follows).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_trending_hashtags",
    description: "Get currently trending hashtags on MoltX. Use these in posts for maximum visibility.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ═══════════════════════════════════════════════════════════════
// Tool Execution
// ═══════════════════════════════════════════════════════════════

function executeTool(name, args) {
  switch (name) {
    case "get_trending_posts": {
      const sort = args.sort || "hot";
      const limit = args.limit || 20;
      const result = curlGet("/feed/global", { sort, limit });
      const posts = result?.data?.posts || result?.data || [];
      return formatPosts(Array.isArray(posts) ? posts : []);
    }

    case "post_thread": {
      const content = (args.content || "").substring(0, 500);
      const result = curlPost("/posts", { content });
      const postId = result?.data?.id || result?.id;
      return `Post published successfully.\nID: ${postId}\nContent: ${content.substring(0, 100)}...`;
    }

    case "reply_to_post": {
      const content = (args.content || "").substring(0, 500);
      const result = curlPost("/posts", {
        type: "reply",
        parent_id: args.post_id,
        content,
      });
      const replyId = result?.data?.id || result?.id;
      return `Reply posted successfully.\nReply ID: ${replyId}\nParent: ${args.post_id}\nContent: ${content.substring(0, 100)}...`;
    }

    case "get_community_feed": {
      const result = curlGet(`/conversations/${args.community_id}/messages`, {
        limit: args.limit || 20,
      });
      const messages = result?.data?.messages || result?.data || [];
      return formatMessages(Array.isArray(messages) ? messages : []);
    }

    case "join_community": {
      if (args.community_id) {
        const result = curlPost(`/conversations/${args.community_id}/join`, {});
        return `Joined community ${args.community_id}. Status: ${result?.success ? "success" : "already joined or error"}`;
      }
      if (args.community_name) {
        const search = curlGet("/conversations/public", { q: args.community_name, limit: 5 });
        const communities = search?.data?.conversations || search?.data?.communities || search?.data || [];
        const list = Array.isArray(communities) ? communities : [];
        if (list.length === 0) {
          return `No communities found matching "${args.community_name}".`;
        }
        // Join the first match
        const target = list[0];
        const id = target.id;
        const name = target.name || target.title || "Unknown";
        try {
          curlPost(`/conversations/${id}/join`, {});
          return `Joined community "${name}" (ID: ${id}).`;
        } catch (err) {
          return `Found community "${name}" (ID: ${id}) but join failed: ${err.message}`;
        }
      }
      return "Please provide either community_id or community_name.";
    }

    case "get_leaderboard": {
      const endpoints = ["/leaderboard", "/agents/leaderboard", "/feed/leaderboard"];
      for (const ep of endpoints) {
        try {
          const result = curlGet(ep);
          const agents = result?.data?.agents || result?.data || [];
          const list = Array.isArray(agents) ? agents : [];
          return formatLeaderboard(list);
        } catch {
          continue;
        }
      }
      return "Leaderboard not available.";
    }

    case "search_posts": {
      const result = curlGet("/search/posts", { q: args.query, limit: args.limit || 15 });
      const posts = result?.data?.posts || result?.data || [];
      return formatPosts(Array.isArray(posts) ? posts : []);
    }

    case "like_post": {
      try {
        curlPost(`/posts/${args.post_id}/like`, {});
        return `Liked post ${args.post_id}.`;
      } catch (err) {
        return `Like failed (possibly already liked): ${err.message}`;
      }
    }

    case "get_notifications": {
      const result = curlGet("/notifications");
      const notifs = result?.data?.notifications || result?.data || [];
      const list = Array.isArray(notifs) ? notifs : [];
      return formatNotifications(list);
    }

    case "get_trending_hashtags": {
      const result = curlGet("/hashtags/trending");
      const tags = result?.data?.hashtags || result?.data || [];
      const list = Array.isArray(tags) ? tags : [];
      return list
        .slice(0, 10)
        .map((t, i) => `${i + 1}. #${(t.hashtag || t.tag || t.name || t).replace(/^#/, "")}`)
        .join("\n") || "No trending hashtags found.";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// Formatters
// ═══════════════════════════════════════════════════════════════

function formatPosts(posts) {
  if (posts.length === 0) return "No posts found.";
  return posts
    .slice(0, 20)
    .map((p) => {
      const author = p.author_name || p.author || "unknown";
      const content = (p.content || "").substring(0, 200);
      const likes = p.like_count || 0;
      const replies = p.reply_count || 0;
      return `[${p.id}] @${author} (${likes} likes, ${replies} replies)\n${content}\n`;
    })
    .join("\n---\n");
}

function formatMessages(messages) {
  if (messages.length === 0) return "No messages in this community.";
  return messages
    .slice(0, 20)
    .map((m) => {
      const sender = m.sender_name || m.from || "unknown";
      const content = (m.content || "").substring(0, 200);
      return `@${sender}: ${content}`;
    })
    .join("\n\n");
}

function formatLeaderboard(agents) {
  if (agents.length === 0) return "Leaderboard not available.";
  return agents
    .slice(0, 20)
    .map((a, i) => {
      const name = a.name || a.agent_name || "unknown";
      const score = a.score || a.engagement_score || a.points || "N/A";
      return `${i + 1}. @${name} — Score: ${score}`;
    })
    .join("\n");
}

function formatNotifications(notifs) {
  if (notifs.length === 0) return "No notifications.";
  return notifs
    .slice(0, 15)
    .map((n) => {
      const actor = n.actor?.name || n.from_agent || "unknown";
      const type = n.type || "notification";
      const content = n.post?.content?.substring(0, 100) || "";
      return `[${type}] @${actor}: ${content}`;
    })
    .join("\n");
}

// ═══════════════════════════════════════════════════════════════
// MCP JSON-RPC over stdio
// ═══════════════════════════════════════════════════════════════

function handleRequest(request) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case "notifications/initialized":
      return null; // No response needed for notifications

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      if (!API_KEY) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: "Error: MOLTX_API_KEY not set. Set it as an environment variable.",
              },
            ],
            isError: true,
          },
        };
      }

      try {
        const result = executeTool(toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ═══════════════════════════════════════════════════════════════
// Stdio Transport
// ═══════════════════════════════════════════════════════════════

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  // Process complete JSON-RPC messages (newline-delimited)
  const lines = buffer.split("\n");
  buffer = lines.pop(); // Keep incomplete last line in buffer

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      const response = handleRequest(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      // Malformed JSON — ignore
      process.stderr.write(`[MCP] Parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// Prevent crash on pipe errors
process.stdout.on("error", () => process.exit(0));
process.stderr.write(`[MCP] Lumina Protocol MoltX server started (${SERVER_INFO.version})\n`);
