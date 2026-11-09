#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_SEARCH_CORRECTION_TEXT =
  "Web Search is required for this turn. Call web_search or web_fetch before finalizing.";

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

async function main() {
  const payload = await readStdinJson();

  if (payload.stop_hook_active) {
    process.exit(0);
  }
  if (payload.agent_id && payload.agent_id !== "main") {
    process.exit(0);
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const modeStatePath = path.join(getWebToolsDir(), "mode-state.json");
  const doc = readJsonFile(modeStatePath, { globalMode: "auto", sessions: {}, updatedAt: Date.now() });
  if (!doc.sessions || typeof doc.sessions !== "object") {
    process.exit(0);
  }

  const globalMode =
    doc.globalMode === "required" || doc.globalMode === "off" || doc.globalMode === "auto"
      ? doc.globalMode
      : "auto";
  const sessionEntry = doc.sessions[sessionId] || {};
  const effectiveMode =
    sessionEntry.mode === "required" || sessionEntry.mode === "off" || sessionEntry.mode === "auto"
      ? sessionEntry.mode
      : globalMode;

  const turn = sessionEntry.turn || {
    turn: 1,
    required: effectiveMode === "required",
    disabled: effectiveMode === "off",
    webSearchCompleted: false,
    webSearchSucceeded: false,
    webFetchCompleted: false,
    webFetchSucceeded: false,
    correctionCount: 0,
  };

  if (!turn.required || turn.disabled) {
    process.exit(0);
  }

  const completed = Boolean(turn.webSearchCompleted || turn.webFetchCompleted);
  if (completed) {
    process.exit(0);
  }

  if ((turn.correctionCount ?? 0) === 0) {
    turn.correctionCount = 1;
    doc.sessions[sessionId] = {
      ...sessionEntry,
      turn,
      updatedAt: Date.now(),
    };
    doc.updatedAt = Date.now();
    writeAtomic(modeStatePath, doc);

    process.stderr.write(REQUIRED_SEARCH_CORRECTION_TEXT);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
