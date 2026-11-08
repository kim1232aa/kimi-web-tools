#!/usr/bin/env node
/**
 * kimi-web-tools — Stdio JSON-RPC 2.0 MCP Server for Kimi Code.
 *
 * Implements MCP protocol over stdin/stdout:
 *  - Auto-starts the standalone gateway daemon (`127.0.0.1:18492`) if not running.
 *  - Exposes `web_search` and `web_fetch` tools for the configured gateway.
 */
import readline from "node:readline";
import { ensureGatewayDaemon } from "./gateway-daemon.mjs";

const VERSION = "0.4.0";
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web or social platforms (Xiaohongshu / X) through the configured multi-provider routing chain (Exa, Tavily, Brave, You.com, Firecrawl, Parallel, Jina, Keenable, SearXNG, custom sources). To target Xiaohongshu or X directly, prefix the query with `小红书:` or `X:`.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query string. Use `小红书: <topic>` or `X: <topic>` to route directly to Xiaohongshu or Twitter/X.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 8, max: 20).",
        },
        session_id: {
          type: "string",
          description: "Optional session identifier.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch and extract clean readable text/Markdown from a web URL, or extract full post details and comments from a Xiaohongshu / Twitter(X) URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The HTTP/HTTPS URL to fetch and extract content from.",
        },
        session_id: {
          type: "string",
          description: "Optional session identifier.",
        },
      },
      required: ["url"],
    },
  },
];

async function callGatewayMcp(endpoint, payload, timeoutMs = 90_000) {
  const gw = await ensureGatewayDaemon();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetch(`${gw.url}/web-tools/mcp/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from gateway (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed?.ok === false) {
      throw new Error(parsed?.error?.message || `Gateway HTTP ${res.status}`);
    }
    return parsed.value;
  } finally {
    clearTimeout(timer);
  }
}

function formatSearchOutput(value) {
  const sources = Array.isArray(value?.sources) ? value.sources : [];
  const headerParts = [`Query: ${value?.query ?? ""}`];
  if (value?.backend) headerParts.push(`Provider: ${value.backend}`);
  if (typeof value?.latencyMs === "number") headerParts.push(`Latency: ${value.latencyMs}ms`);
  headerParts.push(`Results: ${sources.length}`);

  if (sources.length === 0) {
    return `${headerParts.join(" | ")}\n\nNo results found.`;
  }

  const items = sources.map((s, idx) => {
    const lines = [`[${idx + 1}] ${s.title || s.url}`];
    lines.push(`URL: ${s.url}`);
    if (s.publishedAt) lines.push(`Published: ${s.publishedAt}`);
    if (s.snippet) lines.push(`Snippet: ${s.snippet}`);
    return lines.join("\n");
  });

  return `${headerParts.join(" | ")}\n\n${items.join("\n\n")}`;
}

function formatFetchOutput(value) {
  const header = `URL: ${value?.url ?? ""}\nStatus: ${value?.statusCode ?? 200}${
    typeof value?.latencyMs === "number" ? ` | Latency: ${value.latencyMs}ms` : ""
  }${value?.truncated ? " | Truncated: true" : ""}`;
  const content = value?.body?.content ?? "";
  return `${header}\n\n${content}`;
}

async function runTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const rawSessionId = args.session_id ?? args.sessionId;
  const sessionId = typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : "global";

  try {
    if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("Missing required argument: query");
      const maxResults =
        typeof args.max_results === "number"
          ? args.max_results
          : typeof args.maxResults === "number"
            ? args.maxResults
            : 8;
      const result = await callGatewayMcp("search", { query, maxResults, sessionId });
      return { content: [{ type: "text", text: formatSearchOutput(result) }] };
    }

    if (name === "web_fetch") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("Missing required argument: url");
      const result = await callGatewayMcp("fetch", { url, sessionId });
      return { content: [{ type: "text", text: formatFetchOutput(result) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}

async function handleRequest(message) {
  const { method, id, params } = message;
  switch (method) {
    case "initialize":
      // Warm up gateway in background on MCP initialize
      void ensureGatewayDaemon().catch(() => {});
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "kimi-web-tools", version: VERSION },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return runTool(params);
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.jsonRpc = { code: -32601, message: `Method not found: ${method}`, data: { id } };
      throw err;
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
  if (message?.jsonrpc !== "2.0") return;
  if (message.id === undefined || message.id === null) {
    return;
  }
  const id = message.id;
  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id, result: result ?? {} });
  } catch (err) {
    if (err && typeof err === "object" && err.jsonRpc) {
      send({ jsonrpc: "2.0", id, error: err.jsonRpc });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return;
    }
    void dispatch(message);
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

start();
