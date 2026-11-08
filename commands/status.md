---
description: Inspect Kimi Web Tools gateway health, active search mode, provider routing chain, and platform sessions
---

You are handling the `/kimi-web-tools:status` command.

## Instructions

1. Call `web_status` with `{ "include_quotas": true }`.
2. Present a clear, well-structured summary to the user including:
   - Gateway URL and running PID
   - Current Search Mode (`auto`, `required`, or `off`)
   - Active Search Routing Policy (`ordered`, `round-robin`, or `random`) and Provider Fallback Chain
   - Configured built-in and custom providers (with key pool status and quota snapshots)
   - Social platform sessions (`xiaohongshu` and `x`) authentication and runtime status.

User request: $ARGUMENTS
