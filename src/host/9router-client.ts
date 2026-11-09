export const DEFAULT_NINEROUTER_URL = "http://127.0.0.1:20128";
export const DEFAULT_SEARCH_MODEL = "brave";
export const DEFAULT_FETCH_MODEL = "jina-reader";
export const DEFAULT_NINEROUTER_TIMEOUT_MS = 30_000;

export interface NineRouterClientOptions {
  baseUrl?: string;
  apiKey?: string;
  searchModel?: string;
  fetchModel?: string;
  timeoutMs?: number;
}

export interface NineRouterSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export interface NineRouterSearchResult {
  query: string;
  backend: string;
  sources: NineRouterSource[];
  truncated: boolean;
}

export interface NineRouterFetchResult {
  url: string;
  statusCode: number;
  body: { kind: "text"; content: string };
  truncated: boolean;
  backend: string;
}

export interface NineRouterWebModels {
  searchModels: string[];
  fetchModels: string[];
}

export class NineRouterError extends Error {
  readonly status?: number;
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status?: number) {
    super(message);
    this.name = "NineRouterError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_NINEROUTER_TIMEOUT_MS;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  return undefined;
}

function responseError(payload: Record<string, unknown>, fallback: string): string {
  const direct = errorMessage(payload.error) ?? errorMessage(payload.detail) ?? errorMessage(payload.message);
  if (direct) return direct;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export class NineRouterClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  searchModel: string;
  fetchModel: string;
  readonly timeoutMs: number;

  constructor(options: NineRouterClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? envValue("NINEROUTER_URL") ?? DEFAULT_NINEROUTER_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? envValue("NINEROUTER_KEY") ?? "";
    this.searchModel = options.searchModel ?? envValue("NINEROUTER_SEARCH_MODEL") ?? DEFAULT_SEARCH_MODEL;
    this.fetchModel = options.fetchModel ?? envValue("NINEROUTER_FETCH_MODEL") ?? DEFAULT_FETCH_MODEL;
    this.timeoutMs = positiveTimeout(options.timeoutMs ?? Number(process.env.NINEROUTER_TIMEOUT_MS));
  }

  async listWebModels(signal?: AbortSignal): Promise<NineRouterWebModels> {
    const payload = await this.request("/v1/models/web", undefined, signal, "GET");
    const items = Array.isArray(payload.data) ? payload.data : [];
    const searchModels: string[] = [];
    const fetchModels: string[] = [];
    for (const item of items) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
      const rawId = item.id.trim();
      if (item.kind === "webSearch") {
        const clean = rawId.endsWith("/search") ? rawId.slice(0, -7) : rawId;
        if (!searchModels.includes(clean)) searchModels.push(clean);
      } else if (item.kind === "webFetch") {
        const clean = rawId.endsWith("/fetch") ? rawId.slice(0, -6) : rawId;
        if (!fetchModels.includes(clean)) fetchModels.push(clean);
      }
    }
    return { searchModels, fetchModels };
  }

  async search(query: string, maxResults = 8, signal?: AbortSignal, modelOverride?: string): Promise<NineRouterSearchResult> {
    const cleanQuery = query.trim();
    if (!cleanQuery) throw new NineRouterError("query is required", `${this.baseUrl}/v1/search`);
    const boundedMaxResults = Math.min(Math.max(Math.floor(maxResults), 1), 20);
    const activeModel = optionalString(modelOverride) ?? this.searchModel;
    const payload = await this.request("/v1/search", {
      model: activeModel,
      query: cleanQuery,
      max_results: boundedMaxResults,
      search_type: "web",
    }, signal);

    if (!Array.isArray(payload.results)) {
      throw new NineRouterError("invalid 9Router search response: results must be an array", `${this.baseUrl}/v1/search`);
    }

    const sources = payload.results.map((item, index) => {
      if (!isRecord(item) || typeof item.url !== "string" || !item.url.trim()) {
        throw new NineRouterError(`invalid 9Router search response: result ${index} has no url`, `${this.baseUrl}/v1/search`);
      }
      const source: NineRouterSource = { url: item.url };
      const title = optionalString(item.title);
      const snippet = optionalString(item.snippet) ?? optionalString(item.content);
      const publishedAt = optionalString(item.published_at) ?? optionalString(item.publishedAt);
      if (title) source.title = title;
      if (snippet) source.snippet = snippet;
      if (publishedAt) source.publishedAt = publishedAt;
      return source;
    });

    return {
      query: cleanQuery,
      backend: optionalString(payload.provider) ?? activeModel,
      sources,
      truncated: payload.truncated === true,
    };
  }

  async fetch(url: string, signal?: AbortSignal, modelOverride?: string): Promise<NineRouterFetchResult> {
    const cleanUrl = url.trim();
    if (!cleanUrl) throw new NineRouterError("url is required", `${this.baseUrl}/v1/web/fetch`);
    const activeModel = optionalString(modelOverride) ?? this.fetchModel;
    const payload = await this.request("/v1/web/fetch", {
      model: activeModel,
      url: cleanUrl,
      format: "markdown",
    }, signal);

    const content = isRecord(payload.content) ? payload.content : undefined;
    const text = optionalString(content?.text) ?? optionalString(content?.markdown) ?? optionalString(payload.text);
    if (!text) {
      throw new NineRouterError("invalid 9Router fetch response: content.text is required", `${this.baseUrl}/v1/web/fetch`);
    }

    return {
      url: cleanUrl,
      statusCode: typeof payload.status_code === "number" ? payload.status_code : 200,
      body: { kind: "text", content: text },
      truncated: payload.truncated === true,
      backend: optionalString(payload.provider) ?? activeModel,
    };
  }

  private async request(
    pathname: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    method: "GET" | "POST" = "POST",
  ): Promise<Record<string, unknown>> {
    const endpoint = `${this.baseUrl}${pathname}`;
    if (!this.apiKey.trim()) {
      throw new NineRouterError("NINEROUTER_KEY is not configured", endpoint);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) throw new NineRouterError("9Router request aborted", endpoint);
      abortListener = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
    }
    timer = setTimeout(() => controller.abort(new Error(`9Router request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    timer.unref?.();

    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            accept: "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new NineRouterError(
            signal?.aborted ? "9Router request aborted" : `9Router request timed out after ${this.timeoutMs}ms`,
            endpoint,
          );
        }
        throw new NineRouterError(
          `9Router request failed: ${error instanceof Error ? error.message : String(error)}`,
          endpoint,
        );
      }

      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        throw new NineRouterError(`9Router returned invalid JSON (HTTP ${response.status})`, endpoint, response.status);
      }
      if (!isRecord(parsed)) {
        throw new NineRouterError(`9Router returned an invalid JSON object (HTTP ${response.status})`, endpoint, response.status);
      }
      if (!response.ok) {
        throw new NineRouterError(
          `9Router request failed (HTTP ${response.status}): ${responseError(parsed, response.statusText || "upstream error")}`,
          endpoint,
          response.status,
        );
      }
      if (parsed.error !== undefined) {
        throw new NineRouterError(
          `9Router request failed: ${responseError(parsed, "upstream error")}`,
          endpoint,
          response.status,
        );
      }
      return parsed;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }
}
