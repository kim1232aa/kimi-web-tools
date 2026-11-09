#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WEB_DISABLED_DENIAL =
  "Web search is switched OFF for this session, so this tool call was denied. Answer from the existing context and state what could not be verified.";

function getWebToolsDir() {
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  const home = explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), ".kimi-code");
  return path.join(home, "web-tools");
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function classifyWebTool(toolName) {
  const name = String(toolName || "");
  if (name === "web_search" || name.endsWith("__web_search") || name.endsWith("__search_web") || name.endsWith("__search")) return "web_search";
  if (name === "web_fetch" || name.endsWith("__web_fetch") || name === "FetchURL" || name.endsWith("__fetch")) return "web_fetch";
  return null;
}

async function main() {
  const payload = await readStdinJson();
  const kind = classifyWebTool(payload.tool_name);
  if (!kind) {
    process.exit(0);
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const modeStatePath = path.join(getWebToolsDir(), "mode-state.json");
  const doc = readJsonFile(modeStatePath, { globalMode: "auto", sessions: {}, updatedAt: Date.now() });
  if (!doc.sessions || typeof doc.sessions !== "object") doc.sessions = {};

  const globalMode =
    doc.globalMode === "required" || doc.globalMode === "off" || doc.globalMode === "auto"
      ? doc.globalMode
      : "auto";
  const sessionEntry = doc.sessions[sessionId] || {};
  const effectiveMode =
    sessionEntry.mode === "required" || sessionEntry.mode === "off" || sessionEntry.mode === "auto"
      ? sessionEntry.mode
      : globalMode;

  const isDisabled = effectiveMode === "off" || sessionEntry.turn?.disabled === true;
  if (isDisabled) {
    process.stderr.write(WEB_DISABLED_DENIAL);
    process.exit(2);
  }

  const turn = sessionEntry.turn || {
    turn: 1,
    required: effectiveMode === "required",
    disabled: false,
    webSearchCompleted: false,
    webSearchSucceeded: false,
    webFetchCompleted: false,
    webFetchSucceeded: false,
    correctionCount: 0,
  };
  if (kind === "web_search") {
    turn.webSearchCompleted = true;
  } else if (kind === "web_fetch") {
    turn.webFetchCompleted = true;
  }

  const pendingTools = Array.isArray(sessionEntry.pendingTools) ? [...sessionEntry.pendingTools] : [];
  pendingTools.push(`${kind}:${payload.tool_call_id || Date.now()}`);

  doc.activeSessionId = sessionId;
  doc.sessions[sessionId] = {
    ...sessionEntry,
    turn,
    pendingTools: pendingTools.slice(-20),
    updatedAt: Date.now(),
  };
  doc.updatedAt = Date.now();
  writeAtomic(modeStatePath, doc);

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
