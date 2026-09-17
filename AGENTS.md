# Runtime

<!-- BEGIN:runtime-rules -->
Use Node `24.11.1` for this repo.

Do not switch to Node `25+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass.
<!-- END:runtime-rules -->

1. 这是一个仅对我个人开发使用的工具，而我是一个非专业程序员，只会让AI帮我操作，程序要尽可能轻量、精简。

# Single-Mode Runtime Rules

- production-only daily runtime expectation: keep this repo in pm2-managed production mode for daily operation.
- `pili-web-prod` is the default steady-state web/API process (Bun + Hono + Vite SPA).
- use `runtime:status` to inspect runtime state.
- use `runtime:refresh` after code changes to rebuild and replace only the production web process.
- do not restart workers by default unless user asks: `runtime:refresh` leaves background workers running, so they keep the latest code only after an explicit restart.
- build must succeed before replacing the running web process.
- production refresh and normal operation share the same `.env.local`, `.data`, and SQLite DB.

# HTTP handlers

- API handlers live under `app/api/**/route.ts` and are mounted by `server/legacy-routes.ts` into Hono.
- Request/response types come from `lib/server/httpCompat.ts` (web-standard `Request`/`Response` stand-ins), not `next/server`.
- Do not reintroduce the `next` package.

# Telegram 采集可靠性

- 频道入库链路：pm2 `pili-telegram-channel-worker`（`scripts/telegram-channel-worker.ts`）→
  `telegram_channel_posts`。**每轮 cycle 必须有硬超时**（`TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS`，
  默认 180s）：超时即 `process.exit(1)` 让 pm2 重建 MTProto 连接。不要移除这个超时 ——
  2026-09-03 正是因为一轮 cycle 无超时永久挂起，进程假活、13 个频道静默停摆 13 天。
- 「频道不进了」诊断：`worker_status` / `ingestion_leases` + `BEGIN IMMEDIATE` 探写锁 +
  `lsof` / `sample` 抓持有长事务的进程。完整配方与本次复盘：
  `docs/tg-channel-stall-2026-09-17.md`。
- 同一个 `web3-feed.sqlite` 上有多个写进程（bun web-prod + node workers）抢 WAL 写锁，
  这是本仓库的慢性病：频道停摆、moonshot 徽章冻结（信源 `pili:birdshot_listings`）都是它的下游表现。

# SQLite 写锁纪律（2026-09-03 事故后立的规矩）

- **单事务持锁时长必须有上界**：批量写一律走 `forEachWriteChunk()`（`lib/server/sqlite.ts`，
  每块 `PILI_SQLITE_WRITE_CHUNK_ROWS` 行，默认 500），不要把一个事务套在「全量 feed /
  全表 DELETE + 全量插入」上。反面教材：`replaceFeedSnapshot` 原本一个事务干完
  「DELETE 83k 行 + 逐行插入 300MB JSON」，能把写锁独占几十分钟。
- **慢事务有取证**：任何 `withTransaction` 持锁 ≥ `PILI_SLOW_TXN_WARN_MS`（默认 2000ms）
  都会打 `[sqlite] slow transaction held the write lock for …ms at:` + 调用栈（换调用点立刻报，
  同一调用点 60s 一次）。排查「谁把库写锁住了」先 grep 这条日志。
- 探写锁必须用**带引号**的 `select 'ok'`（`BEGIN IMMEDIATE; ROLLBACK; select 'ok';`）：
  写成 `select ok` 会因为 "no such column" 报错，把「锁空闲」误判成「锁被占」。
