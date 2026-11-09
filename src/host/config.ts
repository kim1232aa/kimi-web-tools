/**
 * kimi-web-tools — Host configuration: settings namespace + native TypeScript validation.
 *
 * The config (non-secret knobs) lives in `config.json` (via LocalStorage) or the
 * host settings service. API keys live in `credentials.json` (`WEB_TOOLS_*` refs).
 * @module
 */
import type { WebToolsContext } from "./context-types.ts";
import type { QuotaSnapshot } from "./quota.ts";
import type { StoredProviderOptions } from "../shared/provider-options.ts";
import type { SearchRoutingPolicy } from "../shared/api-types.ts";
import type { CustomProviderConfig } from "../shared/custom-provider-types.ts";
import type { OutboundAuthorization } from "./provider-transport.ts";
import { loadCustomProviders } from "./custom-provider-schema.ts";

/** Persistent search routing policy id (shared with the client card). */
export type ToolSearchRoutingPolicy = SearchRoutingPolicy;

/** Settings namespace for this plugin. */
export const SETTINGS_NS = "dsh-web-tools";

/** Default provider when nothing is configured. */
export const DEFAULT_PROVIDER = "exa";

/**
 * Explicit defaults for `WebToolsSettings`.
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  defaultProvider: DEFAULT_PROVIDER,
  providerAttemptTimeoutMs: 10000,
  fallbackOrder: [] as string[],
  providerBaseUrls: {} as Record<string, string>,
  providerEnabled: {} as Record<string, boolean>,
  platformEnabled: { xiaohongshu: true, x: true } as Record<string, boolean>,
  providerOptions: {} as StoredProviderOptions,
  braveQuotaCache: {} as Record<string, QuotaSnapshot>,
  searchRoutingPolicy: "ordered" as ToolSearchRoutingPolicy,
  customProviders: [] as CustomProviderConfig[],
  outboundAuthorizations: [
    { host: "127.0.0.1", port: 8080, allowPrivate: true, allowHttp: true, note: "SearXNG default instance" },
    { host: "localhost", port: 8080, allowPrivate: true, allowHttp: true, note: "SearXNG default instance" },
  ] as OutboundAuthorization[],
};

/** Resolved settings shape (explicit interface — portable in emitted d.ts). */
export interface WebToolsSettings {
  enabled: boolean;
  defaultProvider: string;
  providerAttemptTimeoutMs: number;
  fallbackOrder: string[];
  providerBaseUrls: Record<string, string>;
  providerEnabled: Record<string, boolean>;
  platformEnabled: Record<string, boolean>;
  providerOptions: StoredProviderOptions;
  /** Brave per-key quota snapshots captured from search response headers. */
  braveQuotaCache: Record<string, QuotaSnapshot>;
  /** Search routing policy (see shared api-types). */
  searchRoutingPolicy: ToolSearchRoutingPolicy;
  /** Operator-defined custom search sources (Issue #9). */
  customProviders: CustomProviderConfig[];
  /** Operator-granted outbound destinations for internal gateways / private IPs. */
  outboundAuthorizations?: OutboundAuthorization[];
}

function unwrapConfig(val: unknown): unknown {
  if (val && typeof (val as any).get === "function") {
    return unwrapConfig((val as any).get());
  }
  if (Array.isArray(val)) {
    return val.map(unwrapConfig);
  }
  if (val !== null && typeof val === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = unwrapConfig(v);
    }
    return res;
  }
  return val;
}

/**
 * Keep only usable base-URL overrides.
 *
 * A malformed override must never reach an adapter: an entry that is not an
 * absolute http(s) URL is dropped (which restores the official endpoint) rather
 * than being passed down and failing at request time.
 */
export function sanitizeBaseUrlOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (parsed.username || parsed.password) continue;
      out[key] = parsed.href.replace(/\/+$/, "");
    } catch {
      continue;
    }
  }
  return out;
}

function sanitizeBooleanDict(value: unknown, fallback: Record<string, boolean> = {}): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const out: Record<string, boolean> = { ...fallback };
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function sanitizeRecordDict<T = unknown>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v as T;
  }
  return out;
}

/**
 * Native TypeScript validator and normalizer for `WebToolsSettings`.
 * Replaces `@deepseek-ai/schemastery` with zero external dependencies.
 */
export function validateWebToolsSettings(rawInput?: unknown): WebToolsSettings {
  const unwrapped = (unwrapConfig(rawInput) as Partial<WebToolsSettings>) ?? {};
  const enabled = typeof unwrapped.enabled === "boolean" ? unwrapped.enabled : DEFAULT_SETTINGS.enabled;
  const defaultProvider =
    typeof unwrapped.defaultProvider === "string" && unwrapped.defaultProvider.trim().length > 0
      ? unwrapped.defaultProvider.trim()
      : DEFAULT_SETTINGS.defaultProvider;

  let providerAttemptTimeoutMs = DEFAULT_SETTINGS.providerAttemptTimeoutMs;
  if (typeof unwrapped.providerAttemptTimeoutMs === "number" && Number.isFinite(unwrapped.providerAttemptTimeoutMs)) {
    providerAttemptTimeoutMs = Math.min(60000, Math.max(1000, Math.round(unwrapped.providerAttemptTimeoutMs)));
  }

  const fallbackOrder = Array.isArray(unwrapped.fallbackOrder)
    ? unwrapped.fallbackOrder.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [...DEFAULT_SETTINGS.fallbackOrder];

  const searchRoutingPolicy: ToolSearchRoutingPolicy =
    unwrapped.searchRoutingPolicy === "ordered" ||
    unwrapped.searchRoutingPolicy === "round-robin" ||
    unwrapped.searchRoutingPolicy === "random"
      ? unwrapped.searchRoutingPolicy
      : DEFAULT_SETTINGS.searchRoutingPolicy;

  return {
    enabled,
    defaultProvider,
    providerAttemptTimeoutMs,
    fallbackOrder,
    providerBaseUrls: sanitizeBaseUrlOverrides(unwrapped.providerBaseUrls),
    providerEnabled: sanitizeBooleanDict(unwrapped.providerEnabled),
    platformEnabled: sanitizeBooleanDict(unwrapped.platformEnabled, DEFAULT_SETTINGS.platformEnabled),
    providerOptions: sanitizeRecordDict(unwrapped.providerOptions) as StoredProviderOptions,
    braveQuotaCache: sanitizeRecordDict<QuotaSnapshot>(unwrapped.braveQuotaCache),
    searchRoutingPolicy,
    customProviders: loadCustomProviders(unwrapped.customProviders),
    outboundAuthorizations: Array.isArray(unwrapped.outboundAuthorizations)
      ? unwrapped.outboundAuthorizations
      : [...DEFAULT_SETTINGS.outboundAuthorizations],
  };
}

export interface NativeSchema<T> {
  (input?: unknown): T;
  validate: (input?: unknown) => T;
  meta: { volatile: boolean };
}

/**
 * Native schema object replacing `@deepseek-ai/schemastery` while maintaining
 * backwards-compatible shape (`Config(val)`, `Config.validate(val)`, `Config.meta`).
 */
export const Config: NativeSchema<WebToolsSettings> = Object.assign(
  (input?: unknown) => validateWebToolsSettings(input),
  {
    validate: (input?: unknown) => validateWebToolsSettings(input),
    meta: { volatile: true },
  },
);

/** A settings-scope handle: current value + write path. */
export interface ConfigHandle {
  /** Resolve the current effective section (re-read each call -> live edits apply). */
  read: () => WebToolsSettings;
  /** Write a partial patch into the namespace; resolves when persisted. */
  write: (patch: Partial<WebToolsSettings>) => Promise<void>;
  /** Called once the settings namespace is mounted. */
  onMounted: (cb: () => void) => void;
}

/**
 * Register the settings namespace; returns a handle for reads (live) and
 * Host-side writes.
 */
export function installConfig(ctx: WebToolsContext, initialConfig?: unknown): ConfigHandle {
  const unwrapped = (unwrapConfig(initialConfig) as Partial<WebToolsSettings>) ?? {};
  const configured: WebToolsSettings = {
    ...DEFAULT_SETTINGS,
    ...unwrapped,
    providerBaseUrls: sanitizeBaseUrlOverrides(unwrapped.providerBaseUrls),
    customProviders: loadCustomProviders(unwrapped.customProviders),
    outboundAuthorizations: Array.isArray(unwrapped.outboundAuthorizations) ? unwrapped.outboundAuthorizations : [],
  };

  let current = () => configured;
  let scope: { update: (patch: object) => Promise<void>; get?: () => unknown } | undefined;
  let service: any;
  let mounted = false;
  const mountedCbs: Array<() => void> = [];

  ctx.inject(["settings"], (sctx: any) => {
    service = sctx.settings;
    if (typeof service?.register === "function") {
      const registered = service.register(SETTINGS_NS, Config, {
        base: configured,
      });
      scope = registered;
      current = () => registered.get() as WebToolsSettings;
    } else {
      if (typeof service?.configure === "function") {
        try {
          ctx.effect?.(() => service.configure({ auto: false }, (ctx as any).fiber));
        } catch {}
      }
    }
    mounted = true;
    for (const cb of mountedCbs.splice(0)) cb();
  });

  return {
    read: () => current(),
    write: async (patch) => {
      if (!scope && !service) {
        throw new Error("dsh-web-tools settings namespace is not mounted");
      }
      const normalized: Partial<WebToolsSettings> = { ...patch };
      if (patch.providerBaseUrls !== undefined) {
        normalized.providerBaseUrls = sanitizeBaseUrlOverrides(patch.providerBaseUrls);
      }
      if (patch.customProviders !== undefined) {
        normalized.customProviders = loadCustomProviders(patch.customProviders);
      }
      if (patch.outboundAuthorizations !== undefined) {
        normalized.outboundAuthorizations = Array.isArray(patch.outboundAuthorizations) ? patch.outboundAuthorizations : [];
      }

      if (scope) {
        await scope.update(normalized);
      } else if (typeof service?.update === "function") {
        await service.update(SETTINGS_NS, normalized);
      }
      Object.assign(configured, normalized);
    },
    onMounted: (cb) => {
      if (mounted) {
        cb();
      } else {
        mountedCbs.push(cb);
      }
    },
  };
}
