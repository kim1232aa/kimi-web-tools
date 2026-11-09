#!/usr/bin/env node
import path from "node:path";
import {
  webToolsDir,
  updateModeState,
  effectiveMode,
  classifyOwnTool,
  hookPayload,
  hookFailure,
  positiveInteger,
} from "./mode-state.mjs";

const WEB_DISABLED_DENIAL =
  "Web search is switched OFF for this session, so this tool call was denied. Answer from the existing context and state what could not be verified.";

async function main() {
  const payload = await hookPayload();
  const kind = classifyOwnTool(payload.tool_name);
  if (!kind) {
    return;
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id.trim() : "global";
  const inputSession =
    payload.tool_input?.session_id ?? payload.tool_input?.sessionId;
  const suppliedInput = payload.tool_input;

  // If the caller explicitly passed a non-empty session_id, it must match the current session
  if (
    typeof inputSession === "string" &&
    inputSession.trim() &&
    inputSession.trim() !== sessionId &&
    inputSession.trim() !== "global"
  ) {
    process.stderr.write(`Session mismatch: pass session_id="${sessionId}" for this plugin's retrieval call.`);
    process.exit(2);
  }

  const modeStatePath = path.join(webToolsDir(), "mode-state.json");
  let blocked = false;

  updateModeState(modeStatePath, (doc) => {
    const mode = effectiveMode(doc, sessionId);
    if (mode === "off") {
      blocked = true;
      return;
    }

    const sessionEntry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
    const input = payload.tool_input ?? {};
    const rawTurn = Object.hasOwn(input, "turn_id") ? input.turn_id : input.turnId;
    const turnId = positiveInteger(rawTurn, "turn_id");

    if (mode === "required" && suppliedInput !== undefined) {
      if (typeof inputSession !== "string" || inputSession.trim() !== sessionId) {
        throw new Error(`Session mismatch: pass session_id="${sessionId}" for this plugin's retrieval call.`);
      }
      if (sessionEntry.turn && turnId !== sessionEntry.turn.turn) {
        throw new Error(`Pass turn_id=${sessionEntry.turn.turn} and session_id="${sessionId}" for the current turn.`);
      }
    } else if (turnId !== undefined && sessionEntry.turn && turnId !== sessionEntry.turn.turn) {
      throw new Error(`Pass turn_id=${sessionEntry.turn.turn} and session_id="${sessionId}" for the current turn.`);
    }

    const pendingTools = Array.isArray(sessionEntry.pendingTools) ? [...sessionEntry.pendingTools] : [];
    pendingTools.push(`${kind}:${payload.tool_call_id || Date.now()}`);
    doc.activeSessionId = sessionId;
    Object.defineProperty(doc.sessions, sessionId, {
      value: {
        ...sessionEntry,
        pendingTools: pendingTools.slice(-20),
        updatedAt: Date.now(),
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  if (blocked) {
    process.stderr.write(WEB_DISABLED_DENIAL);
    process.exit(2);
  }
}

main().catch(hookFailure);
