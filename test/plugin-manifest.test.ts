import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readJson = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("package.json contains only the minimal gateway build and test tooling", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "kimi-web-tools");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./lib/host/gateway-server.js");
  assert.deepEqual(pkg.bin, {
    "kimi-web-tools-gateway": "./bin/gateway-daemon.mjs",
    "kimi-web-tools-mcp": "./bin/mcp-server.mjs",
  });
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["build", "test", "typecheck"]);
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "typescript"]);
});

test("plugin manifest exposes the web MCP server, skill, hooks, and system prompt", () => {
  const manifest = readJson("kimi.plugin.json");
  assert.equal(manifest.name, "kimi-web-tools");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.systemPromptPath, "./SYSTEM.md");
  assert.deepEqual(manifest.mcpServers?.web?.args, ["./bin/mcp-server.mjs"]);
  assert.equal(Array.isArray(manifest.hooks), true);
  assert.equal(manifest.hooks.length, 3);
  assert.equal(Object.hasOwn(manifest, "commands"), false);
});
