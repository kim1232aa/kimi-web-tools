import os from "node:os";
import path from "node:path";
import type { BrowserPlatform } from "./types.ts";

export function resolveKimiCodeHome(baseDirOverride?: string): string {
  if (baseDirOverride) {
    return path.join(baseDirOverride, ".kimi-code");
  }
  const explicit = process.env.KIMI_CODE_HOME?.trim();
  return explicit && explicit.length > 0 ? explicit : path.join(os.homedir(), ".kimi-code");
}

export function getWebToolsBaseDir(baseDirOverride?: string): string {
  return path.join(resolveKimiCodeHome(baseDirOverride), "web-tools");
}

export function getDedicatedProfileDir(
  platform: BrowserPlatform,
  baseDirOverride?: string,
): string {
  return path.join(getWebToolsBaseDir(baseDirOverride), "browser-profiles", platform);
}

export function getRuntimeStateDir(
  platform: BrowserPlatform,
  baseDirOverride?: string,
): string {
  return path.join(getWebToolsBaseDir(baseDirOverride), "browser-runtime", platform);
}

export function validatePlatformUrl(urlStr: string, platform: BrowserPlatform): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (platform === "xiaohongshu") {
    return (
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com")
    );
  }

  if (platform === "x") {
    return (
      hostname === "x.com" ||
      hostname.endsWith(".x.com") ||
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com")
    );
  }

  return false;
}
