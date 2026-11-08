import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  NineRouterClient,
  NineRouterError,
  type NineRouterClientOptions,
} from "./9router-client.ts";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 18492;
export const GATEWAY_VERSION = "0.4.0";

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  upstreamUrl?: string;
  upstreamKey?: string;
  searchModel?: string;
  fetchModel?: string;
  upstreamTimeoutMs?: number;
  enableFetch?: boolean;
}

export interface GatewayServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly internalPort: number;
  readonly internalUrl: string;
  readonly server: http.Server;
  close(): Promise<void>;
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function hasValidBearer(req: http.IncomingMessage, password: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || authorization.slice(0, 7).toLowerCase() !== "bearer ") return false;
  const provided = Buffer.from(authorization.slice(7).trim(), "utf8");
  const expected = Buffer.from(password, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function listenOn(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (raw.length > 1_000_000) throw new Error("payload too large");
  }
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function errorResponse(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof NineRouterError) {
    if (error.message.includes("NINEROUTER_KEY is not configured")) {
      return { status: 503, code: "upstream-not-configured", message: error.message };
    }
    return { status: 502, code: "upstream-error", message: error.message };
  }
  return {
    status: 500,
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function startGatewayServer(options: GatewayServerOptions = {}): Promise<GatewayServerHandle> {
  const host = options.host ?? process.env.KIMI_WEB_TOOLS_HOST ?? DEFAULT_GATEWAY_HOST;
  const requestedPort = options.port ?? readPort(process.env.KIMI_WEB_TOOLS_PORT, DEFAULT_GATEWAY_PORT);
  const enableFetch = options.enableFetch ?? isEnabled(process.env.KIMI_WEB_TOOLS_ENABLE_FETCH, true);
  const clientOptions: NineRouterClientOptions = {
    ...(options.upstreamUrl !== undefined ? { baseUrl: options.upstreamUrl } : {}),
    ...(options.upstreamKey !== undefined ? { apiKey: options.upstreamKey } : {}),
    ...(options.searchModel !== undefined ? { searchModel: options.searchModel } : {}),
    ...(options.fetchModel !== undefined ? { fetchModel: options.fetchModel } : {}),
    ...(options.upstreamTimeoutMs !== undefined ? { timeoutMs: options.upstreamTimeoutMs } : {}),
  };
  const client = new NineRouterClient(clientOptions);
  const password = process.env.KIMI_WEB_TOOLS_PASSWORD?.trim();

  const requestHandler = (internal: boolean) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (!internal) {
        if (!password) {
          writeJson(res, 503, {
            ok: false,
            error: {
              code: "auth-not-configured",
              message: "Set KIMI_WEB_TOOLS_PASSWORD to enable public gateway access",
            },
          });
          return;
        }
        if (!hasValidBearer(req, password)) {
          writeJson(
            res,
            401,
            { ok: false, error: { code: "unauthorized", message: "A valid bearer password is required" } },
            { "www-authenticate": "Bearer" },
          );
          return;
        }
      }

      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;
      if (req.method === "GET" && (pathname === "/health" || pathname === "/web-tools/health")) {
        writeJson(res, 200, {
          ok: true,
          value: {
            status: "healthy",
            version: GATEWAY_VERSION,
            pid: process.pid,
            available: Boolean(client.apiKey),
            upstream: client.baseUrl,
            tools: ["web_search", ...(enableFetch ? ["web_fetch"] : [])],
          },
        });
        return;
      }

      if (req.method !== "POST" || !pathname.startsWith("/web-tools/mcp/")) {
        writeJson(res, 404, { ok: false, error: { code: "not-found", message: `Not found: ${pathname}` } });
        return;
      }

      const action = pathname.slice("/web-tools/mcp/".length);
      if (action !== "search" && action !== "fetch") {
        writeJson(res, 404, { ok: false, error: { code: "not-found", message: `Unknown MCP endpoint: ${action}` } });
        return;
      }
      if (action === "fetch" && !enableFetch) {
        writeJson(res, 404, { ok: false, error: { code: "fetch-disabled", message: "web_fetch is disabled" } });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = await readJsonBody(req);
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }

      if (action === "search") {
        const query = typeof payload.query === "string" ? payload.query.trim() : "";
        if (!query) {
          writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "query is required" } });
          return;
        }
        const rawMaxResults = payload.maxResults ?? payload.max_results;
        const maxResults = typeof rawMaxResults === "number" ? rawMaxResults : 8;
        const started = Date.now();
        try {
          const result = await client.search(query, maxResults);
          writeJson(res, 200, { ok: true, value: { ...result, latencyMs: Date.now() - started } });
        } catch (error) {
          const failure = errorResponse(error);
          writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
        }
        return;
      }

      const url = typeof payload.url === "string" ? payload.url.trim() : "";
      if (!url) {
        writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "url is required" } });
        return;
      }
      const started = Date.now();
      try {
        const result = await client.fetch(url);
        writeJson(res, 200, { ok: true, value: { ...result, latencyMs: Date.now() - started } });
      } catch (error) {
        const failure = errorResponse(error);
        writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } });
      }
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const server = http.createServer(requestHandler(false));
  const internalServer = http.createServer(requestHandler(true));
  try {
    await listenOn(internalServer, 0, "127.0.0.1");
    await listenOn(server, requestedPort, host);
  } catch (error) {
    await Promise.all([closeServer(server), closeServer(internalServer)]);
    throw error;
  }

  const publicAddress = server.address();
  const actualPort = typeof publicAddress === "object" && publicAddress ? publicAddress.port : requestedPort;
  const internalAddress = internalServer.address();
  const internalPort = typeof internalAddress === "object" && internalAddress ? internalAddress.port : 0;
  const url = `http://${host}:${actualPort}`;
  const internalUrl = `http://127.0.0.1:${internalPort}`;

  return {
    host,
    port: actualPort,
    url,
    internalPort,
    internalUrl,
    server,
    async close() {
      await Promise.all([closeServer(server), closeServer(internalServer)]);
    },
  };
}
