/**
 * kimi-web-tools — Local filesystem persistence for standalone gateway & Kimi Code plugin.
 *
 * Manages files under `$KIMI_CODE_HOME/web-tools/` (fallback `~/.kimi-code/web-tools/`):
 *  - `config.json`: non-secret WebToolsSettings
 *  - `credentials.json`: provider API keys and custom source credentials (0600 permissions)
 *  - `mode-state.json`: global & per-session search mode + active turn research tracking
 *  - `gateway.json`: active gateway daemon discovery metadata (pid, host, port, url)
 * @module
 */
import fs from "node:fs";
import path from "node:path";
import { getWebToolsBaseDir } from "./browser/paths.ts";
import { DEFAULT_SETTINGS, validateWebToolsSettings, type WebToolsSettings } from "./config.ts";
import type { SearchMode } from "../shared/api-types.ts";
import type { TurnState } from "./search-mode-runtime.ts";
import type { WebToolsCredentialsService, WebToolsSettingsService } from "./context-types.ts";
import { readModeState, updateModeState } from "../../hooks/mode-state.mjs";

export interface ModeSessionRecord {
  mode?: SearchMode;
  turn?: TurnState;
  pendingTools?: string[];
  updatedAt: number;
}

export interface ModeStateDocument {
  globalMode: SearchMode;
  activeSessionId?: string;
  sessions: Record<string, ModeSessionRecord>;
  updatedAt: number;
}

export interface GatewayStateDocument {
  pid: number;
  host: string;
  port: number;
  url: string;
  version: string;
  startedAt: number;
}

function isValidMode(val: unknown): val is SearchMode {
  return val === "auto" || val === "required" || val === "off";
}

function writeAtomicSync(filePath: string, content: string, mode?: number): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      // Ignore chmod errors on platforms that do not support POSIX permissions
    }
  }
  fs.renameSync(tmpPath, filePath);
  if (mode !== undefined) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Ignore chmod errors on platforms that do not support POSIX permissions
    }
  }
}

export class LocalStorage {
  readonly baseDir: string;
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly modeStatePath: string;
  readonly gatewayPath: string;

  constructor(baseDirOverride?: string) {
    this.baseDir = baseDirOverride ? path.resolve(baseDirOverride) : getWebToolsBaseDir();
    this.configPath = path.join(this.baseDir, "config.json");
    this.credentialsPath = path.join(this.baseDir, "credentials.json");
    this.modeStatePath = path.join(this.baseDir, "mode-state.json");
    this.gatewayPath = path.join(this.baseDir, "gateway.json");
  }

  ensureDir(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
  }

  // -------------------------------------------------------------------------
  // config.json
  // -------------------------------------------------------------------------

  readConfig(): WebToolsSettings {
    if (!fs.existsSync(this.configPath)) {
      return validateWebToolsSettings(DEFAULT_SETTINGS);
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return validateWebToolsSettings(raw);
    } catch {
      return validateWebToolsSettings(DEFAULT_SETTINGS);
    }
  }

  writeConfig(patchOrFull: Partial<WebToolsSettings>): WebToolsSettings {
    const current = this.readConfig();
    const merged = validateWebToolsSettings({ ...current, ...patchOrFull });
    writeAtomicSync(this.configPath, JSON.stringify(merged, null, 2) + "\n", 0o600);
    return merged;
  }

  // -------------------------------------------------------------------------
  // credentials.json (0600 permissions)
  // -------------------------------------------------------------------------

  readAllCredentials(): Record<string, string> {
    if (!fs.existsSync(this.credentialsPath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) {
          out[k] = v;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  writeAllCredentials(creds: Record<string, string>): void {
    writeAtomicSync(this.credentialsPath, JSON.stringify(creds, null, 2) + "\n", 0o600);
  }

  resolveCredential(ref: string): { value?: string; source?: string } | undefined {
    const all = this.readAllCredentials();
    if (typeof all[ref] === "string" && all[ref].length > 0) {
      return { value: all[ref], source: "local" };
    }
    const envVal = process.env[ref];
    if (typeof envVal === "string" && envVal.trim().length > 0) {
      return { value: envVal.trim(), source: "env" };
    }
    return undefined;
  }

  setCredential(ref: string, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.unsetCredential(ref);
      return;
    }
    const all = this.readAllCredentials();
    all[ref] = trimmed;
    this.writeAllCredentials(all);
  }

  unsetCredential(ref: string): void {
    const all = this.readAllCredentials();
    if (ref in all) {
      delete all[ref];
      this.writeAllCredentials(all);
    }
  }

  // -------------------------------------------------------------------------
  // mode-state.json
  // -------------------------------------------------------------------------

  readModeState(): ModeStateDocument {
    return readModeState(this.modeStatePath);
  }

  writeModeState(state: ModeStateDocument): void {
    updateModeState(this.modeStatePath, (doc) => {
      doc.globalMode = state.globalMode;
      doc.sessions = state.sessions;
    });
  }

  getEffectiveSessionMode(sessionId: string): SearchMode {
    const doc = this.readModeState();
    if (!sessionId || sessionId === "global" || sessionId === "default") return doc.globalMode;
    return Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId].mode ?? doc.globalMode : doc.globalMode;
  }

  setSessionMode(sessionId: string, mode: SearchMode): SearchMode {
    if (!isValidMode(mode)) throw new Error("Invalid search mode");
    updateModeState(this.modeStatePath, (doc) => {
      const id = !sessionId || sessionId === "default" ? "global" : sessionId;
      if (id === "global") doc.globalMode = mode;
      const entry = Object.hasOwn(doc.sessions, id) ? doc.sessions[id] : {};
      Object.defineProperty(doc.sessions, id, {
        value: { ...entry, mode, updatedAt: Date.now() },
        enumerable: true, writable: true, configurable: true,
      });
    });
    return mode;
  }

  getTurnState(sessionId: string): TurnState | undefined {
    const doc = this.readModeState();
    return Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId].turn : undefined;
  }

  setTurnState(sessionId: string, turn: TurnState | undefined): void {
    updateModeState(this.modeStatePath, (doc) => {
      const existing = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
      if (turn === undefined) delete existing.turn;
      else existing.turn = turn;
      Object.defineProperty(doc.sessions, sessionId, {
        value: { ...existing, updatedAt: Date.now() },
        enumerable: true, writable: true, configurable: true,
      });
    });
  }

  bindToolTurn(sessionId: string, turnId?: number): number | undefined {
    const doc = this.readModeState();
    const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
    const mode = entry?.mode ?? doc.globalMode;
    if (mode === "required" && (!sessionId || sessionId === "global" || !entry?.turn || turnId === undefined)) {
      throw new Error("Required mode needs session_id and turn_id from the current UserPromptSubmit hook.");
    }
    if (turnId !== undefined && turnId !== entry?.turn?.turn) {
      throw new Error(`Stale or unknown turn for session ${sessionId}; use the current hook's turn_id.`);
    }
    return turnId ?? entry?.turn?.turn;
  }

  completeTool(sessionId: string, kind: "web_search" | "web_fetch", succeeded: boolean, turnId?: number): void {
    if (!sessionId || sessionId === "global") return;
    updateModeState(this.modeStatePath, (doc) => {
      const existing = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
      if (!existing?.turn || (turnId !== undefined && existing.turn.turn !== turnId)) return;
      if (kind === "web_search") {
        existing.turn.webSearchCompleted = true;
        if (succeeded) existing.turn.webSearchSucceeded = true;
      } else {
        existing.turn.webFetchCompleted = true;
        if (succeeded) existing.turn.webFetchSucceeded = true;
      }
      existing.updatedAt = Date.now();
    });
  }

  clearSession(sessionId: string): void {
    updateModeState(this.modeStatePath, (doc) => { delete doc.sessions[sessionId]; });
  }

  // -------------------------------------------------------------------------
  // gateway.json
  // -------------------------------------------------------------------------

  readGatewayState(): GatewayStateDocument | null {
    if (!fs.existsSync(this.gatewayPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.gatewayPath, "utf8")) as Partial<GatewayStateDocument>;
      if (
        typeof parsed.pid === "number" &&
        typeof parsed.host === "string" &&
        typeof parsed.port === "number" &&
        typeof parsed.url === "string"
      ) {
        return {
          pid: parsed.pid,
          host: parsed.host,
          port: parsed.port,
          url: parsed.url,
          version: typeof parsed.version === "string" ? parsed.version : "0.4.0",
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  writeGatewayState(doc: GatewayStateDocument): void {
    writeAtomicSync(this.gatewayPath, JSON.stringify(doc, null, 2) + "\n", 0o600);
  }

  clearGatewayState(onlyPid?: number): void {
    if (!fs.existsSync(this.gatewayPath)) return;
    if (onlyPid !== undefined) {
      const current = this.readGatewayState();
      if (current && current.pid !== onlyPid) return;
    }
    try {
      fs.unlinkSync(this.gatewayPath);
    } catch {
      // Ignore unlink errors
    }
  }

  // -------------------------------------------------------------------------
  // Service adapters for WebToolsContext
  // -------------------------------------------------------------------------

  createSettingsService(): WebToolsSettingsService {
    let cached = this.readConfig();
    const watchers = new Set<(next: any, prev: any) => void | Promise<void>>();
    return {
      register: <T>(_ns: string, _schema: unknown, options?: { base?: Partial<T> }) => {
        if (!fs.existsSync(this.configPath) && options?.base) {
          cached = this.writeConfig(options.base as Partial<WebToolsSettings>);
        } else {
          cached = this.readConfig();
        }
        return {
          get: () => this.readConfig() as unknown as T,
          watch: (cb) => {
            watchers.add(cb);
            return () => watchers.delete(cb);
          },
          update: async (patch: object) => {
            const prev = cached;
            cached = this.writeConfig(patch as Partial<WebToolsSettings>);
            for (const cb of watchers) await cb(cached, prev);
          },
          replace: async (section: object) => {
            const prev = cached;
            cached = this.writeConfig(section as Partial<WebToolsSettings>);
            for (const cb of watchers) await cb(cached, prev);
          },
        };
      },
      describe: () => [
        {
          ns: "dsh-web-tools",
          value: this.readConfig(),
          applies: "live" as const,
          revision: 1,
        },
      ],
      update: async (_ns: string, patch: object) => {
        const prev = cached;
        cached = this.writeConfig(patch as Partial<WebToolsSettings>);
        for (const cb of watchers) await cb(cached, prev);
      },
    };
  }

  createCredentialsService(): WebToolsCredentialsService {
    return {
      resolve: async (ref: string) => this.resolveCredential(ref),
      set: async (ref: string, value: string) => {
        this.setCredential(ref, value);
      },
      unset: async (ref: string) => {
        this.unsetCredential(ref);
      },
      describe: async (refs: string[]) => {
        const out: Record<string, { configured: boolean; source?: string; writable: boolean }> = {};
        for (const ref of refs) {
          const resolved = this.resolveCredential(ref);
          out[ref] = {
            configured: Boolean(resolved?.value),
            source: resolved?.source,
            writable: true,
          };
        }
        return out;
      },
    };
  }
}
