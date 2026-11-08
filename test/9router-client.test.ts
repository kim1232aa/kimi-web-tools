import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NineRouterClient } from "../src/host/9router-client.ts";

interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

async function withStub(
  responder: (request: RecordedRequest) => { status?: number; body: unknown },
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += Buffer.from(chunk).toString("utf8");
    const request = {
      path: req.url ?? "",
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : {},
    };
    requests.push(request);
    const response = responder(request);
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as http.AddressInfo).port;

  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("NineRouterClient forwards search and fetch through the direct contract", async () => {
  await withStub(
    (request) => {
      if (request.path === "/v1/search") {
        return {
          body: {
            provider: "agy-search",
            results: [
              {
                title: "Example result",
                url: "https://example.com/result",
                snippet: "A useful excerpt",
                published_at: "2026-11-08",
              },
            ],
            metrics: { response_time_ms: 12 },
          },
        };
      }
      return {
        body: {
          provider: "jina-reader",
          title: "Example page",
          content: { text: "Readable page content" },
        },
      };
    },
    async (baseUrl, requests) => {
      const client = new NineRouterClient({ baseUrl, apiKey: "test-key" });
      const search = await client.search("minimal gateway", 3);
      assert.deepEqual(search, {
        query: "minimal gateway",
        backend: "agy-search",
        sources: [
          {
            title: "Example result",
            url: "https://example.com/result",
            snippet: "A useful excerpt",
            publishedAt: "2026-11-08",
          },
        ],
        truncated: false,
      });

      const fetched = await client.fetch("https://example.com/result");
      assert.deepEqual(fetched, {
        url: "https://example.com/result",
        statusCode: 200,
        body: { kind: "text", content: "Readable page content" },
        truncated: false,
        backend: "jina-reader",
      });

      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.path, "/v1/search");
      assert.equal(requests[0]?.authorization, "Bearer test-key");
      assert.deepEqual(requests[0]?.body, {
        model: "agy-search",
        query: "minimal gateway",
        max_results: 3,
        search_type: "web",
      });
      assert.equal(requests[1]?.path, "/v1/web/fetch");
      assert.equal(requests[1]?.authorization, "Bearer test-key");
      assert.deepEqual(requests[1]?.body, {
        model: "jina-reader",
        url: "https://example.com/result",
        format: "markdown",
      });
    },
  );
});

test("NineRouterClient rejects missing credentials without making an upstream request", async () => {
  const client = new NineRouterClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => client.search("query"), /NINEROUTER_KEY/);
});

test("NineRouterClient surfaces upstream errors without fallback", async () => {
  await withStub(
    () => ({ status: 502, body: { error: { message: "upstream unavailable" } } }),
    async (baseUrl, requests) => {
      const client = new NineRouterClient({ baseUrl, apiKey: "test-key" });
      await assert.rejects(() => client.search("query"), /HTTP 502.*upstream unavailable/);
      assert.equal(requests.length, 1, "exactly one upstream request is made");
    },
  );
});

test("NineRouterClient rejects malformed successful responses", async () => {
  await withStub(
    () => ({ body: {} }),
    async (baseUrl) => {
      const client = new NineRouterClient({ baseUrl, apiKey: "test-key" });
      await assert.rejects(() => client.search("query"), /invalid 9Router search response/);
    },
  );
});
