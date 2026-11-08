---
name: web-research
description: 9Router web search, optional page extraction, and evidence discipline via kimi-web-tools.
---

# Web Research Skill (`kimi-web-tools`)

Use this skill whenever you need to search the web or extract full webpage content through the configured 9Router gateway.

## 1. Choosing Between `web_search` and `web_fetch`

- **Discovery (`web_search`)**: Use `web_search` when you need to find relevant URLs, recent news, documentation pages, or social posts.
- **Verification & Deep Reading (`web_fetch`)**: Use `web_fetch` when the user gives you a concrete URL or when you need the full text, code examples, or comments from a URL discovered via `web_search`.
- **Evidence Discipline**: Never present a `web_search` snippet as full-page verification or as user comments. Only claim what `web_fetch` actually returned.

## 2. Direct upstream behavior

Search and fetch use the configured 9Router endpoint directly. There is no local provider pool or fallback chain, so an upstream error must be reported rather than replaced with another provider or a fabricated result.
