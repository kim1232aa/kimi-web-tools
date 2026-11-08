import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "../src/host/gateway-server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function startUpstream(): Promise<{
  url: string;
  requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += Buffer.from(chunk).toString("utf8");
    const request = {
      path: req.url ?? "",
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    };
    requests.push(request);
    const response = request.path === "/v1/search" && request.body.query === "error"
      ? { status: 502, body: { error: { message: "stub upstream failure" } } }
      : request.path === "/v1/search"
        ? {
            status: 200,
            body: {
              provider: "agy-search",
              results: [{ title: "Gateway result", url: "https://example.com/result", snippet: "Stub result" }],
            },
          }
        : {
            status: 200,
            body: {
              provider: "jina-reader",
              content: { text: "Stub fetched content" },
            },
          };
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as http.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.KIMI_CODE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-gateway-test-"));
  process.env.KIMI_CODE_HOME = home;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("minimal gateway serves health, search, and fetch without dashboard routes", async () => {
  await withTempHome(async () => {
    const upstream = await startUpstream();
    const handle = await startGatewayServer({
      host: "127.0.0.1",
      port: 0,
      upstreamUrl: upstream.url,
      upstreamKey: "gateway-upstream-key",
    });

    try {
      const health = await fetch(`${handle.internalUrl}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json() as any).value.status, "healthy");

      const aliasHealth = await fetch(`${handle.internalUrl}/web-tools/health`);
      assert.equal(aliasHealth.status, 200);

      const search = await fetch(`${handle.internalUrl}/web-tools/mcp/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "minimal gateway", maxResults: 2 }),
      });
      assert.equal(search.status, 200);
      assert.deepEqual((await search.json() as any).value.sources, [
        { title: "Gateway result", url: "https://example.com/result", snippet: "Stub result" },
      ]);

      const fetched = await fetch(`${handle.internalUrl}/web-tools/mcp/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/result" }),
      });
      assert.equal(fetched.status, 200);
      assert.equal((await fetched.json() as any).value.body.content, "Stub fetched content");

      assert.deepEqual(upstream.requests.map((request) => request.path), ["/v1/search", "/v1/web/fetch"]);
      assert.ok(upstream.requests.every((request) => request.authorization === "Bearer gateway-upstream-key"));
    } finally {
      await handle.close();
      await upstream.close();
    }
  });
});

test("disabled fetch returns a stable error and is not sent upstream", async () => {
  await withTempHome(async () => {
    const upstream = await startUpstream();
    const handle = await startGatewayServer({
      host: "127.0.0.1",
      port: 0,
      upstreamUrl: upstream.url,
      upstreamKey: "gateway-upstream-key",
      enableFetch: false,
    });

    try {
      const response = await fetch(`${handle.internalUrl}/web-tools/mcp/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/result" }),
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json() as any).error.code, "fetch-disabled");
      assert.equal(upstream.requests.length, 0);
    } finally {
      await handle.close();
      await upstream.close();
    }
  });
});

async function waitForResponse(responses: any[], id: number): Promise<any> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const response = responses.find((entry) => entry.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for MCP response ${id}`);
}

test("Stdio MCP Server initializes, lists tools, searches, fetches, and exposes upstream errors", async () => {
  await withTempHome(async () => {
    const upstream = await startUpstream();
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "mcp-server.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
        KIMI_WEB_TOOLS_HOST: "127.0.0.1",
        KIMI_WEB_TOOLS_PORT: "0",
        KIMI_WEB_TOOLS_PASSWORD: "",
        KIMI_WEB_TOOLS_ENABLE_FETCH: "true",
        NINEROUTER_URL: upstream.url,
        NINEROUTER_KEY: "mcp-upstream-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: any[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    try {
      const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        return waitForResponse(responses, id);
      };

      const initialized = await send(1, "initialize");
      assert.equal(initialized.result.serverInfo.name, "kimi-web-tools");
      const listed = await send(2, "tools/list");
      assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ["web_search", "web_fetch"]);

      const searched = await send(3, "tools/call", {
        name: "web_search",
        arguments: { query: "stdio search", max_results: 2 },
      });
      assert.equal(searched.result.isError, undefined, JSON.stringify(searched));
      assert.match(searched.result.content[0].text, /Gateway result/);

      const fetched = await send(4, "tools/call", {
        name: "web_fetch",
        arguments: { url: "https://example.com/result" },
      });
      assert.equal(fetched.result.isError, undefined);
      assert.match(fetched.result.content[0].text, /Stub fetched content/);

      const failed = await send(5, "tools/call", {
        name: "web_search",
        arguments: { query: "error" },
      });
      assert.equal(failed.result.isError, true);
      assert.match(failed.result.content[0].text, /HTTP 502|stub upstream failure/);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const statePath = path.join(process.env.KIMI_CODE_HOME ?? "", "web-tools", "gateway.json");
      if (fs.existsSync(statePath)) {
        try {
          process.kill(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, "SIGTERM");
        } catch {}
      }
      await upstream.close();
    }
  });
});


test("Stdio MCP Server omits web_fetch when fetch is disabled", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "mcp-server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, KIMI_WEB_TOOLS_ENABLE_FETCH: "false" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let response;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) response = JSON.parse(line);
    }
  });

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    const deadline = Date.now() + 3000;
    while (!response && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(response?.result.tools.map((tool: any) => tool.name), ["web_search"]);
  } finally {
    child.kill();
  }
});
