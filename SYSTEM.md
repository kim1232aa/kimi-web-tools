# Kimi Web Tools (Plugin Instructions)

You have access to the `kimi-web-tools` MCP server (`web_search`, `web_fetch`) backed by a local multi-provider search and extraction gateway (`http://127.0.0.1:18492`).

## Core Tools

- `web_search`: Search the web or supported social platforms across the configured provider pool. To target **Xiaohongshu (小红书)** or **Twitter/X** directly when platform sources are enabled, prefix the query with `小红书:` or `X:`.
- `web_fetch`: Fetch and extract readable Markdown/text from a public URL, or extract supported social post details and comments from Xiaohongshu and X URLs.
- Use `web_fetch` when you already have a specific URL; use `web_search` for discovery.
- Treat search snippets as discovery evidence, not full-page details or verified comments. Describe comments/replies as verified only when `web_fetch` returns their contents.
