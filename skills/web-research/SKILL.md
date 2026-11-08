---
name: web-research
description: Multi-provider web search, full-page extraction, and social platform research (Xiaohongshu & X) via kimi-web-tools.
---

# Web Research Skill (`kimi-web-tools`)

Use this skill whenever you need to search the web, extract full webpage content, or research discussions on Xiaohongshu (小红书) or Twitter/X.

## 1. Choosing Between `web_search` and `web_fetch`

- **Discovery (`web_search`)**: Use `web_search` when you need to find relevant URLs, recent news, documentation pages, or social posts.
- **Verification & Deep Reading (`web_fetch`)**: Use `web_fetch` when the user gives you a concrete URL or when you need the full text, code examples, or comments from a URL discovered via `web_search`.
- **Evidence Discipline**: Never present a `web_search` snippet as full-page verification or as user comments. Only claim what `web_fetch` actually returned.

## 2. Social Platform Routing (`小红书:` and `X:`)

When Xiaohongshu or X platform sources are enabled in Kimi Web Tools:
- Prefix your `web_search` query with `小红书:` or `X:` to route directly to the dedicated browser session:
  - Example: `web_search({ query: "小红书: 2026 独立开发变现" })`
  - Example: `web_search({ query: "X: Claude MCP updates" })`
- The gateway automatically strips the routing prefix before entering the platform search box, so do not repeat the platform name inside the topic keywords.
- To read the full note/tweet and its comments, pass the returned item URL to `web_fetch({ url })`.
