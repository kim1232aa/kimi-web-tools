/**
 * kimi-web-tools — End-to-End Integration Tests for Gateway Server and MCP Server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "../src/host/gateway-server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("Standalone Gateway Server serves UI, management APIs, and MCP endpoints", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-gw-"));
  const handle = await startGatewayServer({
    host: "127.0.0.1",
    port: 0,
    baseDir: tmpDir,
    projectRoot: ROOT,
  });

  try {
    // 1. Static UI: GET / and GET /app.js
    const htmlRes = await fetch(`${handle.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes("--dsw-alias-label-primary"), "index.html must include --dsw-alias-* CSS variables");
    assert.ok(html.includes('<script type="module" src="/app.js"></script>'));

    const jsRes = await fetch(`${handle.url}/app.js`);
    assert.equal(jsRes.status, 200);
    const jsText = await jsRes.text();
    assert.ok(jsText.includes("Kimi Web Tools"), "app.js must include StandaloneApp bundle");

    // 2. Version check via both GET and POST
    const verGet = await fetch(`${handle.url}/web-tools/api/version/check`);
    assert.equal(verGet.status, 200);
    const verJson = (await verGet.json()) as any;
    assert.equal(verJson.ok, true);
    assert.equal(verJson.value.currentVersion, "0.4.0");

    // 3. Config get & save
    const cfgRes = await fetch(`${handle.url}/web-tools/api/config/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = (await cfgRes.json()) as any;
    assert.equal(cfgJson.ok, true);
    assert.ok(Array.isArray(cfgJson.value.providers));

    // 4. Search mode via management API and MCP endpoint
    const modeSet = await fetch(`${handle.url}/web-tools/api/search-mode/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "global", mode: "required" }),
    });
    assert.equal(modeSet.status, 200);
    const modeSetJson = (await modeSet.json()) as any;
    assert.equal(modeSetJson.value.mode, "required");

    const mcpMode = await fetch(`${handle.url}/web-tools/mcp/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "get", sessionId: "sess-100" }),
    });
    const mcpModeJson = (await mcpMode.json()) as any;
    assert.equal(mcpModeJson.ok, true);
    assert.equal(mcpModeJson.value.mode, "required", "session inherits global mode when not overridden");

    // 5. MCP status endpoint
    const mcpStatus = await fetch(`${handle.url}/web-tools/mcp/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-100" }),
    });
    const mcpStatusJson = (await mcpStatus.json()) as any;
    assert.equal(mcpStatusJson.ok, true);
    assert.equal(mcpStatusJson.value.version, "0.4.0");
    assert.equal(mcpStatusJson.value.mode.mode, "required");
  } finally {
    await handle.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Stdio MCP Server registers only web_search and web_fetch", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "mcp-server.mjs")], {
    cwd: ROOT,
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");

    const deadline = Date.now() + 3000;
    while (responses.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 1);
    const toolNames = responses[0].result.tools.map((t: any) => t.name);
    assert.deepEqual(toolNames, ["web_search", "web_fetch"]);
  } finally {
    child.kill();
  }
});
