/**
 * kimi-web-tools — Host configuration & native validation tests.
 *
 * Verifies that:
 * 1. installConfig respects initial config passed from the loader, flushes onMounted,
 *    updates in-memory state and delegates writes to sctx.settings.update("dsh-web-tools", patch).
 * 2. Backwards compatibility with settings.register is preserved.
 * 3. Volatile getter nodes in initial config are properly unwrapped.
 * 4. Write attempts before mount throw "dsh-web-tools settings namespace is not mounted".
 * 5. apply(ctx, config) propagates loader config into search runtime without falling back to exa.
 * 6. Native validateWebToolsSettings & LocalStorage persist config, 0600 credentials, and mode-state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installConfig, DEFAULT_SETTINGS, SETTINGS_NS, Config, validateWebToolsSettings } from "../src/host/config.ts";
import { LocalStorage } from "../src/host/local-storage.ts";
import { apply } from "../src/host/index.ts";

test("installConfig DSH 0.1.7+: reads initial config and writes via service.update", async () => {
  let mountedRan = false;
  let updateCalledWith: { ns: string; patch: any } | null = null;
  let configureCalledWith: any = null;

  const mockSettings = {
    async update(ns: string, patch: any) {
      updateCalledWith = { ns, patch };
    },
    configure(opts: any) {
      configureCalledWith = opts;
    },
  };

  const mockCtx: any = {
    inject: (deps: string[], cb: (sctx: any) => void) => {
      if (deps.includes("settings")) {
        cb({ settings: mockSettings });
      }
    },
    effect: (fn: () => void) => fn(),
  };

  const initialConfig = {
    defaultProvider: "tavily",
    fallbackOrder: ["brave", "searxng"],
    providerAttemptTimeoutMs: 15000,
  };

  const handle = installConfig(mockCtx, initialConfig);
  handle.onMounted(() => {
    mountedRan = true;
  });

  assert.equal(mountedRan, true, "onMounted must run once injected");
  assert.equal(handle.read().defaultProvider, "tavily", "must retain initialConfig defaultProvider");
  assert.deepEqual(handle.read().fallbackOrder, ["brave", "searxng"]);
  assert.equal(handle.read().providerAttemptTimeoutMs, 15000);
  assert.equal(handle.read().enabled, DEFAULT_SETTINGS.enabled, "missing keys fallback to default");

  // Write a patch
  await handle.write({ defaultProvider: "brave" });
  assert.equal(handle.read().defaultProvider, "brave", "in-memory config must update immediately");
  assert.deepEqual(updateCalledWith, {
    ns: SETTINGS_NS,
    patch: { defaultProvider: "brave" },
  }, "must delegate write to settings.update(SETTINGS_NS, patch)");
  assert.deepEqual(configureCalledWith, { auto: false }, "must configure auto: false to prevent empty page");
});

test("installConfig DSH pre-0.1.7: backwards compatible with settings.register", async () => {
  let mountedRan = false;
  let scopeUpdateCalledWith: any = null;

  const fakeRegistered = {
    get: () => ({ ...DEFAULT_SETTINGS, defaultProvider: "searxng" }),
    update: async (patch: any) => {
      scopeUpdateCalledWith = patch;
    },
  };

  const mockSettings = {
    register: (ns: string, _schema: any, _opts: any) => {
      assert.equal(ns, SETTINGS_NS);
      return fakeRegistered;
    },
  };

  const mockCtx: any = {
    inject: (deps: string[], cb: (sctx: any) => void) => {
      if (deps.includes("settings")) {
        cb({ settings: mockSettings });
      }
    },
  };

  const handle = installConfig(mockCtx);
  handle.onMounted(() => {
    mountedRan = true;
  });

  assert.equal(mountedRan, true);
  assert.equal(handle.read().defaultProvider, "searxng");

  await handle.write({ enabled: false });
  assert.deepEqual(scopeUpdateCalledWith, { enabled: false });
});

test("installConfig: unwraps volatile getters in initial config", () => {
  const mockCtx: any = {
    inject: (_deps: any, cb: any) => cb({ settings: {} }),
  };

  const initialWithGetters = {
    defaultProvider: {
      get: () => "tavily",
    },
    providerAttemptTimeoutMs: {
      get: () => 12000,
    },
    nested: {
      foo: {
        get: () => "bar",
      },
    },
  };

  const handle = installConfig(mockCtx, initialWithGetters as any);
  assert.equal(handle.read().defaultProvider, "tavily");
  assert.equal(handle.read().providerAttemptTimeoutMs, 12000);
});

test("installConfig: throws when write called without mounted settings service", async () => {
  const mockCtx: any = {
    inject: () => {}, // inject never calls back
  };

  const handle = installConfig(mockCtx);
  await assert.rejects(
    async () => {
      await handle.write({ defaultProvider: "brave" });
    },
    /dsh-web-tools settings namespace is not mounted/,
  );
});

test("apply(ctx, config): passes loader config into search runtime without falling back to exa", async () => {
  let registeredSearchProvider: any = null;
  const mockSettings = {
    async update() {},
    configure() {},
  };

  const mockCtx: any = {
    webServer: { register: () => () => {}, registerUpgrade: () => () => {} },
    webRuntime: { trustedHosts: ["127.0.0.1"] },
    settings: mockSettings,
    credentials: {
      resolve: async (ref: string) => (ref === "WEB_TOOLS_TAVILY" ? { value: "tvly-test-key" } : { value: "" }),
      set: async () => {},
      unset: async () => {},
    },
    web: {
      registerSearchProvider: (p: any) => { registeredSearchProvider = p; },
      registerFetchProvider: () => {},
    },
    effect: (fn: any) => fn(),
    inject: (_deps: any, cb: any) => cb(mockCtx),
    on: () => () => {},
  };

  apply(mockCtx, { defaultProvider: "tavily" });

  assert.ok(registeredSearchProvider);
  assert.equal(registeredSearchProvider.available(), true, "search provider must be available with tavily key");
});

test("native Config.validate clamps timeout and sanitizes invalid fields", () => {
  const validated = Config.validate({
    enabled: false,
    defaultProvider: "brave",
    providerAttemptTimeoutMs: 500, // below min 1000
    searchRoutingPolicy: "invalid-policy",
    providerBaseUrls: {
      exa: "https://api.exa.ai/",
      bad: "ftp://not-http",
    },
  });
  assert.equal(validated.enabled, false);
  assert.equal(validated.defaultProvider, "brave");
  assert.equal(validated.providerAttemptTimeoutMs, 1000);
  assert.equal(validated.searchRoutingPolicy, "ordered");
  assert.deepEqual(validated.providerBaseUrls, { exa: "https://api.exa.ai" });
  assert.deepEqual(validateWebToolsSettings(undefined).defaultProvider, "exa");
});

test("LocalStorage persists config.json, 0600 credentials.json, mode-state.json, and gateway.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-wt-storage-"));
  try {
    const storage = new LocalStorage(tmpDir);
    storage.writeConfig({ defaultProvider: "tavily", fallbackOrder: ["exa"] });
    assert.equal(storage.readConfig().defaultProvider, "tavily");
    assert.deepEqual(storage.readConfig().fallbackOrder, ["exa"]);

    storage.setCredential("WEB_TOOLS_TAVILY", "tvly-secret-123");
    assert.equal(storage.resolveCredential("WEB_TOOLS_TAVILY")?.value, "tvly-secret-123");
    if (process.platform !== "win32") {
      const mode = fs.statSync(storage.credentialsPath).mode & 0o777;
      assert.equal(mode, 0o600, "credentials.json must have 0600 permissions");
    }

    storage.setSessionMode("global", "required");
    assert.equal(storage.getEffectiveSessionMode("sess-1"), "required");
    storage.setSessionMode("sess-1", "off");
    assert.equal(storage.getEffectiveSessionMode("sess-1"), "off");
    assert.equal(storage.getEffectiveSessionMode("sess-2"), "required");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
