import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureGatewayDaemon } from "../bin/gateway-daemon.mjs";
import { startGatewayServer } from "../src/host/gateway-server.ts";

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function nonLoopbackIpv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

test("public gateway fails closed without a password while its loopback listener remains usable", async () => {
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  delete process.env.KIMI_WEB_TOOLS_PASSWORD;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-gw-auth-"));
  const handle = await startGatewayServer({ host: "127.0.0.1", port: 0, baseDir });

  try {
    const publicResponse = await fetch(`${handle.url}/health`);
    assert.equal(publicResponse.status, 503);
    assert.equal((await publicResponse.json() as any).error.code, "auth-not-configured");

    assert.match(handle.internalUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const internalResponse = await fetch(`${handle.internalUrl}/health`);
    assert.equal(internalResponse.status, 200);

    const localApiResponse = await fetch(`${handle.internalUrl}/web-tools/api/config/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(localApiResponse.status, 200);
  } finally {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
  }
});

test("public gateway requires a bearer password and accepts it for protected APIs", async () => {
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  process.env.KIMI_WEB_TOOLS_PASSWORD = "public-gateway-test-secret";
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-gw-auth-"));
  const handle = await startGatewayServer({ host: "0.0.0.0", port: 0, baseDir });
  const publicUrl = nonLoopbackIpv4()
    ? `http://${nonLoopbackIpv4()}:${handle.port}`
    : handle.url;

  try {
    const missingPassword = await fetch(`${publicUrl}/health`);
    assert.equal(missingPassword.status, 401);
    assert.equal(missingPassword.headers.get("www-authenticate"), "Bearer");

    const wrongPassword = await fetch(`${publicUrl}/health`, {
      headers: { authorization: "Bearer wrong-secret" },
    });
    assert.equal(wrongPassword.status, 401);

    const authorizedApi = await fetch(`${publicUrl}/web-tools/api/config/get`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer public-gateway-test-secret",
      },
      body: "{}",
    });
    assert.equal(authorizedApi.status, 200);
    assert.equal((await authorizedApi.json() as any).ok, true);
  } finally {
    await handle.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
  }
});

test("daemon health checks and local gateway calls use the private listener", async () => {
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-daemon-auth-"));
  process.env.KIMI_CODE_HOME = home;
  delete process.env.KIMI_WEB_TOOLS_PASSWORD;
  const port = await availablePort();

  try {
    const gateway = await ensureGatewayDaemon("127.0.0.1", port);
    assert.equal(gateway.status, "spawned");
    assert.equal(gateway.url, gateway.internalUrl);
    assert.notEqual(gateway.internalPort, port);

    const localCall = await fetch(`${gateway.url}/web-tools/mcp/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    });
    assert.equal(localCall.status, 200);
  } finally {
    const statePath = path.join(home, "web-tools", "gateway.json");
    if (fs.existsSync(statePath)) {
      try {
        process.kill(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, "SIGTERM");
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
  }
});
