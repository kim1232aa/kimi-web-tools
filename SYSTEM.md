# Kimi Web Tools (Plugin Instructions)

You have access to the `kimi-web-tools` MCP server (`web_search`, `web_fetch`, `web_mode`, `web_status`) backed by a local multi-provider search & extraction gateway (`http://127.0.0.1:18492`).

## Core Tools

- `web_search`: Execute web or social platform searches across the configured provider pool (Exa, Tavily, Brave, You.com, Firecrawl, Parallel, Jina, Keenable, SearXNG, and custom sources) with automatic health-aware key rotation and fallback.
  - To target **Xiaohongshu (小红书)** or **Twitter/X** directly when platform sources are enabled, prefix the query with `小红书:` or `X:` (for example, `小红书: 机械键盘测评` or `X: OpenAI release`). Do not repeat the platform name in the topic keywords.
- `web_fetch`: Fetch and extract clean readable Markdown/text from any public URL, or extract full post body and top comments from Xiaohongshu and X URLs.
  - Use `web_fetch` when you already have a specific URL; use `web_search` for discovery.
  - Treat `web_search` snippets as discovery evidence, not full page details or verified comments. Describe comments/replies as verified only when `web_fetch` returns their contents.
- `web_mode`: View or change the active Search Mode (`auto` = 智能联网, `required` = 始终联网, `off` = 关闭联网).
- `web_status`: Inspect gateway health, Web UI Dashboard URL (`http://127.0.0.1:18492`), provider routing order, API key pools, quotas, and social platform login status.

## Search Mode Policy

- **`auto` (智能联网)**: Call `web_search` or `web_fetch` when the user's question requires current, external, or verifiable facts; otherwise answer from context.
- **`required` (始终联网)**: Complete at least one of this plugin's `web_search` or `web_fetch` calls before finalizing each turn. Pass the `session_id` and `turn_id` supplied by the turn's UserPromptSubmit hook; never borrow a different session's identifiers. A failed request is not verified evidence: report the failure and what remains unverified.
- **`off` (关闭联网)**: Do not call this plugin's `web_search` or `web_fetch`. This setting does not control tools from other plugins or the host.
- The mode requires this plugin's lifecycle hooks to be loaded. After installing or updating the plugin, reload the plugin/session before relying on the policy. Kimi hooks are fail-open on execution errors; the gateway separately rejects this plugin's requests while its mode is off.
