import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "../src/host/gateway-server.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t: any) {
  const parent = path.join(root, "temp", "mcp-lifecycle");
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function runNode(args: string[], env: NodeJS.ProcessEnv, input = "") {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  child.stdin.write(input);
  setTimeout(() => child.stdin.end(), input.includes('"method":"initialize"') ? 300 : 0);
  try {
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayFixture(t: any, slowVersion = false) {
  const home = fixture(t);
  const requests: { url: string; method: string; body: any }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined });
    if (slowVersion && req.url === "/web-tools/api/version/check") {
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
    res.setHeader("content-type", "application/json");
    const value = req.url === "/health"
      ? { status: "healthy", version: "0.4.0", pid: process.pid, available: true }
      : req.url === "/web-tools/api/version/check"
        ? { currentVersion: "0.4.0" }
        : { query: "fixture", sources: [], body: { content: "x".repeat(1024 * 1024) }, url: "https://example.com", statusCode: 200 };
    res.end(JSON.stringify({ ok: true, value }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port;
  return { home, requests, env: { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(port) } };
}

const rpc = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

test("daemon status probes local health without waiting for release lookup", async (t) => {
  const { env, requests } = await gatewayFixture(t, true);
  const result = await runNode(["bin/gateway-daemon.mjs", "status"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).running, true);
  assert.deepEqual(requests.map(r => [r.method, r.url]), [["GET", "/health"]]);
});

test("MCP handshake does not launch a daemon before any tool is called", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env, rpc(1, "initialize") + rpc(2, "tools/list"));
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, 2);
  for (const tool of replies.find(reply => reply.id === 2).result.tools) {
    if (!["web_search", "web_fetch"].includes(tool.name)) continue;
    assert.ok(tool.inputSchema.properties.turn_id.type.includes("string"));
    assert.ok(tool.inputSchema.properties.turn_id.type.includes("integer"));
  }
  assert.equal(requests.length, 0);
});

test("MCP accepts bounded decimal strings and forwards numeric arguments", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_search", arguments: { query: "fixture", max_results: "2", session_id: "session-a", turn_id: "7" } }));
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(JSON.parse(result.stdout).result.isError, true, result.stdout);
  assert.deepEqual(requests.find(r => r.url.endsWith("/search"))?.body,
    { query: "fixture", maxResults: 2, sessionId: "session-a", turnId: 7 });
});

test("invalid numeric inputs fail without launching a gateway", async (t) => {
  const { env, requests } = await gatewayFixture(t);
  const invalid = ["", " ", "1e1", "0x10", "1.5", "0", "-1", true, [], null, 1.5, 9007199254740992];
  const input = invalid.map((turn_id, i) => rpc(i + 1, "tools/call", {
    name: "web_fetch", arguments: { url: "https://example.com", turn_id },
  })).join("") + rpc(99, "tools/call", { name: "web_search", arguments: { query: "fixture", max_results: 21 } });
  const result = await runNode(["bin/mcp-server.mjs"], env, input);
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.length, invalid.length + 1);
  for (const reply of replies) assert.equal(reply.result.isError, true, JSON.stringify(reply));
  assert.equal(requests.length, 0);
});

test("EOF drains a large in-flight MCP response before exiting", async (t) => {
  const { env } = await gatewayFixture(t);
  const result = await runNode(["bin/mcp-server.mjs"], env,
    rpc(1, "tools/call", { name: "web_fetch", arguments: { url: "https://example.com" } }));
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.notEqual(response.result.isError, true, result.stdout.slice(0, 300));
  assert.ok(response.result.content[0].text.endsWith("x".repeat(1024 * 1024)));
});

test("startup reports a child import failure instead of an eight-second health timeout", async (t) => {
  const home = fixture(t);
  const isolated = path.join(home, "plugin");
  fs.mkdirSync(path.join(isolated, "bin"), { recursive: true });
  fs.mkdirSync(path.join(isolated, "lib", "host"), { recursive: true });
  fs.copyFileSync(path.join(root, "bin/gateway-daemon.mjs"), path.join(isolated, "bin/gateway-daemon.mjs"));
  fs.writeFileSync(path.join(isolated, "lib/host/gateway-server.js"), 'throw new Error("test startup import failure");\n');
  const portServer = http.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as any).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const started = Date.now();
  const result = await runNode([path.join(isolated, "bin/gateway-daemon.mjs"), "ensure"], {
    ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(port),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited|exit code/i);
  assert.match(result.stderr, /gateway\.log/);
  assert.ok(Date.now() - started < 4000, result.stderr);
});

test("required hook accepts numeric strings but rejects invalid and stale turns", (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "mode-state.json"), JSON.stringify({ globalMode: "required", sessions: {}, updatedAt: 0 }));
  const hook = (file: string, payload: object) => spawnSync(process.execPath, [path.join(root, "hooks", file)], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: JSON.stringify(payload), encoding: "utf8",
  });
  assert.equal(hook("user-prompt-submit.mjs", { session_id: "session-a" }).status, 0);
  for (const turn_id of [1, "1"]) {
    const pre = hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name: "web_search",
      tool_input: { query: "fixture", session_id: "session-a", turn_id } });
    assert.equal(pre.status, 0, pre.stderr);
  }
  for (const turn_id of [undefined, null, true, "", " ", "1e0", 2, "2"]) {
    assert.equal(hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name: "web_search",
      tool_input: { query: "fixture", session_id: "session-a", turn_id } }).status, 2);
  }
  const stop = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /turn_id=1/);
});

test("a dead lock owner is reclaimed without losing existing session state", async (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  const statePath = path.join(dir, "mode-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ globalMode: "required", sessions: { existing: { mode: "off" } }, updatedAt: 0 }));
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = owner.pid!;
  await once(owner, "exit");
  fs.writeFileSync(`${statePath}.lock`, String(deadPid));
  const result = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: JSON.stringify({ session_id: "new-session" }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(doc.sessions.existing.mode, "off");
  assert.equal(doc.sessions["new-session"].turn.turn, 1);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
});

test("a live lock is not stolen just because it is old", (t) => {
  const home = fixture(t);
  const dir = path.join(home, "web-tools");
  fs.mkdirSync(dir);
  const lock = path.join(dir, "mode-state.json.lock");
  fs.writeFileSync(lock, String(process.pid));
  fs.utimesSync(lock, new Date(0), new Date(0));
  const result = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
    env: { ...process.env, KIMI_CODE_HOME: home }, input: '{"session_id":"session-a"}', encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Timed out/);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("gateway requires explicit current-turn binding without borrowing another session", async (t) => {
  const home = fixture(t);
  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir: path.join(home, "web-tools"), projectRoot: root });
  t.after(() => handle.close());
  handle.storage.setSessionMode("global", "required");
  const env = { ...process.env, KIMI_CODE_HOME: home, KIMI_WEB_TOOLS_PORT: String(handle.port) };
  for (const session_id of ["session-a", "session-b"]) {
    const prompt = spawnSync(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
      env, input: JSON.stringify({ session_id }), encoding: "utf8",
    });
    assert.equal(prompt.status, 0, prompt.stderr);
  }
  for (const binding of [{}, { sessionId: "session-a" }, { sessionId: "session-a", turnId: 2 }, { sessionId: "missing", turnId: 1 }]) {
    const response = await fetch(`${handle.url}/web-tools/mcp/fetch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/private", ...binding }),
    });
    assert.equal(response.status, 400, await response.text());
  }
  assert.equal(handle.storage.getTurnState("session-a")!.webFetchCompleted, false);
  const result = await runNode(["bin/mcp-server.mjs"], env, rpc(1, "tools/call", {
    name: "web_fetch", arguments: { url: "http://127.0.0.1/private", session_id: "session-a", turn_id: "1" },
  }) + rpc(2, "ping"));
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1).result.isError, true);
  assert.deepEqual(replies.find(reply => reply.id === 2).result, {});
  assert.equal(handle.storage.getTurnState("session-a")!.webFetchCompleted, true);
  assert.equal(handle.storage.getTurnState("session-a")!.webFetchSucceeded, false);
  assert.equal(handle.storage.getTurnState("session-b")!.webFetchCompleted, false);
});

test("daemon reports spawn error events without uncaught process errors", async (t) => {
  const home = fixture(t);
  const result = await runNode(["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import { EventEmitter } from 'node:events';
    cp.spawn = () => {
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('error', Object.assign(new Error('test EACCES'), {code:'EACCES'})));
      return child;
    };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    globalThis.fetch = async () => { throw Object.assign(new Error('offline'), {cause:{code:'ECONNREFUSED'}}); };
    const { ensureGatewayDaemon } = await import('./bin/gateway-daemon.mjs');
    try { await ensureGatewayDaemon(); process.exitCode = 2; }
    catch (error) { console.log(error.message); }
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /spawn failed.*EACCES/i);
  assert.doesNotMatch(result.stderr, /Unhandled.*error/);
});

test("daemon does not invoke a non-Node host executable when Node cannot be found", async (t) => {
  const home = fixture(t);
  const result = await runNode(["--input-type=module", "-e", `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    Object.defineProperty(process, 'execPath', {value:'/missing/kimi'});
    fs.existsSync = () => false;
    fs.accessSync = () => { throw Object.assign(new Error('missing'), {code:'ENOENT'}); };
    cp.spawn = () => { throw new Error('must not spawn the host binary'); };
    const { syncBuiltinESMExports } = await import('node:module'); syncBuiltinESMExports();
    globalThis.fetch = async () => { throw Object.assign(new Error('offline'), {cause:{code:'ECONNREFUSED'}}); };
    const { ensureGatewayDaemon } = await import('./bin/gateway-daemon.mjs');
    try { await ensureGatewayDaemon(); process.exitCode = 2; }
    catch (error) { console.log(error.message); }
  `], { ...process.env, KIMI_CODE_HOME: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Node\.js executable not found/);
});
