/**
 * kimi-web-tools — Standalone HTTP Gateway Server & Dashboard Host.
 *
 * Responsibilities:
 *  - Hosts the standalone Web UI Dashboard (`GET /`, `GET /app.js`, `GET /assets/*`).
 *  - Provides password authentication (`/web-tools/auth/session`, `login`, `logout`)
 *    for reverse-proxied public deployments while keeping direct local loopback
 *    calls from Kimi Code CLI/MCP seamless.
 *  - Mounts all management APIs (`POST /web-tools/api/*`) from `src/host/routes.ts`
 *    via `apply(ctx)` from `src/host/index.ts`.
 *  - Mounts internal MCP execution endpoints (`POST /web-tools/mcp/search`,
 *    `fetch`, `status`, `mode`).
 *  - Persists state in `$KIMI_CODE_HOME/web-tools/` via `LocalStorage`.
 * @module
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apply } from "./index.ts";
import {
  configPlaneTrust,
  isDirectLoopbackRequest,
  markGatewayAuthenticated,
  API_PREFIX,
} from "./routes.ts";
import { LocalStorage } from "./local-storage.ts";
import { positiveInteger } from "../../hooks/mode-state.mjs";
import { CURRENT_VERSION } from "../shared/version.ts";
import { nextSearchMode, type SearchMode } from "../shared/api-types.ts";
import {
  WEB_DISABLED_DENIAL,
  REQUIRED_SEARCH_CORRECTION_TEXT,
  SEARCH_DISABLED_TEXT,
  SEARCH_AUTO_TEXT,
  requiredSearchText,
} from "./search-mode-runtime.ts";
import type {
  WebToolsContext,
  WebToolsHttpRequest,
  WebToolsHttpResponse,
  WebToolsWebRoute,
} from "./context-types.ts";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 18492;
const AUTH_COOKIE_NAME = "kimi_wt_session";

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  baseDir?: string;
  projectRoot?: string;
  password?: string;
}

export interface GatewayServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly storage: LocalStorage;
  readonly server: http.Server;
  close(): Promise<void>;
}

function resolveProjectRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (raw.length > 1_000_000) throw new Error("payload too large");
  }
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function deriveSessionToken(password: string): string {
  return createHmac("sha256", password).update("kimi-web-tools-session-v1").digest("hex");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function resolveGatewayPassword(explicit: string | undefined, baseDir: string): string | undefined {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const envPw = process.env.KIMI_WEB_TOOLS_PASSWORD?.trim();
  if (envPw) return envPw;
  const pwFile = path.join(baseDir, "public-password");
  if (fs.existsSync(pwFile)) {
    try {
      const filePw = fs.readFileSync(pwFile, "utf8").trim();
      if (filePw) return filePw;
    } catch {}
  }
  return undefined;
}

function hasValidPasswordAuth(req: http.IncomingMessage, password: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.slice(0, 7).toLowerCase() === "bearer ") {
    const token = auth.slice(7).trim();
    if (token && safeEqual(token, password)) return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[AUTH_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    const expected = deriveSessionToken(password);
    if (safeEqual(cookieToken, expected)) return true;
  }
  return false;
}

export async function startGatewayServer(options: GatewayServerOptions = {}): Promise<GatewayServerHandle> {
  const host = options.host ?? process.env.KIMI_WEB_TOOLS_HOST ?? DEFAULT_GATEWAY_HOST;
  const requestedPort =
    options.port ??
    (process.env.KIMI_WEB_TOOLS_PORT ? Number(process.env.KIMI_WEB_TOOLS_PORT) : DEFAULT_GATEWAY_PORT);

  const projectRoot = resolveProjectRoot(options.projectRoot);
  const storage = new LocalStorage(options.baseDir);
  storage.ensureDir();

  const routes: WebToolsWebRoute[] = [];
  const disposers: Array<() => void> = [];

  let searchProvider: {
    id: string;
    available(): boolean;
    search(
      request: { query: string; maxResults?: number },
      signal?: AbortSignal,
    ): Promise<{
      content?: string;
      sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>;
      truncated: boolean;
    }>;
  } | null = null;

  let fetchProvider: {
    id: string;
    available(): boolean;
    fetch(
      request: { url: string },
      signal?: AbortSignal,
    ): Promise<{
      url: string;
      statusCode: number;
      body: { kind: "html" | "text"; content: string };
      truncated: boolean;
    }>;
  } | null = null;

  const settingsService = storage.createSettingsService();
  const credentialsService = storage.createCredentialsService();

  const ctx: WebToolsContext & { localStorage: LocalStorage } = {
    localStorage: storage,
    webServer: {
      host,
      port: requestedPort,
      register(route: WebToolsWebRoute) {
        routes.push(route);
        return () => {
          const idx = routes.indexOf(route);
          if (idx >= 0) routes.splice(idx, 1);
        };
      },
      registerUpgrade() {
        return () => {};
      },
    },
    settings: settingsService,
    credentials: credentialsService,
    web: {
      registerSearchProvider(p) {
        searchProvider = p;
        return () => {
          if (searchProvider === p) searchProvider = null;
        };
      },
      registerFetchProvider(p) {
        fetchProvider = p;
        return () => {
          if (fetchProvider === p) fetchProvider = null;
        };
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        disposers.push(cleanup);
      }
    },
    inject(_services, callback) {
      callback(ctx);
    },
    on() {
      return () => {};
    },
    get(name: string) {
      if (name === "settings") return settingsService;
      if (name === "credentials") return credentialsService;
      return undefined;
    },
    commands: {
      register() {
        return () => {};
      },
    },
  };

  // Mount the full Host plugin into our standalone context
  apply(ctx, storage.readConfig());

  // Helper to invoke a registered route internally (e.g. for /web-tools/mcp/status)
  async function callInternalApi(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const apiRoute = routes.find((r) => r.path === API_PREFIX);
    if (!apiRoute) throw new Error("API route not mounted");
    let statusCode = 200;
    let rawBody = "";
    const fakeReq: WebToolsHttpRequest & { socket: { remoteAddress: string } } = {
      url: `${API_PREFIX}/${method}`,
      method: "POST",
      headers: { host: "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify(payload);
      },
    };
    markGatewayAuthenticated(fakeReq);
    const fakeRes: WebToolsHttpResponse = {
      statusCode: 200,
      writeHead(s) {
        statusCode = s;
        this.statusCode = s;
      },
      end(b) {
        rawBody = typeof b === "string" ? b : b ? Buffer.from(b).toString("utf8") : "";
      },
    };
    await apiRoute.handler(fakeReq, fakeRes);
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    if (statusCode >= 400 || parsed?.ok === false) {
      throw new Error(parsed?.error?.message ?? `Internal API ${method} failed (${statusCode})`);
    }
    return parsed?.value;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;
      const wtReq = req as unknown as WebToolsHttpRequest;

      // 1. Static UI assets (`GET /`, `GET /index.html`, `GET /app.js`, `GET /assets/*`)
      // Always allow loading the static shell so the browser can render the login screen or dashboard.
      if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/" || pathname === "/index.html")) {
        const htmlCandidates = [
          path.join(projectRoot, "dist", "client", "index.html"),
          path.join(projectRoot, "src", "client", "index.html"),
        ];
        const htmlPath = htmlCandidates.find((p) => fs.existsSync(p));
        if (!htmlPath) {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "index.html not found" } });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(fs.readFileSync(htmlPath));
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && pathname === "/app.js") {
        const jsPath = path.join(projectRoot, "dist", "client", "app.js");
        if (!fs.existsSync(jsPath)) {
          writeJson(res, 404, {
            ok: false,
            error: { code: "not-found", message: "dist/client/app.js not built yet; run node build-client.mjs" },
          });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(fs.readFileSync(jsPath));
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/assets/")) {
        const rel = pathname.slice("/assets/".length);
        const safePath = path.resolve(projectRoot, "assets", rel);
        const assetsRoot = path.resolve(projectRoot, "assets");
        if (!safePath.startsWith(assetsRoot + path.sep) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
          writeJson(res, 404, { ok: false, error: { code: "not-found", message: "asset not found" } });
          return;
        }
        res.writeHead(200, { "content-type": contentTypeFor(safePath) });
        res.end(fs.readFileSync(safePath));
        return;
      }

      // 2. Authentication state & login/logout endpoints (`/web-tools/auth/*`)
      const password = resolveGatewayPassword(options.password, storage.baseDir);
      const directLocal = isDirectLoopbackRequest(wtReq) && process.env.KIMI_WEB_TOOLS_REQUIRE_AUTH !== "1";
      const passwordAuthed = password ? hasValidPasswordAuth(req, password) : false;
      const isAuthed = directLocal || passwordAuthed;

      if (pathname === "/web-tools/auth/session" && (req.method === "GET" || req.method === "POST")) {
        writeJson(res, 200, {
          ok: true,
          value: {
            authenticated: isAuthed,
            required: !directLocal,
            passwordConfigured: Boolean(password),
          },
        });
        return;
      }

      if (pathname === "/web-tools/auth/login" && req.method === "POST") {
        if (!password) {
          writeJson(res, 503, {
            ok: false,
            error: { code: "auth-not-configured", message: "Gateway password is not configured" },
          });
          return;
        }
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const candidate = typeof body.password === "string" ? body.password.trim() : "";
        if (!candidate || !safeEqual(candidate, password)) {
          writeJson(res, 401, {
            ok: false,
            error: { code: "unauthorized", message: "访问密码错误" },
          });
          return;
        }
        const token = deriveSessionToken(password);
        const isHttps = req.headers["x-forwarded-proto"] === "https";
        const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? "; Secure" : ""}`;
        writeJson(res, 200, { ok: true, value: { authenticated: true } }, { "set-cookie": cookie });
        return;
      }

      if (pathname === "/web-tools/auth/logout" && req.method === "POST") {
        const cookie = `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
        writeJson(res, 200, { ok: true, value: { authenticated: false } }, { "set-cookie": cookie });
        return;
      }

      // 3. Enforce authentication for all API, MCP, and health endpoints
      if (!isAuthed) {
        if (!password) {
          writeJson(res, 503, {
            ok: false,
            error: { code: "auth-not-configured", message: "Set KIMI_WEB_TOOLS_PASSWORD or public-password to enable public access" },
          });
          return;
        }
        writeJson(
          res,
          401,
          { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
          { "www-authenticate": "Bearer" },
        );
        return;
      }

      markGatewayAuthenticated(wtReq);

      // Enforce same-origin & non-cross-site browser protection
      if (configPlaneTrust(wtReq) === false) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "Cross-origin access denied" } });
        return;
      }

      if (req.method === "GET" && (pathname === "/health" || pathname === "/web-tools/health")) {
        writeJson(res, 200, {
          ok: true,
          value: {
            status: "healthy",
            version: CURRENT_VERSION,
            pid: process.pid,
            available: searchProvider?.available() ?? false,
          },
        });
        return;
      }

      // 4. Internal MCP Execution Endpoints (`/web-tools/mcp/*`)
      if (pathname.startsWith("/web-tools/mcp/")) {
        const mcpAction = pathname.slice("/web-tools/mcp/".length);
        const payload = req.method === "POST" ? await readJsonBody(req) : {};
        if (mcpAction === "search" || mcpAction === "fetch") {
          try {
            const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
            if (storage.getEffectiveSessionMode(sessionId) === "off") {
              writeJson(res, 403, { ok: false, error: { code: "mode-off", message: WEB_DISABLED_DENIAL } });
              return;
            }
            payload.turnId = storage.bindToolTurn(sessionId, positiveInteger(payload.turnId, "turn_id"));
            if (mcpAction === "search") payload.maxResults = positiveInteger(payload.maxResults, "max_results", 20) ?? 8;
          } catch (error) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) } });
            return;
          }
        }

        if (mcpAction === "search") {
          const query = typeof payload.query === "string" ? payload.query.trim() : "";
          const maxResults = typeof payload.maxResults === "number" ? payload.maxResults : 8;
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const turnId = typeof payload.turnId === "number" ? payload.turnId : undefined;

          if (!query) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "query is required" } });
            return;
          }

          const effectiveMode = storage.getEffectiveSessionMode(sessionId);
          if (effectiveMode === "off") {
            writeJson(res, 403, { ok: false, error: { code: "mode-off", message: WEB_DISABLED_DENIAL } });
            return;
          }

          if (!searchProvider) {
            writeJson(res, 503, { ok: false, error: { code: "unavailable", message: "search provider not initialized" } });
            return;
          }

          try {
            const started = Date.now();
            const outcome = await searchProvider.search({ query, maxResults });
            storage.completeTool(sessionId, "web_search", true, turnId);
            writeJson(res, 200, {
              ok: true,
              value: {
                query,
                latencyMs: Date.now() - started,
                sources: outcome.sources,
                truncated: outcome.truncated,
                backend: (outcome as { backend?: string }).backend,
                attempts: (outcome as { attempts?: unknown }).attempts,
              },
            });
          } catch (err) {
            storage.completeTool(sessionId, "web_search", false, turnId);
            writeJson(res, 500, {
              ok: false,
              error: {
                code: "search-error",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
          return;
        }

        if (mcpAction === "fetch") {
          const url = typeof payload.url === "string" ? payload.url.trim() : "";
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const turnId = typeof payload.turnId === "number" ? payload.turnId : undefined;

          if (!url) {
            writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "url is required" } });
            return;
          }

          const effectiveMode = storage.getEffectiveSessionMode(sessionId);
          if (effectiveMode === "off") {
            writeJson(res, 403, { ok: false, error: { code: "mode-off", message: WEB_DISABLED_DENIAL } });
            return;
          }

          if (!fetchProvider) {
            writeJson(res, 503, { ok: false, error: { code: "unavailable", message: "fetch provider not initialized" } });
            return;
          }

          try {
            const started = Date.now();
            const outcome = await fetchProvider.fetch({ url });
            storage.completeTool(sessionId, "web_fetch", true, turnId);
            writeJson(res, 200, {
              ok: true,
              value: {
                ...outcome,
                latencyMs: Date.now() - started,
              },
            });
          } catch (err) {
            storage.completeTool(sessionId, "web_fetch", false, turnId);
            writeJson(res, 500, {
              ok: false,
              error: {
                code: "fetch-error",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
          return;
        }

        if (mcpAction === "mode") {
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const action = typeof payload.action === "string" ? payload.action : payload.mode !== undefined ? "set" : "get";
          const available = searchProvider?.available() ?? false;
          const cfg = storage.readConfig();
          const platformsEnabled =
            cfg.platformEnabled?.xiaohongshu !== false || cfg.platformEnabled?.x !== false;

          if (action === "set") {
            const nextMode = payload.mode;
            if (nextMode !== "auto" && nextMode !== "required" && nextMode !== "off") {
              writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "mode must be auto, required, or off" } });
              return;
            }
            storage.setSessionMode(sessionId, nextMode);
            if (payload.updateGlobal === true && sessionId !== "global") {
              storage.setSessionMode("global", nextMode);
            }
            const doc = storage.readModeState();
            writeJson(res, 200, {
              ok: true,
              value: {
                sessionId,
                mode: storage.getEffectiveSessionMode(sessionId),
                globalMode: doc.globalMode,
                available,
              },
            });
            return;
          }

          if (action === "toggle") {
            const current = storage.getEffectiveSessionMode(sessionId);
            const next: SearchMode = nextSearchMode(current);
            storage.setSessionMode(sessionId, next);
            const doc = storage.readModeState();
            writeJson(res, 200, {
              ok: true,
              value: {
                sessionId,
                mode: next,
                globalMode: doc.globalMode,
                available,
              },
            });
            return;
          }

          if (action === "begin-turn") {
            const turnNum = typeof payload.turn === "number" ? payload.turn : Date.now();
            const mode = storage.getEffectiveSessionMode(sessionId);
            const turnState = {
              turn: turnNum,
              required: mode === "required",
              disabled: mode === "off",
              webSearchCompleted: false,
              webSearchSucceeded: false,
              webFetchCompleted: false,
              webFetchSucceeded: false,
              correctionCount: 0,
            };
            storage.setTurnState(sessionId, turnState);
            const policyText =
              mode === "off"
                ? SEARCH_DISABLED_TEXT
                : mode === "required"
                  ? requiredSearchText(platformsEnabled)
                  : SEARCH_AUTO_TEXT;
            writeJson(res, 200, {
              ok: true,
              value: {
                sessionId,
                mode,
                available,
                turnState,
                policyText,
                correctionText: REQUIRED_SEARCH_CORRECTION_TEXT,
              },
            });
            return;
          }

          const doc = storage.readModeState();
          const sessions = Object.entries(doc.sessions).map(([id, rec]) => ({
            id,
            mode: rec.mode ?? doc.globalMode,
            updatedAt: rec.updatedAt,
          }));
          writeJson(res, 200, {
            ok: true,
            value: {
              sessionId,
              mode: storage.getEffectiveSessionMode(sessionId),
              globalMode: doc.globalMode,
              available,
              sessions,
            },
          });
          return;
        }

        if (mcpAction === "status") {
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const configView = (await callInternalApi("config/get")) as Record<string, unknown>;
          const platformStatus = (await callInternalApi("platform/status").catch(() => ({ platforms: {} }))) as {
            platforms?: Record<string, unknown>;
          };
          const quotaView =
            payload.includeQuotas === true
              ? ((await callInternalApi("quota/describe").catch(() => ({ quotas: {} }))) as { quotas?: Record<string, unknown> })
              : undefined;
          const doc = storage.readModeState();
          const addr = server.address();
          const boundPort = typeof addr === "object" && addr ? addr.port : requestedPort;

          writeJson(res, 200, {
            ok: true,
            value: {
              version: CURRENT_VERSION,
              gateway: {
                pid: process.pid,
                host,
                port: boundPort,
                url: `http://${host}:${boundPort}`,
              },
              mode: {
                sessionId,
                mode: storage.getEffectiveSessionMode(sessionId),
                globalMode: doc.globalMode,
                available: searchProvider?.available() ?? false,
              },
              config: {
                enabled: configView.enabled,
                defaultProvider: configView.defaultProvider,
                fallbackOrder: configView.fallbackOrder,
                searchRoutingPolicy: configView.searchRoutingPolicy,
                providerAttemptTimeoutMs: configView.providerAttemptTimeoutMs,
                platformEnabled: configView.platformEnabled,
              },
              providers: configView.providers,
              platforms: platformStatus.platforms ?? {},
              ...(quotaView ? { quotas: quotaView.quotas } : {}),
            },
          });
          return;
        }

        writeJson(res, 404, { ok: false, error: { code: "not-found", message: `Unknown MCP endpoint: ${mcpAction}` } });
        return;
      }

      // 5. Management API routes (`/web-tools/api/*`)
      for (const route of routes) {
        const matches =
          route.kind === "exact"
            ? pathname === route.path
            : pathname === route.path || pathname.startsWith(`${route.path}/`);
        if (matches) {
          if (req.method === "GET" && (pathname === `${API_PREFIX}/version/check` || pathname === `${API_PREFIX}/config/get`)) {
            req.method = "POST";
          }
          await route.handler(wtReq, res as unknown as WebToolsHttpResponse);
          return;
        }
      }

      writeJson(res, 404, { ok: false, error: { code: "not-found", message: `Not found: ${pathname}` } });
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        error: { code: "internal", message: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

  storage.writeGatewayState({
    pid: process.pid,
    host,
    port: actualPort,
    url,
    version: CURRENT_VERSION,
    startedAt: Date.now(),
  });

  return {
    host,
    port: actualPort,
    url,
    storage,
    server,
    async close() {
      storage.clearGatewayState(process.pid);
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {}
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
