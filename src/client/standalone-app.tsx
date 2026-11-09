/**
 * kimi-web-tools — Standalone Web UI Dashboard Application.
 *
 * Mounts:
 *  - Password login gate when accessed over reverse-proxied public domains.
 *  - Topbar header with brand identity, Session/Global target selector,
 *    the exact `SearchModeButton` (智能联网 / 始终联网 / 关闭联网),
 *    language switch, and Light/Dark theme toggle.
 *  - Main body hosting the full `WebToolsSection` (provider cards, API keys,
 *    drag-and-drop routing order, Xiaohongshu / X browser login, custom sources).
 * @module
 */
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebToolsSection } from "./WebToolsSection.tsx";
import { SearchModeButton } from "./SearchModeButton.tsx";
import { zhDict, enDict } from "./i18n-dict.ts";
import { translateDict } from "./logic.ts";
import { adoptWebToolsStyles } from "./ui/styles.ts";
import { CURRENT_VERSION } from "../shared/version.ts";
import { text, surface } from "./theme.ts";
import type { UiFace } from "./registration.ts";

type ThemeMode = "light" | "dark";
type LangMode = "zh" | "en";

interface SessionInfo {
  id: string;
  mode: string;
  updatedAt?: number;
}

const localeSubscribers = new Set<() => void>();
let activeLocale: LangMode = "zh";

function setGlobalLocale(next: LangMode) {
  activeLocale = next;
  try {
    localStorage.setItem("kimi-wt-lang", next);
  } catch {}
  for (const fn of localeSubscribers) fn();
}

function getInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("kimi-wt-theme");
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {}
  return "light";
}

function getInitialLang(): LangMode {
  try {
    const saved = localStorage.getItem("kimi-wt-lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {}
  return "zh";
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

export function StandaloneApp() {
  adoptWebToolsStyles();

  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const [lang, setLang] = useState<LangMode>(() => {
    const init = getInitialLang();
    activeLocale = init;
    return init;
  });
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [sessionId, setSessionId] = useState<string>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("session") || "global";
    } catch {
      return "global";
    }
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("kimi-wt-theme", theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    fetch("/web-tools/auth/session")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && data?.value?.authenticated) {
          setAuthState("authenticated");
        } else {
          setAuthState("unauthenticated");
        }
      })
      .catch(() => {
        if (!cancelled) setAuthState("authenticated");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;
    const pollSessions = async () => {
      try {
        const res = await fetch("/web-tools/mcp/mode", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "get", sessionId }),
        });
        if (res.status === 401) {
          if (!cancelled) setAuthState("unauthenticated");
          return;
        }
        const data = await res.json();
        if (!cancelled && data?.ok && Array.isArray(data?.value?.sessions)) {
          setSessions(data.value.sessions);
        }
      } catch {}
    };
    void pollSessions();
    const timer = setInterval(pollSessions, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, authState]);

  const dict = lang === "en" ? enDict : zhDict;
  const t = useMemo(() => {
    return (key: string, ...args: unknown[]): string => {
      const params =
        args.length === 1 && typeof args[0] === "object" && args[0] !== null
          ? (args[0] as Record<string, unknown>)
          : undefined;
      return translateDict(dict, zhDict, key, params) ?? key;
    };
  }, [dict]);

  const ui: UiFace = useMemo(
    () => ({
      getActiveLocale: () => activeLocale,
      subscribeLocale: (fn: () => void) => {
        localeSubscribers.add(fn);
        return () => localeSubscribers.delete(fn);
      },
      zhDict,
      enDict,
    }),
    [],
  );

  const toggleTheme = () => setTheme((prev) => (prev === "light" ? "dark" : "light"));
  const toggleLang = () => {
    const next: LangMode = lang === "zh" ? "en" : "zh";
    setLang(next);
    setGlobalLocale(next);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordInput.trim() || authSubmitting) return;
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const res = await fetch("/web-tools/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: passwordInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setAuthError(data?.error?.message || (lang === "en" ? "Invalid password" : "访问密码错误"));
        return;
      }
      setPasswordInput("");
      setAuthState("authenticated");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthSubmitting(false);
    }
  };

  const sessionOptions = useMemo(() => {
    const ids = new Set<string>(["global"]);
    for (const s of sessions) {
      if (s.id && s.id !== "global") ids.add(s.id);
    }
    if (sessionId && !ids.has(sessionId)) ids.add(sessionId);
    return Array.from(ids);
  }, [sessions, sessionId]);

  if (authState === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: surface.bg, color: text.secondary, fontSize: 13 }}>
        {lang === "en" ? "Loading Kimi Web Tools..." : "正在加载 Kimi Web Tools..."}
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: surface.bg, color: text.primary, padding: 20 }}>
        <form
          id="loginForm"
          onSubmit={handleLogin}
          style={{
            width: "100%",
            maxWidth: 380,
            background: surface.layer1,
            border: `1px solid ${surface.border}`,
            borderRadius: 12,
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            boxShadow: "var(--dsw-shadow-lv3)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: "var(--dsw-alias-button-primary-fill)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                K
              </div>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Kimi Web Tools</span>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                border: `1px solid ${surface.border}`,
                background: surface.layer2,
                color: text.secondary,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {theme === "light" ? <MoonIcon /> : <SunIcon />}
            </button>
          </div>
          <div style={{ fontSize: 12, color: text.tertiary, lineHeight: "18px" }}>
            {lang === "en"
              ? "Enter the gateway access password to configure search providers, API keys, and Search Mode."
              : "请输入网关访问密码以管理搜索源 API Key、多 Key 轮询池、联网模式与社交平台登录。"}
          </div>
          <input
            id="passwordInput"
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder={lang === "en" ? "Access password..." : "输入访问密码..."}
            autoComplete="current-password"
            required
            style={{
              height: 36,
              padding: "0 12px",
              borderRadius: 8,
              border: `1px solid ${surface.border}`,
              background: surface.layer2,
              color: text.primary,
              fontSize: 13,
              outline: "none",
            }}
          />
          {authError && (
            <div id="loginError" style={{ fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }}>
              {authError}
            </div>
          )}
          <button
            type="submit"
            disabled={authSubmitting}
            style={{
              height: 36,
              borderRadius: 8,
              border: "none",
              background: "var(--dsw-alias-button-primary-fill)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 500,
              cursor: authSubmitting ? "default" : "pointer",
              opacity: authSubmitting ? 0.7 : 1,
            }}
          >
            {authSubmitting ? (lang === "en" ? "Verifying..." : "正在验证...") : (lang === "en" ? "Unlock Dashboard" : "解锁进入")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: surface.bg, color: text.primary }}>
      {/* Topbar Header */}
      <header
        className="kimi-wt-topbar"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: surface.layer1,
          borderBottom: `1px solid ${surface.border}`,
          padding: "10px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        {/* Left: Brand Identity */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "var(--dsw-alias-button-primary-fill)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            K
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: text.primary }}>
              Kimi Web Tools
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                padding: "1px 6px",
                borderRadius: 999,
                background: surface.layer2,
                color: text.tertiary,
                border: `1px solid ${surface.border}`,
              }}
            >
              v{CURRENT_VERSION}
            </span>
          </div>
        </div>

        {/* Right: Session/Global Picker + SearchModeButton + Lang + Theme */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: text.tertiary }}>
              {lang === "en" ? "Scope:" : "作用范围:"}
            </span>
            <select
              aria-label={lang === "en" ? "Session Scope" : "会话范围"}
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              style={{
                height: 30,
                padding: "0 8px",
                borderRadius: 8,
                border: `1px solid ${surface.border}`,
                background: surface.layer2,
                color: text.primary,
                fontFamily: "inherit",
                fontSize: 12,
                outline: "none",
                cursor: "pointer",
              }}
            >
              {sessionOptions.map((id) => (
                <option key={id} value={id}>
                  {id === "global"
                    ? lang === "en"
                      ? "Global Default"
                      : "全局默认 (global)"
                    : `${lang === "en" ? "Session" : "会话"}: ${id.slice(0, 14)}`}
                </option>
              ))}
            </select>
          </div>

          <SearchModeButton
            sessionId={sessionId}
            unavailableLabel={t("searchModeUnavailable")}
            menuLabel={t("searchModeMenuLabel")}
            labels={{
              auto: t("searchModeAuto"),
              required: t("searchModeRequired"),
              off: t("searchModeOff"),
            }}
            descriptions={{
              auto: t("searchModeAutoDesc"),
              required: t("searchModeRequiredDesc"),
              off: t("searchModeOffDesc"),
            }}
          />

          <button
            type="button"
            onClick={toggleLang}
            title={lang === "zh" ? "Switch to English" : "切换为中文"}
            style={{
              height: 30,
              padding: "0 10px",
              borderRadius: 8,
              border: `1px solid ${surface.border}`,
              background: surface.layer2,
              color: text.secondary,
              fontFamily: "inherit",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {lang === "zh" ? "EN" : "中文"}
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            title={theme === "light" ? "Dark Mode" : "Light Mode"}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: `1px solid ${surface.border}`,
              background: surface.layer2,
              color: text.secondary,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {theme === "light" ? <MoonIcon /> : <SunIcon />}
          </button>
        </div>
      </header>

      {/* Main Settings Dashboard Body */}
      <main
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 880,
          margin: "0 auto",
          padding: "28px 24px 64px",
        }}
      >
        <WebToolsSection t={t} ui={ui} />
      </main>
    </div>
  );
}

if (typeof document !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) {
    createRoot(rootEl).render(React.createElement(StandaloneApp));
  }
}
