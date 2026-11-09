---
description: View or switch the Kimi Web Tools search mode (auto / required / off)
---

You are handling the `/kimi-web-tools:mode` command.

## Instructions

1. Inspect `$ARGUMENTS`:
   - If `$ARGUMENTS` is `auto` (or `智能联网`), call `web_mode` with `{ "action": "set", "mode": "auto" }`.
   - If `$ARGUMENTS` is `required` (or `always`, `始终联网`), call `web_mode` with `{ "action": "set", "mode": "required" }`.
   - If `$ARGUMENTS` is `off` (or `disable`, `关闭联网`), call `web_mode` with `{ "action": "set", "mode": "off" }`.
   - If `$ARGUMENTS` is `toggle`, call `web_mode` with `{ "action": "toggle" }`.
   - If `$ARGUMENTS` is empty, call `web_mode` with `{ "action": "get" }` and explain the three modes (`auto` / 智能联网, `required` / 始终联网, `off` / 关闭联网).
2. Report the active Search Mode concisely to the user.

User request: $ARGUMENTS
