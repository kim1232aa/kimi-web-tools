---
description: Ensure the Kimi Web Tools standalone gateway is running and show the Web UI Dashboard URL
---

You are handling the `/kimi-web-tools:dashboard` command.

## Instructions

1. Call `web_status` with `{}` (which automatically starts the standalone gateway daemon if it is not yet running).
2. Show the user the Web UI Dashboard URL (`http://127.0.0.1:18492`) and summarize what they can configure in the dashboard:
   - Topbar `SearchModeButton` (智能联网 / 始终联网 / 关闭联网) with Global/Session selector and Light/Dark theme toggle
   - Provider API keys (multi-key pools, health status, quotas)
   - Drag-and-drop search order and routing policy (`ordered`, `round-robin`, `random`)
   - Custom search sources (Tavily-compatible, SearXNG JSON, or Generic JSON APIs)
   - Xiaohongshu (小红书) and Twitter/X dedicated browser session login.

User request: $ARGUMENTS
