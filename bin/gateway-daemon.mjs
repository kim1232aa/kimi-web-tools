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

function readGatewayJson() {
  const filePath = getGatewayJsonPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function checkGatewayHealth(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500) {
  const url = `http://${host}:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Gateway health ${url}: HTTP ${res.status}`);
    const json = await res.json();
    if (json?.ok === true && json.value?.status === "healthy" && typeof json.value.version === "string" && Number.isSafeInteger(json.value.pid)) {
      return {
        healthy: true,
        host,
        port,
        url: `http://${host}:${port}`,
        version: json.value.version,
        pid: json.value.pid,
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
  const existing = await checkGatewayHealth(host, port);
  if (existing) {
    console.log(JSON.stringify({ status: "already-running", ...existing }));
    return;
  }
  const { startGatewayServer } = await loadGatewayModule();
  const handle = await startGatewayServer({
    host,
    port,
    projectRoot: PROJECT_ROOT,
  });

  const shutdown = async () => {
    try {
      await handle.close();
    } catch {}
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

function resolveNodeExecutable() {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    ...(/^(node|nodejs)(\.exe)?$/i.test(path.basename(process.execPath)) ? [process.execPath] : []),
    ...((process.env.PATH || "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))),
    "/usr/bin/node", "/usr/local/bin/node",
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("Node.js executable not found on PATH; cannot start gateway (refusing to invoke the Kimi host binary).");
}

export async function ensureGatewayDaemon(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const saved = readGatewayJson();
  const checkHost = saved?.host || host;
  const checkPort = saved?.port || port;

  const health = await checkGatewayHealth(checkHost, checkPort);
  if (health) {
    return { status: "running", pid: saved?.pid, ...health };
  }

  const dataDir = getWebToolsDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dataDir, "gateway.log");
  const outFd = fs.openSync(logPath, "a");

  const compiledEntry = path.join(PROJECT_ROOT, "lib", "host", "gateway-server.js");
  const nodeArgs = fs.existsSync(compiledEntry)
    ? [fileURLToPath(import.meta.url), "--serve"]
    : ["--experimental-strip-types", fileURLToPath(import.meta.url), "--serve"];

  let child;
  let spawnError;
  try {
    child = spawn(resolveNodeExecutable(), nodeArgs, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: {
        ...process.env,
        KIMI_WEB_TOOLS_HOST: host,
        KIMI_WEB_TOOLS_PORT: String(port),
      },
    });
    child.on("error", error => { spawnError = error; });
    child.unref();
  } finally {
    fs.closeSync(outFd);
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (spawnError) throw new Error(`Gateway spawn failed: ${spawnError.message}; log: ${logPath}`, { cause: spawnError });
    const ready = await checkGatewayHealth(host, port);
    if (ready) return { status: "spawned", ...ready };
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Gateway exited before becoming healthy (exit code ${child.exitCode}, signal ${child.signalCode}); log: ${logPath}`);
    }
  }

  throw new Error(`Gateway daemon failed to become healthy on http://${host}:${port} within 8s; log: ${logPath}`);
}

async function stopGatewayDaemon() {
  const saved = readGatewayJson();
  if (saved?.pid) {
    try {
      process.kill(saved.pid, "SIGTERM");
    } catch {}
  }
  const gwPath = getGatewayJsonPath();
  if (fs.existsSync(gwPath)) {
    try {
      fs.unlinkSync(gwPath);
    } catch {}
  }
  return { status: "stopped", pid: saved?.pid ?? null };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "--serve";

  if (cmd === "status" || cmd === "--status") {
    const saved = readGatewayJson();
    const health = await checkGatewayHealth(saved?.host || DEFAULT_HOST, saved?.port || DEFAULT_PORT);
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
