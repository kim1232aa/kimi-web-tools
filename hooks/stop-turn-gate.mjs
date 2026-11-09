#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  effectiveMode,
  hookPayload,
  hookFailure,
} from "./mode-state.mjs";

const REQUIRED_SEARCH_CORRECTION_TEXT =
  "Web Search is required for this turn. Call web_search or web_fetch before finalizing.";

const FAILED_RESEARCH_REMINDER =
  "Web research failed during this turn; state clearly what could not be verified (未验证).";

async function main() {
  const payload = await hookPayload();

  if (payload.stop_hook_active) {
    return;
  }
  if (payload.agent_id && payload.agent_id !== "main") {
    return;
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const modeStatePath = path.join(webToolsDir(), "mode-state.json");

  let shouldSteer = false;
  let turnId;
  let failedResearch = false;

  updateModeState(modeStatePath, (doc) => {
    const mode = effectiveMode(doc, sessionId);
    if (mode !== "required") {
      return;
    }
    const sessionEntry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    const turn = sessionEntry.turn || {
      turn: 1,
      required: true,
      disabled: false,
      webSearchCompleted: false,
      webSearchSucceeded: false,
      webFetchCompleted: false,
      webFetchSucceeded: false,
      correctionCount: 0,
    };

    const completed = Boolean(turn.webSearchCompleted || turn.webFetchCompleted);
    const succeeded = Boolean(turn.webSearchSucceeded || turn.webFetchSucceeded);

    if (completed) {
      if (!succeeded) {
        failedResearch = true;
      }
      return;
    }

    if ((turn.correctionCount ?? 0) === 0) {
      turn.correctionCount = 1;
      Object.defineProperty(doc.sessions, sessionId, {
        value: {
          ...sessionEntry,
          turn,
          updatedAt: Date.now(),
        },
        writable: true,
        enumerable: true,
        configurable: true,
      });
      shouldSteer = true;
      turnId = turn.turn;
    }
  });

  if (shouldSteer) {
    process.stderr.write(`${REQUIRED_SEARCH_CORRECTION_TEXT} (session_id="${sessionId}", turn_id=${turnId})`);
    process.exit(2);
  }
  if (failedResearch) {
    process.stdout.write(`${FAILED_RESEARCH_REMINDER}\n`);
  }
}

main().catch(hookFailure);
