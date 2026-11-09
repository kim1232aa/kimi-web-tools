import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalStorage } from "../src/host/local-storage.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ownSearch = "mcp__plugin-kimi-web-tools_web__web_search";

function fixture(t: any) {
  const parent = path.join(root, "temp", "required-mode-tests");
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, "case-"));
  const storage = new LocalStorage(path.join(home, "web-tools"));
  storage.ensureDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hook = (file: string, payload: object) => spawnSync(process.execPath, [path.join(root, "hooks", file)], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, KIMI_CODE_HOME: home },
  });
  return { home, storage, hook };
}

test("required prompt binds tool calls to the actual session", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  const result = hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /session_id.*session-a/);
  assert.match(result.stdout, /turn_id/);
});

test("pre-tool does not count a call as completed and rejects a different session", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const pre = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_call_id: "call-a",
    tool_input: { query: "example", session_id: "session-a", turn_id: storage.getTurnState("session-a")!.turn },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
  const stop = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(stop.status, 2);
  const wrongSession = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch,
    tool_input: { session_id: "session-b" },
  });
  assert.equal(wrongSession.status, 2);
  assert.match(wrongSession.stderr, /session-a/);
});

test("mode changes take effect without stale frozen turn flags", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "auto");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  storage.setSessionMode("global", "required");
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 2);
  storage.setSessionMode("global", "off");
  assert.equal(hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name: ownSearch }).status, 2);
  storage.setSessionMode("global", "auto");
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 0);
});

test("auto mode allows optional binding to be omitted but rejects an explicit different session", (t) => {
  const { storage, hook } = fixture(t);
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const ordinary = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_input: { query: "example" },
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const incorrect = hook("pre-tool-gate.mjs", {
    session_id: "session-a", tool_name: ownSearch, tool_input: { query: "example", session_id: "session-b" },
  });
  assert.equal(incorrect.status, 2);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
});

test("other MCP tools neither satisfy required mode nor get blocked by off mode", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "off");
  for (const tool_name of ["FetchURL", "mcp__9router__search", "mcp__agy-search__search_web", "mcp__tavily__tavily_search"]) {
    assert.equal(hook("pre-tool-gate.mjs", { session_id: "session-a", tool_name }).status, 0);
  }
  assert.equal(storage.getTurnState("session-a"), undefined);
});

test("actual completed calls satisfy only their own turn; every next round resets", (t) => {
  const { storage, hook } = fixture(t);
  storage.setSessionMode("global", "required");
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  const first = storage.getTurnState("session-a")!;
  assert.equal(typeof (storage as any).completeTool, "function");
  (storage as any).completeTool("session-a", "web_search", true, first.turn);
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 0);
  hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.notEqual(storage.getTurnState("session-a")!.turn, first.turn);
  (storage as any).completeTool("session-a", "web_search", true, first.turn);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, false);
  assert.equal(hook("stop-turn-gate.mjs", { session_id: "session-a" }).status, 2);
  const second = storage.getTurnState("session-a")!;
  (storage as any).completeTool("session-a", "web_search", false, second.turn);
  assert.equal(storage.getTurnState("session-a")!.webSearchCompleted, true);
  assert.equal(storage.getTurnState("session-a")!.webSearchSucceeded, false);
  const failed = hook("stop-turn-gate.mjs", { session_id: "session-a" });
  assert.equal(failed.status, 0);
  assert.match(failed.stdout, /fail|未验证/i);
});

test("simultaneous sessions keep separate turn state", async (t) => {
  const { home, storage } = fixture(t);
  storage.setSessionMode("global", "required");
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "hooks/user-prompt-submit.mjs")], {
      env: { ...process.env, KIMI_CODE_HOME: home }, stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
    child.stdin.end(JSON.stringify({ session_id: `parallel-${index}` }));
  })));
  for (let index = 0; index < 8; index++) assert.ok(storage.getTurnState(`parallel-${index}`));
});

test("corrupt mode state fails visibly instead of pretending auto mode", (t) => {
  const { storage, hook } = fixture(t);
  fs.writeFileSync(storage.modeStatePath, "{broken");
  const result = hook("user-prompt-submit.mjs", { session_id: "session-a" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode-state|JSON|parse/i);
  assert.equal(fs.readFileSync(storage.modeStatePath, "utf8"), "{broken");
});
