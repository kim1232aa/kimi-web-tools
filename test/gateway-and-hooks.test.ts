/**
 * kimi-web-tools — End-to-End Integration Tests for Gateway Server, MCP Server, and Hooks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
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

test("Kimi Code Hooks enforce off-mode gate and required-mode stop turn steer", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-hooks-"));
  const env = { ...process.env, KIMI_CODE_HOME: tmpHome };
  const webToolsDir = path.join(tmpHome, "web-tools");
  fs.mkdirSync(webToolsDir, { recursive: true });

  try {
    const modeStatePath = path.join(webToolsDir, "mode-state.json");

    // Case 1: Mode = "off" -> PreToolUse blocks web_search with exit code 2
    fs.writeFileSync(
      modeStatePath,
      JSON.stringify({ globalMode: "off", sessions: {}, updatedAt: Date.now() }),
      "utf8",
    );

    const promptResOff = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "user-prompt-submit.mjs")],
      {
        input: JSON.stringify({ session_id: "s-off", prompt: "hello" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(promptResOff.status, 0);
    assert.match(promptResOff.stdout, /Web search is switched OFF/);

    const preToolOff = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "pre-tool-gate.mjs")],
      {
        input: JSON.stringify({ session_id: "s-off", tool_name: "mcp__web__web_search", tool_call_id: "c1" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(preToolOff.status, 2, "PreToolUse must exit 2 when mode is off");
    assert.match(preToolOff.stderr, /Web search is switched OFF/);

    // Case 2: Mode = "required" -> Stop steers once if no web tool called, then allows after web tool called
    fs.writeFileSync(
      modeStatePath,
      JSON.stringify({ globalMode: "required", sessions: {}, updatedAt: Date.now() }),
      "utf8",
    );

    const promptResReq = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "user-prompt-submit.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", prompt: "latest news" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(promptResReq.status, 0);
    assert.match(promptResReq.stdout, /Web Search is required for this turn/);

    // Stop before any web tool call -> exits 2 with correction steer
    const stopBeforeResearch = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "stop-turn-gate.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", agent_id: "main" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(stopBeforeResearch.status, 2, "Stop hook must exit 2 when required research has not run");
    assert.match(stopBeforeResearch.stderr, /Call web_search or web_fetch before finalizing/);

    // Second Stop without research -> does not infinite-loop (correctionCount === 1)
    const stopSecondTime = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "stop-turn-gate.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", agent_id: "main" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(stopSecondTime.status, 0, "Stop hook must not loop after one correction steer");

    // New turn where actual search completion is recorded -> Stop exits 0 immediately
    spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "user-prompt-submit.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", prompt: "turn 2" }),
        env,
        encoding: "utf8",
      },
    );
    const preToolReq = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "pre-tool-gate.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", tool_name: "web_search", tool_call_id: "c2" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(preToolReq.status, 0);

    // Simulate gateway completing the search tool call
    const docAfterPre = JSON.parse(fs.readFileSync(modeStatePath, "utf8"));
    docAfterPre.sessions["s-req"].turn.webSearchCompleted = true;
    docAfterPre.sessions["s-req"].turn.webSearchSucceeded = true;
    fs.writeFileSync(modeStatePath, JSON.stringify(docAfterPre, null, 2), "utf8");

    const stopAfterResearch = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "stop-turn-gate.mjs")],
      {
        input: JSON.stringify({ session_id: "s-req", agent_id: "main" }),
        env,
        encoding: "utf8",
      },
    );
    assert.equal(stopAfterResearch.status, 0, "Stop hook must exit 0 after web_search was called");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Stdio MCP Server responds to initialize and tools/list", async () => {
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");

    const deadline = Date.now() + 3000;
    while (responses.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, "kimi-web-tools");

    assert.equal(responses[1].id, 2);
    const toolNames = responses[1].result.tools.map((t: any) => t.name);
    assert.deepEqual(toolNames, ["web_search", "web_fetch", "web_mode", "web_status"]);
  } finally {
    child.kill();
  }
});
