<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes - APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:runtime-rules -->

# Runtime

Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.

<!-- END:runtime-rules -->

1. 这是一个仅对我个人开发使用的工具，而我是一个非专业程序员，只会让AI帮我操作，程序要尽可能轻量、精简。

<!-- BEGIN:runtime-mode-rules -->

# Single-Mode Runtime Rules

- production-only daily runtime expectation: keep this repo in pm2-managed production mode for daily operation.
- `pili-web-prod` is the default steady-state web/API process.
- use `runtime:status` to inspect runtime state.
- use `runtime:refresh` after code changes to rebuild and replace only the production web process.
- do not restart workers by default unless user asks.
- build must succeed before replacing the running web process.
- production refresh and normal operation share the same `.env.local`, `.data`, and SQLite DB.

<!-- END:runtime-mode-rules -->
