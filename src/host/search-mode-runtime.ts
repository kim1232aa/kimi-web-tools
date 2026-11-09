/**
 * kimi-web-tools — "Web Research mode" per-session turn policy (Search Mode).
 *
 * The layer sits ABOVE the provider layer: providers only execute web tools;
 * this module decides whether a turn must complete a web research call
 * (web_search OR web_fetch) before it may end. Everything is Host-owned so
 * browser refresh / session switch / relaunch cannot desync the button from
 * the real policy.
 *
 * When a `LocalStorage` instance is supplied, mode and turn state are synced
 * with `$KIMI_CODE_HOME/web-tools/mode-state.json` so standalone gateway,
 * MCP server, and Kimi Code hooks share one authoritative state.
 * When constructed without storage (e.g. unit tests), it operates purely
 * in-memory with zero side effects.
 * @module
 */
import type { WebToolsContext, WebToolsCommandDefinition, WebToolsCommandInvocation, WebToolsCommandResult } from "./context-types.ts";
import type { SearchMode, SearchModeView } from "../shared/api-types.ts";
import { nextSearchMode } from "../shared/api-types.ts";
import type { LocalStorage } from "./local-storage.ts";

/** The user-facing modes. */
export type { SearchMode };

/** Per-turn tracking (frozen per turn; mode flips only affect the next turn). */
export interface TurnState {
  turn: number;
  required: boolean;
  /** True when this turn runs with web search switched OFF (tools withheld). */
  disabled: boolean;
  webSearchCompleted: boolean;
  webSearchSucceeded: boolean;
  webFetchCompleted: boolean;
  webFetchSucceeded: boolean;
  correctionCount: number;
}

/** Whether the turn has completed ANY web research (search OR fetch). */
export function webResearchCompleted(state: TurnState): boolean {
  return state.webSearchCompleted || state.webFetchCompleted;
}

/** The turn policy lines every required turn needs, regardless of platform routing. */
const REQUIRED_SEARCH_CORE_LINES = [
  "Web Search is required for this turn.",
  "Before finalizing, complete at least one web_search or web_fetch call.",
  "Use web_fetch for a specific URL; otherwise use web_search.",
  "Treat web_search snippets as discovery evidence, not page details or comments.",
  "Describe comments or replies as verified only when web_fetch returns their contents.",
  "If web access fails, say what could not be verified.",
];

/**
 * The two lines that only make sense while a platform source (Xiaohongshu / X)
 * is enabled: they advertise a routing prefix the provider strips before the
 * platform search box.
 */
const REQUIRED_SEARCH_PLATFORM_LINES = [
  "To target a platform, use exactly one routing prefix such as 小红书: or X:; do not repeat the platform name as a topic keyword.",
  "The provider removes that routing prefix before entering the platform search box.",
];

/** The injected "you must research" instruction the model sees on step 1. */
export const REQUIRED_SEARCH_TEXT = [
  ...REQUIRED_SEARCH_CORE_LINES.slice(0, 3),
  ...REQUIRED_SEARCH_PLATFORM_LINES,
  ...REQUIRED_SEARCH_CORE_LINES.slice(3),
].join("\n");

/** Same policy with the platform-routing lines dropped (both platforms off). */
export const REQUIRED_SEARCH_TEXT_NO_PLATFORMS = REQUIRED_SEARCH_CORE_LINES.join("\n");

/**
 * Pick the policy text for the live configuration.
 */
export function requiredSearchText(platformsEnabled?: boolean): string {
  return platformsEnabled === false ? REQUIRED_SEARCH_TEXT_NO_PLATFORMS : REQUIRED_SEARCH_TEXT;
}

/** One-shot steer used when the model tries to end without researching. */
export const REQUIRED_SEARCH_CORRECTION_TEXT =
  "Web Search is required for this turn. Call web_search or web_fetch before finalizing.";

/** Native factory replacing `@deepseek-ai/dsh-llm` `createUserMessage`. */
export function defaultCreateUserMessage(input: unknown): unknown {
  if (input && typeof input === "object") {
    return { ...(input as Record<string, unknown>) };
  }
  return { content: [{ type: "text", text: String(input ?? "") }] };
}

/**
 * Per-session state machine: one mode per session, one frozen flag per turn.
 * Optionally backed by `LocalStorage` (`mode-state.json`) for cross-process sync.
 */
export class SearchModeRuntime {
  private readonly modes = new Map<string, SearchMode>();
  private readonly turns = new Map<string, TurnState>();
  private readonly searchAvailable: () => boolean;
  private readonly storage?: LocalStorage;

  constructor(searchAvailable: () => boolean = () => true, storage?: LocalStorage) {
    this.searchAvailable = searchAvailable;
    this.storage = storage;
    if (this.storage) {
      this.syncFromStorage();
    }
  }

  /** Reload in-memory maps from `mode-state.json` when storage is attached. */
  syncFromStorage(): void {
    if (!this.storage) return;
    const doc = this.storage.readModeState();
    this.modes.clear();
    if (doc.globalMode !== "auto") {
      this.modes.set("global", doc.globalMode);
    }
    for (const [sid, rec] of Object.entries(doc.sessions)) {
      if (rec.mode && rec.mode !== "auto") {
        this.modes.set(sid, rec.mode);
      }
      if (rec.turn) {
        this.turns.set(sid, rec.turn);
      }
    }
  }

  getMode(sessionId: string): SearchMode {
    if (this.storage) {
      return this.storage.getEffectiveSessionMode(sessionId);
    }
    return this.modes.get(sessionId) ?? "auto";
  }

  setMode(sessionId: string, mode: SearchMode): void {
    if (mode === "auto") this.modes.delete(sessionId);
    else this.modes.set(sessionId, mode);
    if (this.storage) {
      this.storage.setSessionMode(sessionId, mode);
    }
  }

  /** True when this session has web search switched OFF. */
  isOff(sessionId: string): boolean {
    return this.getMode(sessionId) === "off";
  }

  /** Whether a usable search provider currently exists (drives `available`). */
  available(): boolean {
    try {
      return this.searchAvailable() === true;
    } catch {
      return true;
    }
  }

  /**
   * Begin (or re-read) a turn. The `required` flag is frozen when a NEW turn
   * begins; mid-turn mode flips only affect the NEXT turn (no race).
   */
  beginTurn(sessionId: string, turn: number): TurnState {
    if (this.storage) {
      const persisted = this.storage.getTurnState(sessionId);
      if (persisted && persisted.turn === turn) {
        this.turns.set(sessionId, persisted);
        return persisted;
      }
    }
    const existing = this.turns.get(sessionId);
    if (existing?.turn === turn) return existing;
    const state: TurnState = {
      turn,
      required: this.getMode(sessionId) === "required",
      disabled: this.isOff(sessionId),
      webSearchCompleted: false,
      webSearchSucceeded: false,
      webFetchCompleted: false,
      webFetchSucceeded: false,
      correctionCount: 0,
    };
    this.turns.set(sessionId, state);
    if (this.storage) {
      this.storage.setTurnState(sessionId, state);
    }
    return state;
  }

  /**
   * Record that a web_search call COMPLETED.
   */
  markSearchResult(sessionId: string, succeeded: boolean): void {
    const state = this.getTurn(sessionId);
    if (!state) return;
    state.webSearchCompleted = true;
    state.webSearchSucceeded ||= succeeded;
    this.turns.set(sessionId, state);
    if (this.storage) {
      this.storage.setTurnState(sessionId, state);
    }
  }

  /**
   * Record that a web_fetch call COMPLETED.
   */
  markFetchResult(sessionId: string, succeeded: boolean): void {
    const state = this.getTurn(sessionId);
    if (!state) return;
    state.webFetchCompleted = true;
    state.webFetchSucceeded ||= succeeded;
    this.turns.set(sessionId, state);
    if (this.storage) {
      this.storage.setTurnState(sessionId, state);
    }
  }

  getTurn(sessionId: string): TurnState | undefined {
    if (this.storage) {
      const persisted = this.storage.getTurnState(sessionId);
      if (persisted) {
        this.turns.set(sessionId, persisted);
        return persisted;
      }
    }
    return this.turns.get(sessionId);
  }

  /** Drop every state for a disposed agent/session. */
  clear(sessionId: string): void {
    this.modes.delete(sessionId);
    this.turns.delete(sessionId);
    if (this.storage) {
      this.storage.clearSession(sessionId);
    }
  }

  view(sessionId: string): SearchModeView {
    return { mode: this.getMode(sessionId), available: this.available() };
  }
}

/** Deps for wiring the runtime into the host context. */
export interface SearchModeRuntimeDeps {
  /** True when a usable search provider exists (from the plugin's provider). */
  searchAvailable: () => boolean;
}

export interface SearchModeMessages {
  /** Step 1 (once per turn): the compact research policy. */
  required(): unknown;
  /** Step 1 (once per turn): search is allowed on demand (default mode). */
  auto(): unknown;
  /** Step 1 (once per turn): web search is switched off for this session. */
  disabled(): unknown;
  /** turn-stopping steer (one-shot notice). */
  correction(): unknown;
}

/** One-shot notice injected on step 1 of an `off` turn. */
export const SEARCH_DISABLED_TEXT =
  "Web search is switched OFF for this session. Do not call web_search or web_fetch; answer from the context you already have. If a question truly requires fresh web data, say what could not be verified.";

/** One-shot policy injected on step 1 of an `auto` turn. */
export const SEARCH_AUTO_TEXT =
  "Web search is available but not required. Call web_search (or web_fetch for a specific URL) when the answer needs current, external, or verifiable information; otherwise answer directly from the context you already have.";

/**
 * Build the injected messages with `createUserMessage` ({ content, source }).
 */
export function createSearchModeMessages(
  createUserMessage: (input: unknown) => unknown = defaultCreateUserMessage,
  platformsEnabled?: () => boolean,
): SearchModeMessages {
  const snapshot = (text: string, section: string) =>
    createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin:dsh-web-tools",
        plugin: "dsh-web-tools",
        form: "snapshot",
        sections: [{ name: section, text }],
      },
    });
  const policyText = () => {
    let enabled = true;
    if (platformsEnabled !== undefined) {
      try {
        enabled = platformsEnabled() !== false;
      } catch {
        enabled = true;
      }
    }
    return requiredSearchText(enabled);
  };
  return {
    required: () => snapshot(policyText(), "web-search-mode"),
    auto: () => snapshot(SEARCH_AUTO_TEXT, "web-search-mode"),
    disabled: () =>
      createUserMessage({
        content: [{ type: "text", text: SEARCH_DISABLED_TEXT }],
        source: {
          kind: "plugin:dsh-web-tools",
          plugin: "dsh-web-tools",
          form: "notice",
          summary: "Web Search disabled",
        },
      }),
    correction: () =>
      createUserMessage({
        content: [{ type: "text", text: REQUIRED_SEARCH_CORRECTION_TEXT }],
        source: {
          kind: "plugin:dsh-web-tools",
          plugin: "dsh-web-tools",
          form: "notice",
          summary: "Web Search required",
        },
      }),
  };
}

/**
 * Decide which pre-step Search Mode message (if any) to inject for one step.
 */
export function searchModeStepMessage(
  state: TurnState | undefined,
  step: number,
  messages: SearchModeMessages,
): unknown | undefined {
  if (!state) return undefined;
  if (step !== 1) return undefined;
  if (state.disabled) return messages.disabled();
  if (state.required) return messages.required();
  return messages.auto();
}

/** An agent-scoped context that can subscribe to its own pre-step result. */
interface AgentScopedCtx {
  on(event: string, listener: (...args: any[]) => unknown, options?: unknown): () => void;
  effect(fn: () => void | (() => void), label?: string): void;
  /** Per-scope tool surface (may be absent on older hosts). */
  tools?: {
    restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void;
    guard?(guard: (execution: { name: string }) => string | undefined): () => void;
  };
}

/** The two model-facing web tools this plugin owns the policy for. */
export const WEB_TOOL_NAMES: readonly string[] = ["web_search", "web_fetch"];

/** Denial reason shown to the model when it calls a web tool while OFF. */
export const WEB_DISABLED_DENIAL =
  "Web search is switched OFF for this session, so this tool call was denied. Answer from the existing context and state what could not be verified.";

interface ScopedAgent {
  id: string;
  ctx: AgentScopedCtx;
  steer(input: unknown): void;
  cancel(cause: unknown): void;
}

/**
 * Wire the Search Mode runtime into a host context.
 */
export function installSearchModeRuntime(
  ctx: WebToolsContext,
  _deps: SearchModeRuntimeDeps,
  runtime: SearchModeRuntime,
  messages: SearchModeMessages,
) {
  const onCreated = ctx.on("agent/created", (payload: { agent: ScopedAgent }) => {
    const agent = payload.agent;
    return agent.ctx.effect(() => {
      let liftRestriction: (() => void) | undefined;
      const syncRestriction = () => {
        const off = runtime.isOff(agent.id);
        if (off && liftRestriction === undefined) {
          liftRestriction = agent.ctx.tools?.restrict?.({ deny: [...WEB_TOOL_NAMES] });
        } else if (!off && liftRestriction !== undefined) {
          liftRestriction();
          liftRestriction = undefined;
        }
      };
      const stopGuard = agent.ctx.tools?.guard?.((execution) =>
        runtime.isOff(agent.id) && WEB_TOOL_NAMES.includes(execution.name) ? WEB_DISABLED_DENIAL : undefined,
      );

      const stopPreStep = agent.ctx.on(
        "agent/pre-step",
        async (payload: { turn: number; step: number; signal?: AbortSignal }, next: () => Promise<unknown>) => {
          const decision = await next();
          if (!decision || (decision as { kind?: string }).kind === "reject") return decision;
          if (payload.signal?.aborted) return decision;
          const state = runtime.beginTurn(agent.id, payload.turn);
          syncRestriction();
          const inject = searchModeStepMessage(state, payload.step, messages);
          if (!inject) return decision;
          const entered = decision as { kind: "enter"; messages: unknown[] };
          return {
            kind: "enter",
            messages: [inject, ...(entered.messages ?? [])],
          };
        },
      );

      const stopResult = agent.ctx.on(
        "tools/result",
        (exec: { name?: string; agent?: { id: string } | null }, result: { isError?: boolean }) => {
          if (!exec.agent?.id) return;
          const succeeded = result?.isError === false;
          if (exec?.name === "web_search") runtime.markSearchResult(exec.agent.id, succeeded);
          else if (exec?.name === "web_fetch") runtime.markFetchResult(exec.agent.id, succeeded);
        },
      );

      const stopStopping = agent.ctx.on(
        "agent/turn-stopping",
        (payload: { turn: number; signal?: AbortSignal }) => {
          if (payload.signal?.aborted) return;
          const state = runtime.getTurn(agent.id);
          if (!state?.required || webResearchCompleted(state)) return;
          if (state.correctionCount === 0) {
            state.correctionCount += 1;
            agent.steer(messages.correction());
            return;
          }
          agent.cancel({ kind: "hook", reason: "required web research was not completed" });
        },
      );

      return () => {
        stopPreStep?.();
        stopResult?.();
        stopStopping?.();
        stopGuard?.();
        if (liftRestriction !== undefined) {
          liftRestriction();
          liftRestriction = undefined;
        }
        runtime.clear(agent.id);
      };
    }, "dsh-web-tools: search-mode agent listeners");
  });

  const offCommands = registerSearchCommands(ctx, runtime);
  return () => {
    onCreated?.();
    offCommands?.();
  };
}

/** Register the slash command, toggling the SAME mode. */
export function registerSearchCommands(
  ctx: WebToolsContext,
  runtime: SearchModeRuntime,
): (() => void) | undefined {
  const commands = ctx.commands;
  if (!commands?.register) return undefined;
  const off: Array<() => void> = [];
  const make = (name: string): WebToolsCommandDefinition => ({
    name,
    description: "开启或关闭联网搜索",
    handler: (invocation: WebToolsCommandInvocation) => toggleCommandHandler(runtime, invocation),
  });
  const a = commands.register(make("search"));
  off.push(a);
  return () => {
    for (const d of off) d();
  };
}

function toggleCommandHandler(
  runtime: SearchModeRuntime,
  invocation: WebToolsCommandInvocation,
): WebToolsCommandResult {
  const id = String(invocation.agent?.id ?? "");
  if (!id) return { kind: "error", text: "no session" };
  const next = nextSearchMode(runtime.getMode(id));
  runtime.setMode(id, next);
  const text =
    next === "required"
      ? "联网搜索已开启（每轮强制搜索）"
      : next === "off"
        ? "联网搜索已关闭（不提供联网工具，Agent 不能搜索）"
        : "联网搜索已恢复为自动（Agent 自行判断是否需要搜索）";
  return { kind: "success", text };
}
