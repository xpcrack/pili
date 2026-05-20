<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:runtime-rules -->

# Runtime

Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.

<!-- END:runtime-rules -->

1. 这是一个仅对我个人开发使用的工具，而我是一个非专业程序员，只会让AI帮我操作，程序要尽可能轻量、精简。

<!-- BEGIN:runtime-mode-rules -->

# Runtime Mode Switching Rules

- This repo normally runs under `pm2` runtime management.
- Daily usage defaults to production web mode, not `next dev`.
- `pili-web-prod` runs the web and API process in production mode.
- Background workers stay running unless the user explicitly asks to stop them; do not restart workers by default.
- When the user asks to switch to development mode: stop `pili-web-prod`, start `pili-web-dev`, and do not stop or restart background workers unless explicitly asked.
- When the user asks to switch back to production mode: stop `pili-web-dev`, run a production build, and only if the build succeeds start `pili-web-prod`.
- Production and development reuse the same `.env.local`, `.data`, and SQLite DB. Do not create a separate dev DB unless the user explicitly asks.

<!-- END:runtime-mode-rules -->
