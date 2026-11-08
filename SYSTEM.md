# Kimi Web Tools (Plugin Instructions)

You have access to the `kimi-web-tools` MCP server (`web_search`, optional `web_fetch`) backed by the configured 9Router agy-search gateway.

## Core Tools

- `web_search`: Search the web through the configured 9Router search provider.
- `web_fetch`: Optional URL extraction through the configured 9Router reader provider; use it when you already have a specific URL.
- Treat search snippets as discovery evidence, not full-page details. Only describe page details as verified when `web_fetch` returns their contents.
- The gateway has no provider fallback: upstream errors are reported directly.
