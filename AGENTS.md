# Runtime

Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.

1. 这是一个仅对我个人开发使用的工具，而我是一个非专业程序员，只会让AI帮我操作，程序要尽可能轻量、精简。

# Single-Mode Runtime Rules

- production-only daily runtime expectation: keep this repo in pm2-managed production mode for daily operation.
- `pili-web-prod` is the default steady-state web/API process (Bun + Hono + Vite SPA).
- use `runtime:status` to inspect runtime state.
- use `runtime:refresh` after code changes to rebuild and replace only the production web process.
- build must succeed before replacing the running web process.
- production refresh and normal operation share the same `.env.local`, `.data`, and SQLite DB.

# HTTP handlers

- API handlers live under `app/api/**/route.ts` and are mounted by `server/legacy-routes.ts` into Hono.
- Request/response types come from `lib/server/httpCompat.ts` (web-standard `Request`/`Response` stand-ins), not `next/server`.
- Do not reintroduce the `next` package.
