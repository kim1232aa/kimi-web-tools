#!/usr/bin/env node
/**
 * kimi-web-tools — Gateway Daemon CLI & Lifecycle Manager.
 *
 * Usage:
 *   node ./bin/gateway-daemon.mjs              # Start in foreground (default)
 *   node ./bin/gateway-daemon.mjs --serve      # Start in foreground
 *   node ./bin/gateway-daemon.mjs --daemon     # Spawn detached background daemon & wait until healthy
 *   node ./bin/gateway-daemon.mjs ensure       # Ensure daemon is running (spawn if needed)
 *   node ./bin/gateway-daemon.mjs status       # Print gateway status JSON
 *   node ./bin/gateway-daemon.mjs stop         # Stop running daemon
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = process.env.KIMI_WEB_TOOLS_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.KIMI_WEB_TOOLS_PORT || 18492);

function getWebToolsDir() {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  const home = explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), ".kimi-code");
  return path.join(home, "web-tools");
}

function getGatewayJsonPath() {
  return path.join(getWebToolsDir(), "gateway.json");
}

function resolveNodeExecutable() {
  const candidates = ["/usr/bin/node", "/usr/local/bin/node"];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function readNineRouterFallbackEnv() {
  const out = {};
  if (!process.env.NINEROUTER_KEY?.trim()) {
    const home = process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), ".kimi-code");
    const mcpPath = path.join(home, "mcp.json");
    if (fs.existsSync(mcpPath)) {
      try {
        const mcpDoc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
        const nrEnv = mcpDoc?.mcpServers?.["9router"]?.env;
        if (nrEnv && typeof nrEnv === "object") {
          if (typeof nrEnv.NINEROUTER_URL === "string" && nrEnv.NINEROUTER_URL.trim() && !process.env.NINEROUTER_URL) {
            out.NINEROUTER_URL = nrEnv.NINEROUTER_URL.trim();
          }
          if (typeof nrEnv.NINEROUTER_KEY === "string" && nrEnv.NINEROUTER_KEY.trim()) {
            out.NINEROUTER_KEY = nrEnv.NINEROUTER_KEY.trim();
          }
        }
      } catch {}
    }
  }
  if (!process.env.KIMI_WEB_TOOLS_PASSWORD?.trim()) {
    const pwPath = path.join(getWebToolsDir(), "public-password");
    if (fs.existsSync(pwPath)) {
      try {
        const pw = fs.readFileSync(pwPath, "utf8").trim();
        if (pw) out.KIMI_WEB_TOOLS_PASSWORD = pw;
      } catch {}
    }
  }
  return out;
}

function readGatewayJson() {
  const filePath = getGatewayJsonPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeGatewayJson(handle) {
  const directory = getWebToolsDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = getGatewayJsonPath();
  const state = {
    pid: process.pid,
    host: handle.host,
    port: handle.port,
    internalPort: handle.internalPort,
    url: handle.url,
    startedAt: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function clearGatewayJson(onlyPid) {
  const filePath = getGatewayJsonPath();
  if (!fs.existsSync(filePath)) return;
  if (onlyPid !== undefined) {
    const current = readGatewayJson();
    if (current && current.pid !== onlyPid) return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

async function checkGatewayHealth(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500, internalPort) {
  const internalUrl = Number.isInteger(internalPort) && internalPort > 0
    ? `http://127.0.0.1:${internalPort}`
    : undefined;
  const publicUrl = `http://${host}:${port}`;
  const url = `${internalUrl || publicUrl}/health`;
  const headers = { accept: "application/json" };
  if (!internalUrl && process.env.KIMI_WEB_TOOLS_PASSWORD) {
    headers.authorization = `Bearer ${process.env.KIMI_WEB_TOOLS_PASSWORD}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.ok === true && json.value?.status === "healthy") {
      return {
        healthy: true,
        host,
        port,
        url: publicUrl,
        ...(internalUrl ? { internalUrl } : {}),
        version: json.value.version,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadGatewayModule() {
  const compiledPath = path.join(PROJECT_ROOT, "lib", "host", "gateway-server.js");
  if (fs.existsSync(compiledPath)) {
    return import(pathToFileURL(compiledPath).href);
  }
  const tsPath = path.join(PROJECT_ROOT, "src", "host", "gateway-server.ts");
  return import(pathToFileURL(tsPath).href);
}

async function runForeground(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const fallbackEnv = readNineRouterFallbackEnv();
  for (const [k, v] of Object.entries(fallbackEnv)) {
    if (!process.env[k]) process.env[k] = v;
  }

  const saved = readGatewayJson();
  const hasLocalListener = saved?.host === host && saved?.port === port && Number.isInteger(saved?.internalPort);
  const existing = hasLocalListener
    ? await checkGatewayHealth(host, port, 1500, saved.internalPort)
    : null;
  if (existing) {
    console.log(JSON.stringify({ status: "already-running", ...existing }));
    return;
  }
  const { startGatewayServer } = await loadGatewayModule();
  const handle = await startGatewayServer({ host, port });
  try {
    writeGatewayJson(handle);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  const shutdown = async () => {
    try {
      await handle.close();
    } catch {}
    clearGatewayJson(process.pid);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    JSON.stringify({
      status: "started",
      pid: process.pid,
      host: handle.host,
      port: handle.port,
      url: handle.url,
    }),
  );
}

export async function ensureGatewayDaemon(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const saved = readGatewayJson();
  const checkHost = saved?.host || host;
  const checkPort = saved?.port || port;
  const internalPort = Number.isInteger(saved?.internalPort) ? saved.internalPort : undefined;

  const health = internalPort
    ? await checkGatewayHealth(checkHost, checkPort, 1500, internalPort)
    : null;
  if (health) {
    return {
      status: "running",
      pid: saved?.pid,
      ...health,
      publicUrl: health.url,
      url: health.internalUrl,
    };
  }

  const dataDir = getWebToolsDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDir, "gateway.log");
  const outFd = fs.openSync(logPath, "a");

  const nodeBin = resolveNodeExecutable();
  const compiledEntry = path.join(PROJECT_ROOT, "lib", "host", "gateway-server.js");
  const nodeArgs = fs.existsSync(compiledEntry)
    ? [fileURLToPath(import.meta.url), "--serve"]
    : ["--experimental-strip-types", fileURLToPath(import.meta.url), "--serve"];

  const fallbackEnv = readNineRouterFallbackEnv();
  const child = spawn(nodeBin, nodeArgs, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: {
      ...fallbackEnv,
      ...process.env,
      KIMI_WEB_TOOLS_HOST: host,
      KIMI_WEB_TOOLS_PORT: String(port),
    },
  });
  child.unref();
  try {
    fs.closeSync(outFd);
  } catch {}

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const updated = readGatewayJson();
    if (!Number.isInteger(updated?.internalPort)) continue;
    const ready = await checkGatewayHealth(host, port, 1500, updated.internalPort);
    if (ready) {
      return {
        status: "spawned",
        pid: updated?.pid ?? child.pid,
        ...ready,
        publicUrl: ready.url,
        url: ready.internalUrl,
      };
    }
  }

  throw new Error(`Gateway daemon failed to become healthy on http://${host}:${port} within 8s`);
}

async function stopGatewayDaemon() {
  const saved = readGatewayJson();
  if (saved?.pid) {
    try {
      process.kill(saved.pid, "SIGTERM");
    } catch {}
  }
  clearGatewayJson();
  return { status: "stopped", pid: saved?.pid ?? null };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "--serve";

  if (cmd === "status" || cmd === "--status") {
    const saved = readGatewayJson();
    const health = await checkGatewayHealth(saved?.host || DEFAULT_HOST, saved?.port || DEFAULT_PORT, 1500, saved?.internalPort);
    console.log(
      JSON.stringify(
        {
          running: Boolean(health),
          pid: saved?.pid ?? null,
          ...(health || { host: DEFAULT_HOST, port: DEFAULT_PORT, url: `http://${DEFAULT_HOST}:${DEFAULT_PORT}` }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "stop" || cmd === "--stop") {
    const res = await stopGatewayDaemon();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "ensure" || cmd === "--daemon" || cmd === "start-daemon") {
    const res = await ensureGatewayDaemon(DEFAULT_HOST, DEFAULT_PORT);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  await runForeground(DEFAULT_HOST, DEFAULT_PORT);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("[kimi-web-tools gateway-daemon]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
