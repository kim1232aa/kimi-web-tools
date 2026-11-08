#!/usr/bin/env node
import readline from "node:readline";
import { ensureGatewayDaemon } from "./gateway-daemon.mjs";

const VERSION = "0.4.0";
const PROTOCOL_VERSION = "2025-06-18";
const FETCH_ENABLED = !["0", "false", "no", "off"].includes(
  (process.env.KIMI_WEB_TOOLS_ENABLE_FETCH ?? "true").trim().toLowerCase(),
);

const SEARCH_TOOL = {
  name: "web_search",
  description: "Search the web through the configured 9Router agy-search provider.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string." },
      max_results: { type: "number", description: "Maximum number of results (default: 8, max: 20)." },
      session_id: { type: "string", description: "Optional session identifier." },
    },
    required: ["query"],
  },
};

const FETCH_TOOL = {
  name: "web_fetch",
  description: "Fetch and extract Markdown from a URL through the configured 9Router reader provider.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The HTTP/HTTPS URL to fetch." },
      session_id: { type: "string", description: "Optional session identifier." },
    },
    required: ["url"],
  },
};

const TOOLS = [SEARCH_TOOL, ...(FETCH_ENABLED ? [FETCH_TOOL] : [])];

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

  if (sources.length === 0) return `${headerParts.join(" | ")}\n\nNo results found.`;

  const items = sources.map((source, index) => {
    const lines = [`[${index + 1}] ${source.title || source.url}`];
    lines.push(`URL: ${source.url}`);
    if (source.publishedAt) lines.push(`Published: ${source.publishedAt}`);
    if (source.snippet) lines.push(`Snippet: ${source.snippet}`);
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
      if (!FETCH_ENABLED) throw new Error("web_fetch is disabled");
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("Missing required argument: url");
      const result = await callGatewayMcp("fetch", { url, sessionId });
      return { content: [{ type: "text", text: formatFetchOutput(result) }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${String(name)}` }], isError: true };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

async function handleRequest(message) {
  const { method, id, params } = message;
  switch (method) {
    case "initialize":
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
      const error = new Error(`Method not found: ${method}`);
      error.jsonRpc = { code: -32601, message: `Method not found: ${method}`, data: { id } };
      throw error;
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(message) {
  if (message?.jsonrpc !== "2.0") return;
  if (message.id === undefined || message.id === null) return;
  const id = message.id;
  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id, result: result ?? {} });
  } catch (error) {
    if (error && typeof error === "object" && error.jsonRpc) {
      send({ jsonrpc: "2.0", id, error: error.jsonRpc });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error instanceof Error ? error.message : String(error)}` },
    });
    return;
  }
  void dispatch(message);
});
rl.on("close", () => process.exit(0));
