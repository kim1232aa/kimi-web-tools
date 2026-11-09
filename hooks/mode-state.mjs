import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const modes = new Set(["auto", "required", "off"]);

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be a positive integer${maximum === Number.MAX_SAFE_INTEGER ? "" : ` between 1 and ${maximum}`}`);
  }
  return number;
}

export function webToolsDir() {
  return path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), ".kimi-code"), "web-tools");
}

export function readModeState(file = path.join(webToolsDir(), "mode-state.json")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { globalMode: "auto", sessions: {}, updatedAt: Date.now() };
    throw error;
  }
  const doc = JSON.parse(raw);
  if (!doc || !modes.has(doc.globalMode) || !doc.sessions || typeof doc.sessions !== "object" || Array.isArray(doc.sessions)) {
    throw new Error(`Invalid mode-state document: ${file}`);
  }
  for (const [id, entry] of Object.entries(doc.sessions)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || (entry.mode !== undefined && !modes.has(entry.mode))) {
      throw new Error(`Invalid mode-state session: ${id}`);
    }
  }
  return doc;
}

export function updateModeState(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (fd !== undefined) {
          fs.closeSync(fd);
          fs.unlinkSync(lock);
        }
        throw error;
      }
      try {
        const before = fs.statSync(lock);
        const pid = Number(fs.readFileSync(lock, "utf8"));
        // ponytail: single-host PID locks; use an OS lock for shared filesystems.
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probeError) {
            if (probeError.code === "ESRCH") {
              const current = fs.statSync(lock);
              if (current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
                fs.unlinkSync(lock);
                process.stderr.write(`Kimi Web Tools: reclaimed mode-state lock owned by exited PID ${pid}\n`);
              }
              continue;
            }
            if (probeError.code !== "EPERM") throw probeError;
          }
        }
      } catch (readError) {
        if (readError.code !== "ENOENT") throw readError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out updating mode-state: ${file}`);
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
  }
  let temporary;
  try {
    const doc = readModeState(file);
    change(doc);
    doc.updatedAt = Date.now();
    temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    temporary = undefined;
    return doc;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export function effectiveMode(doc, sessionId) {
  const entry = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : undefined;
  return sessionId === "global" || sessionId === "default" ? doc.globalMode : (entry?.mode ?? doc.globalMode);
}

export function newTurn(doc, sessionId) {
  const mode = effectiveMode(doc, sessionId);
  const previous = Object.hasOwn(doc.sessions, sessionId) ? doc.sessions[sessionId] : {};
  const turn = {
    turn: (previous.turn?.turn ?? 0) + 1,
    required: mode === "required", disabled: mode === "off",
    webSearchCompleted: false, webSearchSucceeded: false,
    webFetchCompleted: false, webFetchSucceeded: false, correctionCount: 0,
  };
  Object.defineProperty(doc.sessions, sessionId, {
    value: { ...previous, turn, pendingTools: [], updatedAt: Date.now() },
    writable: true, enumerable: true, configurable: true,
  });
  return turn;
}

export function classifyOwnTool(name) {
  if (["web_search", "mcp__web__web_search", "mcp__plugin-kimi-web-tools_web__web_search"].includes(name)) return "web_search";
  if (["web_fetch", "mcp__web__web_fetch", "mcp__plugin-kimi-web-tools_web__web_fetch"].includes(name)) return "web_fetch";
  return undefined;
}

export async function hookPayload() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

export function hookFailure(error) {
  console.error(`Kimi Web Tools mode-state error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
