# TG 消息 → pili Feed 端到端延迟分析与修复兵案

日期：2026-08-29
状态：诊断完成，前端轮询降频已落地；治本(长连接/DB锁)方案待确认后执行

## TL;DR

TG 频道消息 → pili Feed 出现的延迟是**分层的**，大头在抓取段。实测分布：

| 延迟档 | 占比 | 对应行为 |
|--------|------|---------|
| 1.2~6s | 多数 | SOL/BNB 操作（理想态） |
| 16~70s | 一部分 | 频道喊单消息 |
| 260s / 1406s（4~23分钟） | 偶发尖刺 | 消息在轮询排队中被拖 |

**两层根因，互相放大：**

1. **MTProto 即时长连接没在跑**（核心）——代码已实现 updates 长连接（注释"把延迟 0-16s 收敛到 1-3s"），但日志零条 `[telegram-live]`，实际回退到 10s 轮询 + 逐频道扫。
2. **SQLite 写锁竞争 `database is locked`** —— 把长连接直接杀死。同一个 `.data/web3-feed.sqlite` 被 bun(web-prod) + 多个 node/pm2 写进程抢 WAL 写锁，MTProto `_updateLoop` 无超时保护、一被 DB 阻塞就 TIMEOUT，长连接当场断 → 回退轮询 → 延迟飙升。

**一句话：SQLite 锁是根因，它既拖慢轮询 cycle，又直接杀死本应 1-3s 的即时长连接。**

---

## 一、数据流链路

```text
TG 频道发消息
  → MTProto 长连接(updates NewMessage)  [即时路径，应 1-3s]  ← 实际没在跑
  └─ 每 10s 轮询(telegram:channel:worker)  [兜底，0~几百秒]   ← 实际主路径
  → telegramChannelLive.ts / telegramChannelSync.ts
  → ingestTelegramChannelPost()  → upsertEventsFromFeedRows()
  → eventsRepo.upsertEventsFromFeedRows() → bumpFeedRevision()  ← 入库即改 revision
  → 前端 useFeedSnapshotPolling 每 5s 轮询 revision  →  命中变化才拉数据
  → Feed 露出
```

**呈现段**已有 revision 快路径（`/api/feed?mode=poll&revision=...`，revision 没变返回 `{unchanged:true}`），所以前端轮询无数据变化时几乎零成本。

## 二、实测证据

`indexed_at - timestamp` 差值（`timestamp`=消息本身时间，`indexed_at`=入库时间）：

```sql
SELECT substr(content,1,30) content,
       round((indexed_at-timestamp)/1000.0,1) delay_sec,
       datetime(timestamp/1000,'unixepoch','localtime') msg_time,
       datetime(indexed_at/1000,'unixepoch','localtime') ingest_time
FROM events
WHERE ingest_source LIKE 'telegram-%' AND indexed_at>0
ORDER BY indexed_at DESC LIMIT 30;
```

结果：

- 多数行：`delay_sec` 1~6
- 频道行：`**$STONKBROKER thesis**` = 42.4s；`减仓0.8301SOL` = 51.9s
- 尖刺：`减仓0.7255SOL` = 262.7s；`加仓4.9505SOL` = 265.6s

## 三、根因定位

### 根因 1：即时长连接没在跑

- `lib/server/telegramChannelLive.ts` 的 `ensureLiveTelegramChannelClient()` 已实现 updates 长连接 + NewMessage handler。
- 但 pm2 日志 error/out 中**零条 `[telegram-live]`**。
- 单跑探针（`ensureLiveTelegramChannelClient`，5s 观察）**能连上且保持连接**——说明连接本身可行。
- 结论：worker 里长连接要么没建立成功，要么建起后被 DB 锁/崩溃杀掉，回退到轮询。

### 根因 2：SQLite 写锁杀死长连接（放大根因 1）

pm2 `pili-telegram-channel-worker-error.log` 满屏：

```
Error: TIMEOUT
    at node_modules/telegram/client/updates.js:250:85
    at async _updateLoop (updates.js:191:17)
Error: Not connected
    at ConnectionTCPFull.recv (Connection.js:71:15)
    at async MTProtoSender._recvLoop (MTProtoSender.js:373:24)
[telegram-channel-worker] cycle failed: database is locked
[twitterRepo] acquireIngestionLease busy ...database is locked
```

机制：
- 同一库有 **bun(web-prod pid 9149) + node(9292/9293/9308/13785 等 pm2 worker)**，多写进程抢 WAL 写锁（WAL 同一时刻只允许一个写者）。
- 主连接 `busy_timeout=8s`，撞锁同步自旋重试（`sqlite.ts`）。worker 每轮写 events/status 时撞锁就费 8s。
- 偏偏 gramjs 的 `_updateLoop`（updates 长连接）**无超时保护**，被 DB 阻塞就抛 TIMEOUT → 长连接断开 → 回退轮询。
- 于是"10s 轮询 + 逐频道扫 + 频道间 1500ms 延迟"，单条消息最坏 = 排队等上一轮 + 下一轮排到它 → 几百秒尖刺。

### 已确认的现状

- `PRAGMA journal_mode = wal`；`busy_timeout`（CLI 看是 0，但代码主连接设 8s；CLI 0 是独立连接）。
- `getFastFailWriteDb()`（busy_timeout=0，只用于可丢弃的租约心跳 `heartbeatIngestionLease` / `touchWorkerHeartbeat`）。
- `withSqliteBusyRetry` 指数退避：web 进程 2 次/上限 800ms；后台 worker 8 次/上限 8s。
- **设计约束**（`sqlite.ts` 注释明确）：改连接策略有冻结事件循环风险，需谨慎。

## 四、已落地改动

**前端轮询 5s → 3s**（`hooks/useFeedSnapshotPolling.ts` 的 `BASE_INTERVAL_MS`）。
走 revision 快路径 → 无数据变化几乎零成本。`tsc --noEmit` 通过。

## 五、修复兵案（按优先级）

### 方案 A（治本，首选）：让长连接不被 DB 锁杀死

思路：长连接所在进程的写操作不应阻塞 MTProto 的 update loop；撞锁时短等待而非无限/8s 阻塞。

可选子方案（按侵入度排序，需工程评审后选一）：

- **A1. 长连接写走 fast-fail 连接**：把 MTProto `_updateLoop` 里的 events 写接在 `getFastFailWriteDb()`（busy_timeout=0）。撞锁立即失败并 catch（丢本轮，下一轮兜底 sync 会补），不阻塞长连接。风险低，但需确认读写一致性（WAL 下多写连接合法）。
- **A2. 单独开库给 channel 长连接**：`telegramChannelLive` 用独立 `bun:sqlite` 连接 + 短 busy_timeout（如 500ms），与 web-prod 的锁竞争隔离。风险：进程级还是共享同一文件锁，未必根治；但能减少跨进程自旋。
- **A3. 降低长连接所在进程写事务粒度/频率**：worker 每轮只写必要的 revision bump，把大事务拆小、错峰。需审计 `upsertEventsFromFeedRows` 的事务范围。

**预期**：抓取段从"几十秒~几分钟"收敛到 **1~5s**，即和多数 SOL/BNB 操作一致。端到端约 **3~6s**。

### 方案 B（锦上添花）：轮询间隔再降

已从 5s→3s 落地。若抓取段治好后仍嫌慢，可配合 SSE/WebSocket 推送（前端不轮询，近实时）。工程量大，不建议轻量方案做。

### 方案 C（治标，可选）：压缩抓取侧排队

- 降 `TELEGRAM_MTPROTO_REQUEST_DELAY_MS`（当前 1500）→ 频道间更紧凑。
- 提高 `TELEGRAM_CHANNEL_SYNC_INTERVAL_MS` 以上？不，这是轮询上限，降它反而频繁。真正要让它**只在长连接断时才用**。

## 六、风险与验证

**风险**：A1/A2 改 `sqlite.ts` 连接策略，注释明确警告冻结事件循环风险；web-prod 是 bun:sqlite + node 双实现写同一库，需**先在非生产环境验证**再上线。

**验证步骤**：
1. 改动后观察 `pili-telegram-channel-worker-out.log` 是否出现 `[telegram-live] ingested` 行。
2. 跑上面的 delay SQL，对比 `delay_sec` 分布是否从"几十秒~几分钟"收敛到"1~6s"。
3. 观察 error.log 是否还有 `database is locked` / `TIMEOUT` / `Not connected`。

## 七、相关文件

- `lib/server/telegramChannelLive.ts` —— 即时路径（长连接）实现
- `lib/server/telegramGramjsClient.ts` —— gramjs client + `attachTelegramLiveUpdateLoop`
- `lib/server/telegramChannelWorkerRuntime.ts` —— worker 每轮取 live/sync
- `lib/server/telegramChannelSync.ts` —— 轮询兜底（并发 3 + 频道间 1500ms）
- `lib/server/sqlite.ts` —— DB 连接策略（busy_timeout / withSqliteBusyRetry / getFastFailWriteDb）
- `hooks/useFeedSnapshotPolling.ts` —— 前端轮询（已降 3s）
- `scripts/telegram-channel-worker.ts` —— worker 入口（pm2 pili-telegram-channel-worker）
- `.env.local`：`TELEGRAM_CHANNEL_SYNC_INTERVAL_MS=10000`（轮询上限）
