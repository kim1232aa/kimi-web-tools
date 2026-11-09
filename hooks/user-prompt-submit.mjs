#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  effectiveMode,
  newTurn,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

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

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const payload = await hookPayload();
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";

  const baseDir = webToolsDir();
  const modeStatePath = path.join(baseDir, "mode-state.json");
  const configPath = path.join(baseDir, "config.json");

  let mode = "auto";
  let turnState;
  updateModeState(modeStatePath, (doc) => {
    mode = effectiveMode(doc, sessionId);
    turnState = newTurn(doc, sessionId);
    doc.activeSessionId = sessionId;
  });

  const cfg = readJsonFile(configPath, {});
  const platforms = cfg?.platformEnabled ?? { xiaohongshu: true, x: true };
  const platformsEnabled = platforms.xiaohongshu !== false || platforms.x !== false;
  const turnBinding = `Pass session_id="${sessionId}" and turn_id=${turnState.turn} when calling web_search or web_fetch.`;

  if (mode === "off") {
    process.stdout.write(`${SEARCH_DISABLED_TEXT}\n`);
  } else if (mode === "required") {
    const baseText = platformsEnabled ? REQUIRED_SEARCH_TEXT : REQUIRED_SEARCH_TEXT_NO_PLATFORMS;
    process.stdout.write(`${baseText}\n${turnBinding}\n`);
  } else {
    process.stdout.write(`${SEARCH_AUTO_TEXT}\n${turnBinding}\n`);
  }
}

main().catch(hookFailure);
