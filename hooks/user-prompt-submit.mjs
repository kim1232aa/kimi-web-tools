#!/usr/bin/env node
/**
 * kimi-web-tools — UserPromptSubmit Hook.
 *
 * Freezes the per-turn Search Mode state (`auto`, `required`, `off`) in
 * `$KIMI_CODE_HOME/web-tools/mode-state.json` when a user prompt begins,
 * records the active session ID, and outputs the step-1 Search Mode policy
 * snapshot so the model knows whether web research is optional, required,
 * or disabled for this turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_SEARCH_TEXT = [
  "Web Search is required for this turn.",
  "Before finalizing, complete at least one web_search or web_fetch call.",
  "Use web_fetch for a specific URL; otherwise use web_search.",
  "To target a platform, use exactly one routing prefix such as 小红书: or X:; do not repeat the platform name as a topic keyword.",
  "The provider removes that routing prefix before entering the platform search box.",
  "Treat web_search snippets as discovery evidence, not page details or comments.",
  "Describe comments or replies as verified only when web_fetch returns their contents.",
  "If web access fails, say what could not be verified.",
].join("\n");

const REQUIRED_SEARCH_TEXT_NO_PLATFORMS = [
  "Web Search is required for this turn.",
  "Before finalizing, complete at least one web_search or web_fetch call.",
  "Use web_fetch for a specific URL; otherwise use web_search.",
  "Treat web_search snippets as discovery evidence, not page details or comments.",
  "Describe comments or replies as verified only when web_fetch returns their contents.",
  "If web access fails, say what could not be verified.",
].join("\n");

const SEARCH_DISABLED_TEXT =
  "Web search is switched OFF for this session. Do not call web_search or web_fetch; answer from the context you already have. If a question truly requires fresh web data, say what could not be verified.";

const SEARCH_AUTO_TEXT =
  "Web search is available but not required. Call web_search (or web_fetch for a specific URL) when the answer needs current, external, or verifiable information; otherwise answer directly from the context you already have.";

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
  const sessionId = typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";

  const baseDir = getWebToolsDir();
  const modeStatePath = path.join(baseDir, "mode-state.json");
  const configPath = path.join(baseDir, "config.json");

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

  const prevTurn = sessionEntry.turn?.turn ?? 0;
  const turnState = {
    turn: prevTurn + 1,
    required: effectiveMode === "required",
    disabled: effectiveMode === "off",
    webSearchCompleted: false,
    webSearchSucceeded: false,
    webFetchCompleted: false,
    webFetchSucceeded: false,
    correctionCount: 0,
  };

  doc.activeSessionId = sessionId;
  doc.sessions[sessionId] = {
    ...sessionEntry,
    turn: turnState,
    pendingTools: [],
    updatedAt: Date.now(),
  };
  doc.updatedAt = Date.now();
  writeAtomic(modeStatePath, doc);

  const cfg = readJsonFile(configPath, {});
  const platforms = cfg?.platformEnabled ?? { xiaohongshu: true, x: true };
  const platformsEnabled = platforms.xiaohongshu !== false || platforms.x !== false;

  if (effectiveMode === "off") {
    process.stdout.write(`${SEARCH_DISABLED_TEXT}\n`);
  } else if (effectiveMode === "required") {
    process.stdout.write(`${platformsEnabled ? REQUIRED_SEARCH_TEXT : REQUIRED_SEARCH_TEXT_NO_PLATFORMS}\n`);
  } else {
    process.stdout.write(`${SEARCH_AUTO_TEXT}\n`);
  }
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
