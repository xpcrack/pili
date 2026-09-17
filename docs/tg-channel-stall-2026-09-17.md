# TG 频道采集静默停摆 13 天 — 复盘与修复（2026-09-17）

## TL;DR

2026-09-03 15:13 起，**pili 全部 13 个 TG 频道的入库完全停止**（`telegram_channel_posts`
最新一条卡在 09-03 15:13:30），而 pm2 里 `pili-telegram-channel-worker` 一直是 `online`：
进程活着、stdout 还在刷 GramJS 的 `Not connected` / `Connection closed` 重连日志，
但**一条业务日志都没有**（既没有 `cycle`，也没有 `lease busy`）。停了 13 天没人发现。

连带影响：newone 池页的 **moonshot 徽章冻结**（`certifications_json` 最新 `verified_at`
= 2026-09-01，信源 `pili:birdshot_listings` 就是这批频道）；社媒提及里的频道帖同样冻结。

## 根因链（证据逐条）

1. **一个长写事务占住 WAL 写锁**
   `pili-background-worker`（`bun scripts/background-worker.ts`）里有一个写事务长时间不提交。
   - 采样证据：`sample <pid>` 显示主线程**完全卡在 `sqlite3_step`**
     （`vdbeColumnFromOverflow` → `accessPayload` / `getOverflowPage` → `pread`），
     即同一条语句在读大字段（payload/raw JSON）的溢出页，持续 30 分钟以上。
   - 锁证据：另开连接 `PRAGMA busy_timeout=800; BEGIN IMMEDIATE;` 连续 **20/20 次**
     `database is locked`；`web3-feed.sqlite-wal` 的 mtime/大小连续 35s 冻结（无任何成功写入）。
   - 释放证据：只 `pm2 restart pili-background-worker` 后，同一探测 **5/5 次成功**。
2. **租约心跳被锁死** → 频道 worker 的 `heartbeatIngestionLease` 走 fast-fail 连接
   （`busy_timeout=0`），连续失败后 `WorkerLease` 判定丢租约：
   `worker_status` 留下 `telegram-channel-sync | lease-lost | worker lease heartbeat failed`
   （时间戳 1788448665624 = 09-03 15:17），`ingestion_leases` 那行过期于 09-03 15:18。
3. **一轮 cycle 永久挂起**（这是停摆 13 天的直接原因）
   心跳是在 cycle 内被锁死时判丢的，但 **cycle 本身没有超时**：
   `lib/server/telegramChannelSync.ts` / `telegramChannelLive.ts` 里没有任何
   timeout / Promise.race；MTProto 长连接被 DB 或断连拖死后，请求永不 settle。
   于是 worker 卡在 `while (lease.shouldRun())` 内部，**再也回不到循环顶部**：
   - 不可能走到 `lease.isLost()` 分支去重新抢租约；
   - `cycle-limit` / `idle-limit` 这两个自杀重启保护也永远不会被求值；
   - pm2 默认只对「进程退出」重启，对「进程假活」无能为力 → 一直挂到今天。
   反证：重启后立刻出现大量 `worker lease busy, waiting...`（抢租约失败**是有日志的**），
   而挂死期间一条都没有 → 说明当时并不在抢租约循环里，而是卡在 cycle 内部。

## 已落地改动

1. `lib/timing.ts`：新增 `withTimeout()` + `TimeoutError`（哨兵竞速，不取消底层操作，
   也不留悬挂定时器与未处理 rejection）。
2. `lib/server/telegramMtprotoPolicy.ts`：新增 `channelCycleTimeoutMs`
   （`TELEGRAM_CHANNEL_CYCLE_TIMEOUT_MS`，默认 **180s**；实测量级：13 频道一轮含 13 天积压
   也能在 1 分钟内跑完，3× 余量）。
3. `scripts/telegram-channel-worker.ts`：每轮 `runTelegramChannelWorkerCycle()` 包在
   `withTimeout` 里；超时 → `status='cycle-timeout'` + 日志 + 释放租约 + `process.exit(1)`
   → pm2 `autorestart: true` 重建 MTProto 连接。**再也不会出现 13 天假活。**
4. `scripts/test-telegram-channel-cycle-timeout.ts`：回归测试（永不 settle → 按时抛
   `TimeoutError`；正常操作原样返回；原错误不被包装；policy 默认值与环境变量覆盖）。

## 恢复验证（2026-09-17）

- 重启 `pili-background-worker` 后写锁立即释放（探测 5/5 成功）。
- 重启 `pili-telegram-channel-worker` 后：抢到租约，一轮补齐 13 天积压 ——
  `@BWE_Binance_monitor` 1770 → 1849、`@BWE_reserved1` 975 → 1015、
  `@BWE_tier2_monitor` 5962 → 6201；日志出现
  `cycle complete sources=13 synced=13 errors=0 stored=…`，`worker_status` = `idle`，
  `telegram_channel_posts` 恢复实时增长。

## 现场诊断配方（下次直接照做）

```bash
DB=~/.vibecoding/pilipili/.data/web3-feed.sqlite

# 1) 数据是否在进
sqlite3 -readonly "$DB" "select datetime(max(posted_at_ms)/1000,'unixepoch'), count(*) from telegram_channel_posts;"
sqlite3 -readonly "$DB" "select worker_key,status,datetime(last_heartbeat_at_ms/1000,'unixepoch'),last_error from worker_status;"

# 2) 写锁是否被长事务占住（ok=空闲；注意 select 'ok' 必须带引号，
#    写成 select ok 会因 "no such column" 报错，把「空闲」误判成「被占」）
for i in $(seq 1 5); do sqlite3 "$DB" "PRAGMA busy_timeout=800; BEGIN IMMEDIATE; ROLLBACK; select 'ok';" 2>&1 | tail -1; done

# 3) WAL 是否还在动（mtime 冻结 = 没人写成功）
stat -f "%m %z" "$DB-wal"; date +%s

# 4) 抓占用写锁的进程：谁持有文件 + 谁卡在 sqlite3_step
lsof -t "$DB" | sort -u | xargs -I{} ps -o pid=,lstart=,command= -p {}
sample <pid> 2 -file /tmp/s.txt; grep -m5 "sqlite3" /tmp/s.txt
```

判定口径：`sample` 里出现 `sqlite3VdbeExec` + 溢出页读取、且第 2 步连续失败、第 3 步
WAL 冻结 → **某个 writer 的长事务**；重启该 worker 即可释放（SQLite 会回滚未提交事务）。

## 未完成 / 待跟进

- **长写事务的具体语句尚未定位**（只证到「在 `pili-background-worker` 内、一条读溢出页的
  语句/循环、运行 30 分钟以上」）。冻结前最后一行日志是
  `[completeness-worker] wallet-timeline-sweep …`，其后是 `wallet-activity-backfill` 的
  drain（写入带大 `raw_json` 的活动行）—— 嫌疑最高，但**未证**。
  建议下一步：给写事务加「持锁时长」埋点（开始/提交时打一对日志），下次直接指名道姓；
  或把该 drain 的每批写入拆成小事务（本轮未改，避免动到 GMGN 配额相关的链路）。
- 本轮未改 `pili-background-worker` 的任何行为，只重启释放锁。

## 第二轮：写事务治理（2026-09-17 当天落地）

### 埋点：慢事务取证

`lib/server/sqlite.ts` 的两个事务入口（`withTransaction` / `withTransactionTyped`，覆盖全仓
53 个调用点）现在都测持锁时长：≥ `PILI_SLOW_TXN_WARN_MS`（默认 **2000ms**）就打

```
[sqlite] slow transaction held the write lock for 12345ms (threshold 2000ms) at:
  <调用栈 4 帧>
```

同一调用点 60s 内只报一次，换调用点立刻报；只在慢路径抓栈，常态零开销。
**下次「谁把库锁住了」直接 grep 这条日志即可点名，不用再靠 `sample` 猜。**

### 拆批：单事务持锁时长必须有上界

`lib/server/sqlite.ts` 新增 `SQLITE_WRITE_CHUNK_ROWS`（`PILI_SQLITE_WRITE_CHUNK_ROWS`，
默认 500）与 `forEachWriteChunk()`，并改掉三处「一个事务干完整批」的写法：

| 位置 | 原写法 | 现写法 |
|---|---|---|
| `eventsRepo.upsertEventsFromFeedRows` | 全量 rows 一个事务（sync 走整份 feed，~1690 行 → 每行还有多次 lookup/UPDATE/INSERT） | >500 行时按块递归调用，每块一个事务 |
| `feedSnapshotRepo.upsertFeedSnapshot` | 全量插入一个事务 | 按块插入 |
| `feedSnapshotRepo.replaceFeedSnapshot` | 一个事务里 `DELETE FROM activity_feed`（83k 行 / 300MB）+ 全量逐行插入 | 清空按 rowid 分块，插入按块（不再原子替换；生产只以空 feed 走这条路） |

分块保持了两条语义：跨块不丢行/不重行（幂等 upsert 不变），以及 `upsertEventsFromFeedRows`
对调用方数组的 in-place 打分回写（`[...chunk]` 共享元素引用）。回归测试
`scripts/test-sqlite-write-chunking.ts`（块大小压到 2）钉住这两点。

### 本轮实测

- 治理后写锁探活：正确引号的探针 **10/10 空闲**；`telegram_channel_posts` 持续增长；
  `telegram-channel-sync` 回到 `idle`、`cycle complete sources=13 synced=13 errors=0`。
- 观察窗口内没有出现 `[sqlite] slow transaction`（说明当前没有 >2s 的写事务），
  但**09-03 那条 30 分钟事务的具体语句仍未点名**——它只在特定负载下出现，
  现在有埋点等着它自报家门。
- 教训：本轮排查中我一度用 `select ok`（无引号）探锁，把「锁空闲」误读成「锁一直被占」，
  差点误判。探写锁务必带引号（已写进 AGENTS.md）。
