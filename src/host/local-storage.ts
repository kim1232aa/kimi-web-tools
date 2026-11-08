/**
 * kimi-web-tools — Local filesystem persistence for standalone gateway & Kimi Code plugin.
 *
 * Manages files under `$KIMI_CODE_HOME/web-tools/` (fallback `~/.kimi-code/web-tools/`):
 *  - `config.json`: non-secret WebToolsSettings
 *  - `credentials.json`: provider API keys and custom source credentials (0600 permissions)
 *  - `mode-state.json`: global & per-session search mode + active turn research tracking
 *  - `gateway.json`: active gateway daemon discovery metadata (public and loopback listener ports)
 * @module
 */
import fs from "node:fs";
import path from "node:path";
import { getWebToolsBaseDir } from "./browser/paths.ts";
import { DEFAULT_SETTINGS, validateWebToolsSettings, type WebToolsSettings } from "./config.ts";
import type { SearchMode } from "../shared/api-types.ts";
import type { TurnState } from "./search-mode-runtime.ts";
import type { WebToolsCredentialsService, WebToolsSettingsService } from "./context-types.ts";

export interface ModeSessionRecord {
  mode?: SearchMode;
  turn?: TurnState;
  pendingTools?: string[];
  updatedAt: number;
}

export interface ModeStateDocument {
  globalMode: SearchMode;
  sessions: Record<string, ModeSessionRecord>;
  updatedAt: number;
}

export interface GatewayStateDocument {
  pid: number;
  host: string;
  port: number;
  internalPort?: number;
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
    if (!fs.existsSync(this.modeStatePath)) {
      return { globalMode: "auto", sessions: {}, updatedAt: Date.now() };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.modeStatePath, "utf8")) as Partial<ModeStateDocument>;
      const globalMode = isValidMode(raw?.globalMode) ? raw.globalMode : "auto";
      const sessions: Record<string, ModeSessionRecord> = {};
      if (raw?.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
        for (const [sid, rec] of Object.entries(raw.sessions)) {
          if (!rec || typeof rec !== "object") continue;
          sessions[sid] = {
            ...(isValidMode(rec.mode) ? { mode: rec.mode } : {}),
            ...(rec.turn && typeof rec.turn === "object" ? { turn: rec.turn } : {}),
            ...(Array.isArray(rec.pendingTools) ? { pendingTools: rec.pendingTools.map(String) } : {}),
            updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
          };
        }
      }
      return {
        globalMode,
        sessions,
        updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : Date.now(),
      };
    } catch {
      return { globalMode: "auto", sessions: {}, updatedAt: Date.now() };
    }
  }

  writeModeState(state: ModeStateDocument): void {
    // Prune stale sessions if count > 200 to keep mode-state.json compact
    const entries = Object.entries(state.sessions);
    if (entries.length > 200) {
      entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
      state.sessions = Object.fromEntries(entries.slice(0, 150));
    }
    state.updatedAt = Date.now();
    writeAtomicSync(this.modeStatePath, JSON.stringify(state, null, 2) + "\n", 0o600);
  }

  getEffectiveSessionMode(sessionId: string): SearchMode {
    const doc = this.readModeState();
    if (!sessionId || sessionId === "global" || sessionId === "default") {
      return doc.globalMode;
    }
    const explicit = doc.sessions[sessionId]?.mode;
    return explicit ?? doc.globalMode;
  }

  setSessionMode(sessionId: string, mode: SearchMode): SearchMode {
    const doc = this.readModeState();
    if (!sessionId || sessionId === "global" || sessionId === "default") {
      doc.globalMode = mode;
      // Also update "global" session entry for UI visibility
      doc.sessions["global"] = {
        ...(doc.sessions["global"] ?? {}),
        mode,
        updatedAt: Date.now(),
      };
    } else {
      const existing = doc.sessions[sessionId] ?? { updatedAt: Date.now() };
      existing.mode = mode;
      existing.updatedAt = Date.now();
      doc.sessions[sessionId] = existing;
    }
    this.writeModeState(doc);
    return mode;
  }

  getTurnState(sessionId: string): TurnState | undefined {
    const doc = this.readModeState();
    return doc.sessions[sessionId]?.turn;
  }

  setTurnState(sessionId: string, turn: TurnState | undefined): void {
    const doc = this.readModeState();
    const existing = doc.sessions[sessionId] ?? { updatedAt: Date.now() };
    if (turn === undefined) {
      delete existing.turn;
    } else {
      existing.turn = turn;
    }
    existing.updatedAt = Date.now();
    doc.sessions[sessionId] = existing;
    this.writeModeState(doc);
  }

  clearSession(sessionId: string): void {
    const doc = this.readModeState();
    if (sessionId in doc.sessions) {
      delete doc.sessions[sessionId];
      this.writeModeState(doc);
    }
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
          ...(typeof parsed.internalPort === "number" ? { internalPort: parsed.internalPort } : {}),
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
