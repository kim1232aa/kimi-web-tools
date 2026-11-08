import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

async function startUpstream(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ provider: "agy-search", results: [{ url: "https://example.com" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as http.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function withTempHome<T>(run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.KIMI_CODE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-gateway-auth-"));
  process.env.KIMI_CODE_HOME = home;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("public gateway fails closed without a password while its loopback listener remains usable", async () => {
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  delete process.env.KIMI_WEB_TOOLS_PASSWORD;

  try {
    await withTempHome(async () => {
      const handle = await startGatewayServer({ host: "127.0.0.1", port: 0 });
      try {
        const publicResponse = await fetch(`${handle.url}/health`);
        assert.equal(publicResponse.status, 503);
        assert.equal((await publicResponse.json() as any).error.code, "auth-not-configured");

        assert.match(handle.internalUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
        const internalResponse = await fetch(`${handle.internalUrl}/health`);
        assert.equal(internalResponse.status, 200);
      } finally {
        await handle.close();
      }
    });
  } finally {
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
  }
});

test("public gateway requires a bearer password and accepts it for protected MCP calls", async () => {
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  process.env.KIMI_WEB_TOOLS_PASSWORD = "public-gateway-test-secret";
  const upstream = await startUpstream();

  try {
    await withTempHome(async () => {
      const handle = await startGatewayServer({
        host: "0.0.0.0",
        port: 0,
        upstreamUrl: upstream.url,
        upstreamKey: "gateway-upstream-key",
      });
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

        const authorizedCall = await fetch(`${publicUrl}/web-tools/mcp/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer public-gateway-test-secret",
          },
          body: JSON.stringify({ query: "protected search" }),
        });
        assert.equal(authorizedCall.status, 200);
        assert.equal((await authorizedCall.json() as any).ok, true);
      } finally {
        await handle.close();
      }
    });
  } finally {
    await upstream.close();
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
  }
});

test("daemon health checks and local gateway calls use the private listener", async () => {
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousPassword = process.env.KIMI_WEB_TOOLS_PASSWORD;
  const previousRouterUrl = process.env.NINEROUTER_URL;
  const previousRouterKey = process.env.NINEROUTER_KEY;
  const upstream = await startUpstream();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-daemon-auth-"));
  process.env.KIMI_CODE_HOME = home;
  process.env.NINEROUTER_URL = upstream.url;
  process.env.NINEROUTER_KEY = "daemon-upstream-key";
  delete process.env.KIMI_WEB_TOOLS_PASSWORD;
  const port = await availablePort();

  try {
    const gateway = await ensureGatewayDaemon("127.0.0.1", port);
    assert.equal(gateway.status, "spawned");
    assert.equal(gateway.url, gateway.internalUrl);
    assert.notEqual(gateway.internalPort, port);

    const localCall = await fetch(`${gateway.url}/web-tools/mcp/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "daemon search" }),
    });
    assert.equal(localCall.status, 200);
    assert.equal((await localCall.json() as any).value.sources[0].url, "https://example.com");
  } finally {
    const statePath = path.join(home, "web-tools", "gateway.json");
    if (fs.existsSync(statePath)) {
      try {
        process.kill(JSON.parse(fs.readFileSync(statePath, "utf8")).pid, "SIGTERM");
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await upstream.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousPassword === undefined) delete process.env.KIMI_WEB_TOOLS_PASSWORD;
    else process.env.KIMI_WEB_TOOLS_PASSWORD = previousPassword;
    if (previousRouterUrl === undefined) delete process.env.NINEROUTER_URL;
    else process.env.NINEROUTER_URL = previousRouterUrl;
    if (previousRouterKey === undefined) delete process.env.NINEROUTER_KEY;
    else process.env.NINEROUTER_KEY = previousRouterKey;
  }
});
