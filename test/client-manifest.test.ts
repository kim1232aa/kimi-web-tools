/**
 * kimi-web-tools — package & plugin manifest contract tests.
 *
 * Verifies:
 *  - `package.json` declares `kimi-web-tools` v0.4.0 (`type: "module"`) with zero
 *    `@deepseek-ai/*` dependencies or peerDependencies.
 *  - `kimi.plugin.json` declares only the `web` MCP server (`./bin/mcp-server.mjs`)
 *    and keeps the web-search skill and system prompt without hooks or commands.
 *  - `dist/client/app.js` (once built) is completely self-contained and never
 *    references `@deepseek-ai/*`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const readPkg = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;

const readPluginManifest = () =>
  JSON.parse(readFileSync(join(root, "kimi.plugin.json"), "utf8")) as Record<string, any>;

test("package.json declares kimi-web-tools 0.4.0 with zero @deepseek-ai/* dependencies", () => {
  const pkg = readPkg();
  assert.equal(pkg.name, "kimi-web-tools");
  assert.equal(pkg.version, "0.4.0");
  assert.equal(pkg.type, "module");

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  for (const name of Object.keys(allDeps)) {
    assert.ok(!name.startsWith("@deepseek-ai/"), `must not depend on ${name}`);
  }
  for (const required of ["defuddle", "linkedom", "undici", "ws", "react", "react-dom"]) {
    assert.ok(Object.hasOwn(pkg.dependencies ?? {}, required), `missing dependency ${required}`);
  }
});

test("kimi.plugin.json registers the web MCP server without hooks or commands", () => {
  const manifest = readPluginManifest();
  assert.equal(manifest.name, "kimi-web-tools");
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.systemPromptPath, "./SYSTEM.md");
  assert.equal(manifest.mcpServers?.web?.command, "node");
  assert.deepEqual(manifest.mcpServers?.web?.args, ["./bin/mcp-server.mjs"]);
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  assert.equal(Object.hasOwn(manifest, "commands"), false);
  assert.doesNotMatch(manifest.description, /Search Mode|Dashboard/i);
  assert.doesNotMatch(manifest.interface.shortDescription, /Search Mode|Dashboard/i);
});

test("built dist/client/app.js never references @deepseek-ai/* packages", () => {
  const bundlePath = join(root, "dist", "client", "app.js");
  if (!existsSync(bundlePath)) return;
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(!bundle.includes("@deepseek-ai/"), "client bundle must not reference @deepseek-ai/*");
});
