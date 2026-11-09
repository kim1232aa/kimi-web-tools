import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  NineRouterClient,
  NineRouterError,
  DEFAULT_SEARCH_MODEL,
  DEFAULT_FETCH_MODEL,
  type NineRouterClientOptions,
} from "./9router-client.ts";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 18492;
export const GATEWAY_VERSION = "0.4.0";

export type SearchMode = "auto" | "required" | "off";

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

const WEB_DISABLED_DENIAL =
  "Web search is switched OFF for this session, so this tool call was denied. Answer from the existing context and state what could not be verified.";

function getWebToolsDir(): string {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  const home = explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), ".kimi-code");
  return path.join(home, "web-tools");
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

interface ModeStateDoc {
  globalMode: SearchMode;
  activeSessionId?: string;
  sessions: Record<string, { mode?: SearchMode; turn?: Record<string, unknown>; updatedAt?: number }>;
  updatedAt: number;
}

interface GatewayConfigDoc {
  searchModel: string;
  fetchModel: string;
  enableFetch: boolean;
  updatedAt: number;
}

function normalizeMode(value: unknown, fallback: SearchMode = "auto"): SearchMode {
  return value === "auto" || value === "required" || value === "off" ? value : fallback;
}

function readModeDoc(): ModeStateDoc {
  const filePath = path.join(getWebToolsDir(), "mode-state.json");
  const raw = readJsonFile<Partial<ModeStateDoc>>(filePath, {});
  const sessions = raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
  return {
    globalMode: normalizeMode(raw.globalMode, "auto"),
    activeSessionId: typeof raw.activeSessionId === "string" ? raw.activeSessionId : undefined,
    sessions,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function getEffectiveSessionMode(sessionId = "global"): { mode: SearchMode; globalMode: SearchMode; doc: ModeStateDoc } {
  const doc = readModeDoc();
  if (sessionId === "global") {
    return { mode: doc.globalMode, globalMode: doc.globalMode, doc };
  }
  const entry = doc.sessions[sessionId];
  const mode = entry?.mode ? normalizeMode(entry.mode, doc.globalMode) : doc.globalMode;
  return { mode, globalMode: doc.globalMode, doc };
}

function setSessionMode(sessionId: string, nextMode: SearchMode, updateGlobal = false): { mode: SearchMode; globalMode: SearchMode } {
  const filePath = path.join(getWebToolsDir(), "mode-state.json");
  const doc = readModeDoc();
  if (sessionId === "global" || updateGlobal) {
    doc.globalMode = nextMode;
  }
  if (sessionId !== "global") {
    doc.sessions[sessionId] = {
      ...(doc.sessions[sessionId] || {}),
      mode: nextMode,
      updatedAt: Date.now(),
    };
  } else {
    // Also update active session if it was overriding global
    for (const key of Object.keys(doc.sessions)) {
      if (doc.sessions[key]) {
        doc.sessions[key].mode = nextMode;
        doc.sessions[key].updatedAt = Date.now();
      }
    }
  }
  doc.updatedAt = Date.now();
  writeAtomic(filePath, doc);
  return { mode: nextMode, globalMode: doc.globalMode };
}

function readGatewayConfig(defaultSearch: string, defaultFetch: string, defaultEnableFetch: boolean): GatewayConfigDoc {
  const filePath = path.join(getWebToolsDir(), "gateway-config.json");
  const raw = readJsonFile<Partial<GatewayConfigDoc>>(filePath, {});
  return {
    searchModel: typeof raw.searchModel === "string" && raw.searchModel.trim() ? raw.searchModel.trim() : defaultSearch,
    fetchModel: typeof raw.fetchModel === "string" && raw.fetchModel.trim() ? raw.fetchModel.trim() : defaultFetch,
    enableFetch: typeof raw.enableFetch === "boolean" ? raw.enableFetch : defaultEnableFetch,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function writeGatewayConfig(cfg: GatewayConfigDoc): void {
  const filePath = path.join(getWebToolsDir(), "gateway-config.json");
  writeAtomic(filePath, cfg);
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

function writeHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(html);
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

function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasValidAuth(req: http.IncomingMessage, password: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.slice(0, 7).toLowerCase() === "bearer ") {
    if (safeCompareSecret(authorization.slice(7).trim(), password)) return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (typeof cookies.kimi_wt_token === "string" && cookies.kimi_wt_token.length > 0) {
    if (safeCompareSecret(cookies.kimi_wt_token, password)) return true;
  }
  return false;
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

function renderDashboardHtml(requireLogin: boolean): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Kimi Web Tools — 联网网关控制台</title>
  <style>
    :root, [data-theme="dark"] {
      --dsw-font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --ds-font-family-code: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      --dsw-alias-label-primary: #f1f5f9;
      --dsw-alias-label-secondary: #94a3b8;
      --dsw-alias-label-tertiary: #64748b;
      --dsw-alias-label-dimmed: #475569;
      --dsw-alias-bg-base: #0b0f17;
      --dsw-alias-bg-layer-1: #131924;
      --dsw-alias-bg-layer-2: #1c2433;
      --dsw-alias-border-l2: #243044;
      --dsw-alias-border-l3: #334155;
      --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.06);
      --dsw-alias-state-success-primary: #34d399;
      --dsw-alias-state-warn-primary: #fbbf24;
      --dsw-alias-state-error-primary: #f87171;
      --dsw-alias-state-business-primary: #60a5fa;
      --dsw-alias-button-primary-fill: #3b82f6;
      --dsw-alias-button-primary-hover: #2563eb;
      color-scheme: dark;
    }
    [data-theme="light"] {
      --dsw-alias-label-primary: #0f172a;
      --dsw-alias-label-secondary: #475569;
      --dsw-alias-label-tertiary: #64748b;
      --dsw-alias-label-dimmed: #94a3b8;
      --dsw-alias-bg-base: #f8fafc;
      --dsw-alias-bg-layer-1: #ffffff;
      --dsw-alias-bg-layer-2: #f1f5f9;
      --dsw-alias-border-l2: #e2e8f0;
      --dsw-alias-border-l3: #cbd5e1;
      --dsw-alias-interactive-bg-hover: rgba(15, 23, 42, 0.05);
      --dsw-alias-state-success-primary: #10b981;
      --dsw-alias-state-warn-primary: #f59e0b;
      --dsw-alias-state-error-primary: #ef4444;
      --dsw-alias-state-business-primary: #2563eb;
      --dsw-alias-button-primary-fill: #2563eb;
      --dsw-alias-button-primary-hover: #1d4ed8;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-label-primary);
      font-family: var(--dsw-font-family);
      -webkit-font-smoothing: antialiased;
    }
    /* Original SearchModeButton styles */
    .wt-sm-wrap { position: relative; display: inline-flex; flex: 0 0 auto; }
    .wt-sm-trigger {
      display: inline-flex; align-items: center; gap: 6px; height: 32px;
      padding: 0 10px 0 9px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      font-family: var(--dsw-font-family); font-size: 13px; font-weight: 500;
      cursor: pointer; transition: background-color 100ms ease, color 100ms ease, border-color 100ms ease;
    }
    .wt-sm-trigger:hover, .wt-sm-trigger[data-open="true"] {
      background: var(--dsw-alias-interactive-bg-hover);
      border-color: var(--dsw-alias-border-l3);
    }
    .wt-sm-trigger[data-mode="required"] {
      color: var(--dsw-alias-state-business-primary);
      background: rgba(96, 165, 250, 0.12);
      border-color: rgba(96, 165, 250, 0.3);
    }
    .wt-sm-trigger[data-mode="off"] {
      color: var(--dsw-alias-label-secondary);
    }
    .wt-sm-icon, .wt-sm-chevron { display: inline-flex; align-items: center; justify-content: center; }
    .wt-sm-chevron { color: var(--dsw-alias-label-tertiary); transition: transform 120ms ease; }
    .wt-sm-trigger[data-open="true"] .wt-sm-chevron { transform: rotate(180deg); }
    .wt-sm-menu {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 60;
      min-width: 300px; padding: 6px; border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 10px; background: var(--dsw-alias-bg-layer-1);
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35); display: none; flex-direction: column; gap: 2px;
    }
    .wt-sm-menu[data-open="true"] { display: flex; }
    .wt-sm-menu-title {
      padding: 6px 8px 4px; color: var(--dsw-alias-label-tertiary);
      font-size: 11px; line-height: 16px; font-weight: 500;
    }
    .wt-sm-item {
      display: grid; grid-template-columns: 18px 1fr 18px; align-items: center; column-gap: 10px;
      width: 100%; padding: 8px 10px; border: none; border-radius: 7px;
      background: transparent; color: var(--dsw-alias-label-primary);
      text-align: left; cursor: pointer; font-family: var(--dsw-font-family);
    }
    .wt-sm-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .wt-sm-item-icon { color: var(--dsw-alias-label-secondary); display: flex; align-items: center; }
    .wt-sm-item[data-selected="true"][data-mode="required"] .wt-sm-item-icon,
    .wt-sm-item[data-selected="true"][data-mode="required"] .wt-sm-item-title {
      color: var(--dsw-alias-state-business-primary);
    }
    .wt-sm-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .wt-sm-item-title { font-size: 13px; line-height: 18px; font-weight: 500; }
    .wt-sm-item-desc { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
    .wt-sm-item-check { color: var(--dsw-alias-label-primary); display: flex; align-items: center; justify-content: center; }

    /* Layout & cards */
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      max-width: 860px; margin: 0 auto; padding: 18px 20px;
      border-bottom: 1px solid var(--dsw-alias-border-l2);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); display: inline-block; }
    .dot[data-ok="false"] { background: var(--dsw-alias-state-error-primary); }
    .topbar-actions { display: flex; align-items: center; gap: 10px; }
    .container { max-width: 860px; margin: 24px auto; padding: 0 20px 48px; display: flex; flex-direction: column; gap: 16px; }
    .card {
      background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 12px; padding: 18px 20px;
    }
    .card-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; display: flex; align-items: center; justify-content: space-between; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
    .row:first-of-type { border-top: none; padding-top: 2px; }
    .row-label { font-size: 13px; font-weight: 500; }
    .row-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
    select, input[type="text"], input[type="password"] {
      height: 34px; padding: 0 10px; border-radius: 8px;
      border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-primary); font-size: 13px; font-family: var(--dsw-font-family);
    }
    .btn {
      height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent;
      background: var(--dsw-alias-button-primary-fill); color: #fff; font-size: 13px;
      font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:hover { background: var(--dsw-alias-button-primary-hover); }
    .btn-ghost {
      background: transparent; color: var(--dsw-alias-label-secondary);
      border-color: var(--dsw-alias-border-l2);
    }
    .btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .login-wrap { max-width: 380px; margin: 110px auto; padding: 0 20px; }
    .result-box {
      margin-top: 12px; padding: 12px; border-radius: 8px;
      background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
      font-family: var(--ds-font-family-code); font-size: 12px; white-space: pre-wrap;
      max-height: 320px; overflow: auto; display: none;
    }
    .badge {
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
      border: 1px solid var(--dsw-alias-border-l2);
    }
  </style>
</head>
<body>
  <div id="loginView" class="login-wrap" style="display: ${requireLogin ? "block" : "none"};">
    <div class="card">
      <div class="card-title">Kimi Web Tools 访问认证</div>
      <div class="row-sub" style="margin-bottom: 14px;">请输入网关访问密码（KIMI_WEB_TOOLS_PASSWORD）以管理联网模式和 9Router 搜索源。</div>
      <form id="loginForm" style="display: flex; flex-direction: column; gap: 10px;">
        <input id="passwordInput" type="password" placeholder="输入访问密码..." autocomplete="current-password" required />
        <div id="loginError" style="color: var(--dsw-alias-state-error-primary); font-size: 12px; display: none;"></div>
        <button type="submit" class="btn" style="justify-content: center;">解锁进入</button>
      </form>
    </div>
  </div>

  <div id="appView" style="display: ${requireLogin ? "none" : "block"};">
    <header class="topbar">
      <div class="brand">
        <span id="healthDot" class="dot" data-ok="true"></span>
        <span>Kimi Web Tools</span>
        <span id="versionBadge" class="badge">v${GATEWAY_VERSION}</span>
      </div>
      <div class="topbar-actions">
        <!-- 联网模式下拉控件 -->
        <div class="wt-sm-wrap" id="searchModeWrap">
          <button type="button" class="wt-sm-trigger" id="smTrigger" data-mode="auto" data-open="false" aria-haspopup="menu" aria-expanded="false">
            <span class="wt-sm-icon" id="smTriggerIcon"></span>
            <span class="wt-sm-label" id="smTriggerLabel">智能联网</span>
            <span class="wt-sm-chevron">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </span>
          </button>
          <div class="wt-sm-menu" id="smMenu" role="menu" data-open="false">
            <div class="wt-sm-menu-title">联网模式</div>
            <button type="button" class="wt-sm-item" role="menuitemradio" data-mode="auto" data-selected="true">
              <span class="wt-sm-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
              </span>
              <span class="wt-sm-item-body">
                <span class="wt-sm-item-title">智能联网</span>
                <span class="wt-sm-item-desc">根据问题需要自动决定是否搜索</span>
              </span>
              <span class="wt-sm-item-check" data-check="auto">✓</span>
            </button>
            <button type="button" class="wt-sm-item" role="menuitemradio" data-mode="required" data-selected="false">
              <span class="wt-sm-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/></svg>
              </span>
              <span class="wt-sm-item-body">
                <span class="wt-sm-item-title">始终联网</span>
                <span class="wt-sm-item-desc">每轮对话至少进行一次联网查询</span>
              </span>
              <span class="wt-sm-item-check" data-check="required"></span>
            </button>
            <button type="button" class="wt-sm-item" role="menuitemradio" data-mode="off" data-selected="false">
              <span class="wt-sm-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/></svg>
              </span>
              <span class="wt-sm-item-body">
                <span class="wt-sm-item-title">关闭联网</span>
                <span class="wt-sm-item-desc">不使用联网搜索和网页读取工具</span>
              </span>
              <span class="wt-sm-item-check" data-check="off"></span>
            </button>
          </div>
        </div>
        <button type="button" class="btn btn-ghost" id="themeBtn" title="切换深浅色">主题</button>
      </div>
    </header>

    <main class="container">
      <section class="card">
        <div class="card-title">
          <span>9Router 上游与默认模型</span>
          <span id="upstreamBadge" class="badge">加载中...</span>
        </div>
        <div class="row">
          <div>
            <div class="row-label">默认搜索源（web_search）</div>
            <div class="row-sub">对应 9Router /v1/search 的 provider / combo 名称</div>
          </div>
          <select id="searchModelSelect"></select>
        </div>
        <div class="row">
          <div>
            <div class="row-label">默认网页抓取源（web_fetch）</div>
            <div class="row-sub">对应 9Router /v1/web/fetch 的 reader provider</div>
          </div>
          <select id="fetchModelSelect"></select>
        </div>
      </section>

      <section class="card">
        <div class="card-title">在线搜索连通性测试</div>
        <form id="testSearchForm" style="display: flex; gap: 8px;">
          <input id="testQueryInput" type="text" value="Kimi Code MCP" placeholder="输入搜索关键词..." style="flex: 1;" />
          <button type="submit" class="btn" id="testSearchBtn">立即搜索</button>
        </form>
        <pre id="testResultBox" class="result-box"></pre>
      </section>
    </main>
  </div>

  <script>
    const ICONS = {
      auto: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
      required: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/></svg>',
      off: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/></svg>'
    };
    const LABELS = { auto: '智能联网', required: '始终联网', off: '关闭联网' };

    function renderModeUI(mode) {
      const m = LABELS[mode] ? mode : 'auto';
      const trigger = document.getElementById('smTrigger');
      trigger.setAttribute('data-mode', m);
      document.getElementById('smTriggerIcon').innerHTML = ICONS[m];
      document.getElementById('smTriggerLabel').textContent = LABELS[m];
      document.querySelectorAll('.wt-sm-item').forEach(btn => {
        const bm = btn.getAttribute('data-mode');
        const sel = bm === m;
        btn.setAttribute('data-selected', sel ? 'true' : 'false');
        const chk = btn.querySelector('.wt-sm-item-check');
        if (chk) chk.textContent = sel ? '✓' : '';
      });
    }

    async function apiCall(path, body = {}) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 401) {
        document.getElementById('loginView').style.display = 'block';
        document.getElementById('appView').style.display = 'none';
        throw new Error('Unauthorized');
      }
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error?.message || ('HTTP ' + res.status));
      }
      return data.value;
    }

    async function loadDashboard() {
      try {
        const st = await apiCall('/web-tools/api/status');
        document.getElementById('loginView').style.display = 'none';
        document.getElementById('appView').style.display = 'block';
        renderModeUI(st.mode);
        document.getElementById('upstreamBadge').textContent = st.upstream + (st.available ? ' (已连接)' : ' (未配置 Key)');
        document.getElementById('healthDot').setAttribute('data-ok', st.available ? 'true' : 'false');

        const sSelect = document.getElementById('searchModelSelect');
        const fSelect = document.getElementById('fetchModelSelect');
        const sModels = st.searchModels?.length ? st.searchModels : ['brave', 'tavily', 'exa', 'youcom', 'tinyfish', 'ollama-search'];
        const fModels = st.fetchModels?.length ? st.fetchModels : ['jina-reader', 'firecrawl', 'tavily', 'exa', 'tinyfish', 'ollama'];

        sSelect.innerHTML = sModels.map(m => '<option value="' + m + '"' + (m === st.searchModel ? ' selected' : '') + '>' + m + '</option>').join('');
        fSelect.innerHTML = fModels.map(m => '<option value="' + m + '"' + (m === st.fetchModel ? ' selected' : '') + '>' + m + '</option>').join('');
      } catch (e) {
        // Handled by 401 redirect or ignored
      }
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('passwordInput').value.trim();
      const errEl = document.getElementById('loginError');
      errEl.style.display = 'none';
      try {
        const res = await fetch('/web-tools/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          errEl.textContent = data.error?.message || '密码错误';
          errEl.style.display = 'block';
          return;
        }
        await loadDashboard();
      } catch (err) {
        errEl.textContent = err.message || '登录请求失败';
        errEl.style.display = 'block';
      }
    });

    const smTrigger = document.getElementById('smTrigger');
    const smMenu = document.getElementById('smMenu');
    smTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = smMenu.getAttribute('data-open') === 'true';
      smMenu.setAttribute('data-open', open ? 'false' : 'true');
      smTrigger.setAttribute('data-open', open ? 'false' : 'true');
      smTrigger.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    document.addEventListener('click', () => {
      smMenu.setAttribute('data-open', 'false');
      smTrigger.setAttribute('data-open', 'false');
      smTrigger.setAttribute('aria-expanded', 'false');
    });

    document.querySelectorAll('.wt-sm-item').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const nextMode = btn.getAttribute('data-mode');
        renderModeUI(nextMode);
        smMenu.setAttribute('data-open', 'false');
        smTrigger.setAttribute('data-open', 'false');
        await apiCall('/web-tools/api/search-mode/set', { sessionId: 'global', mode: nextMode });
      });
    });

    document.getElementById('searchModelSelect').addEventListener('change', async (e) => {
      await apiCall('/web-tools/api/config/set', { searchModel: e.target.value });
    });
    document.getElementById('fetchModelSelect').addEventListener('change', async (e) => {
      await apiCall('/web-tools/api/config/set', { fetchModel: e.target.value });
    });

    document.getElementById('testSearchForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const box = document.getElementById('testResultBox');
      const btn = document.getElementById('testSearchBtn');
      box.style.display = 'block';
      box.textContent = '正在通过 9Router 搜索...';
      btn.disabled = true;
      try {
        const q = document.getElementById('testQueryInput').value.trim();
        const res = await apiCall('/web-tools/mcp/search', { query: q, maxResults: 3 });
        box.textContent = JSON.stringify(res, null, 2);
      } catch (err) {
        box.textContent = '错误: ' + (err.message || String(err));
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('themeBtn').addEventListener('click', () => {
      const html = document.documentElement;
      html.setAttribute('data-theme', html.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });

    renderModeUI('auto');
    if (${requireLogin ? "false" : "true"}) {
      loadDashboard();
    }
  </script>
</body>
</html>`;
}

export async function startGatewayServer(options: GatewayServerOptions = {}): Promise<GatewayServerHandle> {
  const host = options.host ?? process.env.KIMI_WEB_TOOLS_HOST ?? DEFAULT_GATEWAY_HOST;
  const requestedPort = options.port ?? readPort(process.env.KIMI_WEB_TOOLS_PORT, DEFAULT_GATEWAY_PORT);
  const defaultEnableFetch = options.enableFetch ?? isEnabled(process.env.KIMI_WEB_TOOLS_ENABLE_FETCH, true);
  const defaultSearchModel = options.searchModel ?? process.env.NINEROUTER_SEARCH_MODEL?.trim() ?? DEFAULT_SEARCH_MODEL;
  const defaultFetchModel = options.fetchModel ?? process.env.NINEROUTER_FETCH_MODEL?.trim() ?? DEFAULT_FETCH_MODEL;

  const savedCfg = readGatewayConfig(defaultSearchModel, defaultFetchModel, defaultEnableFetch);
  let enableFetch = options.enableFetch !== undefined ? options.enableFetch : savedCfg.enableFetch;

  const clientOptions: NineRouterClientOptions = {
    ...(options.upstreamUrl !== undefined ? { baseUrl: options.upstreamUrl } : {}),
    ...(options.upstreamKey !== undefined ? { apiKey: options.upstreamKey } : {}),
    searchModel: options.searchModel ?? savedCfg.searchModel,
    fetchModel: options.fetchModel ?? savedCfg.fetchModel,
    ...(options.upstreamTimeoutMs !== undefined ? { timeoutMs: options.upstreamTimeoutMs } : {}),
  };
  const client = new NineRouterClient(clientOptions);
  const password = process.env.KIMI_WEB_TOOLS_PASSWORD?.trim();

  const requestHandler = (internal: boolean) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;

      // Public password login endpoint (sets HttpOnly cookie)
      if (!internal && req.method === "POST" && pathname === "/web-tools/api/login") {
        if (!password) {
          writeJson(res, 503, {
            ok: false,
            error: { code: "auth-not-configured", message: "Set KIMI_WEB_TOOLS_PASSWORD to enable public gateway access" },
          });
          return;
        }
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const candidate = typeof body.password === "string" ? body.password.trim() : "";
        if (!candidate || !safeCompareSecret(candidate, password)) {
          writeJson(res, 401, { ok: false, error: { code: "unauthorized", message: "访问密码不正确" } });
          return;
        }
        const cookie = `kimi_wt_token=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
        writeJson(res, 200, { ok: true, value: { authenticated: true } }, { "set-cookie": cookie });
        return;
      }

      // Root Web UI (`GET /` or `GET /index.html`): render login view or dashboard view instead of raw 401/404
      if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/" || pathname === "/index.html")) {
        if (!internal && !password) {
          writeJson(res, 503, {
            ok: false,
            error: { code: "auth-not-configured", message: "Set KIMI_WEB_TOOLS_PASSWORD to enable public gateway access" },
          });
          return;
        }
        const authed = internal || (password ? hasValidAuth(req, password) : false);
        writeHtml(res, 200, renderDashboardHtml(!authed));
        return;
      }

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
        if (!hasValidAuth(req, password)) {
          writeJson(
            res,
            401,
            { ok: false, error: { code: "unauthorized", message: "A valid bearer password is required" } },
            { "www-authenticate": "Bearer" },
          );
          return;
        }
      }

      if (req.method === "GET" && (pathname === "/health" || pathname === "/web-tools/health")) {
        const { mode, globalMode } = getEffectiveSessionMode("global");
        writeJson(res, 200, {
          ok: true,
          value: {
            status: "healthy",
            version: GATEWAY_VERSION,
            pid: process.pid,
            available: Boolean(client.apiKey),
            upstream: client.baseUrl,
            searchModel: client.searchModel,
            fetchModel: client.fetchModel,
            mode,
            globalMode,
            tools: ["web_search", ...(enableFetch ? ["web_fetch"] : [])],
          },
        });
        return;
      }

      // Dashboard & Mode API routes (`/web-tools/api/*`)
      if (req.method === "POST" && pathname.startsWith("/web-tools/api/")) {
        const apiAction = pathname.slice("/web-tools/api/".length);
        const payload = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));

        if (apiAction === "status") {
          const { mode, globalMode } = getEffectiveSessionMode("global");
          const models = await client.listWebModels().catch(() => ({ searchModels: [], fetchModels: [] }));
          writeJson(res, 200, {
            ok: true,
            value: {
              version: GATEWAY_VERSION,
              available: Boolean(client.apiKey),
              upstream: client.baseUrl,
              searchModel: client.searchModel,
              fetchModel: client.fetchModel,
              enableFetch,
              mode,
              globalMode,
              searchModels: models.searchModels,
              fetchModels: models.fetchModels,
            },
          });
          return;
        }

        if (apiAction === "search-mode/get") {
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const { mode, globalMode } = getEffectiveSessionMode(sessionId);
          writeJson(res, 200, {
            ok: true,
            value: { sessionId, mode, globalMode, available: Boolean(client.apiKey) },
          });
          return;
        }

        if (apiAction === "search-mode/set") {
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
          const nextMode = normalizeMode(payload.mode, "auto");
          const updated = setSessionMode(sessionId, nextMode, sessionId === "global" || payload.updateGlobal === true);
          writeJson(res, 200, {
            ok: true,
            value: { sessionId, mode: updated.mode, globalMode: updated.globalMode, available: Boolean(client.apiKey) },
          });
          return;
        }

        if (apiAction === "config/set") {
          if (typeof payload.searchModel === "string" && payload.searchModel.trim()) {
            client.searchModel = payload.searchModel.trim();
          }
          if (typeof payload.fetchModel === "string" && payload.fetchModel.trim()) {
            client.fetchModel = payload.fetchModel.trim();
          }
          if (typeof payload.enableFetch === "boolean") {
            enableFetch = payload.enableFetch;
          }
          writeGatewayConfig({
            searchModel: client.searchModel,
            fetchModel: client.fetchModel,
            enableFetch,
            updatedAt: Date.now(),
          });
          writeJson(res, 200, {
            ok: true,
            value: {
              searchModel: client.searchModel,
              fetchModel: client.fetchModel,
              enableFetch,
            },
          });
          return;
        }

        writeJson(res, 404, { ok: false, error: { code: "not-found", message: `Unknown API endpoint: ${apiAction}` } });
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

      const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "global";
      const { mode: effectiveMode } = getEffectiveSessionMode(sessionId);
      if (effectiveMode === "off") {
        writeJson(res, 403, { ok: false, error: { code: "mode-off", message: WEB_DISABLED_DENIAL } });
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
        const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
        const started = Date.now();
        try {
          const result = await client.search(query, maxResults, undefined, modelOverride);
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
      const modelOverride = typeof payload.model === "string" ? payload.model : undefined;
      const started = Date.now();
      try {
        const result = await client.fetch(url, undefined, modelOverride);
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
