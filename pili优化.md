Context

Pili 的频繁 ERR_CONNECTION_REFUSED、ERR_INCOMPLETE_CHUNKED_ENCODING 和 25 秒 feed 超时，不是单一接口偶发变慢，而是几类问题叠加：

- runtime:refresh 当前先删除生产 Web，再构建、再启动，构建期间必然停服；近期一天内曾显式停止 Web 31 次。
- PM2 online 早于真实监听。Web 在监听 3013 前同步打开约 2.8GB SQLite、初始化 runtime context 并启动后台任务，实测存在 4–21 秒无监听窗口。
- 关停时先等待后台任务，再关闭 HTTP；多数重任务没有真正响应 AbortSignal，10 秒后被 PM2 SIGKILL，正在传输的响应被截断。
- Web 进程内嵌 holdings、completeness、live monitor、position-delta 等任务。position-delta 每 10 分钟同步扫描和解析约 6.1 万条事件，单轮约 6.6 秒，足以阻塞同一 Bun 事件循环上的全部 API。
- changed feed 的 200 条响应约 1.72MB；revision 失效后会重复执行同步 SQL、JSON 解析/序列化和大体积传输。GET 读取路径还可能执行 healing 写库，增加 SQLite 写锁竞争并再次改变 revision。
- 前端固定 5 秒轮询没有失败退避、隐藏页暂停和卸载 abort；正常 feed 页面还常驻一个已无实际业务价值的 debug SSE，历史上产生过大量关闭后继续写流的异常。

目标不是推倒重写，而是沿现有 Bun + Hono + PM2 + SQLite 架构渐进式重构：让 Web 成为纯 HTTP 进程，让后台任务独立运行，让 GET 严格只读，让 feed 变成稳定的小响应协议，并让发布失败时旧服务继续运行。保留当前工作区已有的索引、WAL、FTS guard、payload 精简和前端请求仲裁优化，不覆盖现有未提交改动。

成功标准

- 正常构建/刷新不再出现分钟级停机；构建失败不影响当前服务。
- Web 不再因后台任务阻塞 5–10 秒，不再因任务未退出而被 PM2 强杀。
- 正常页面不再建立 debug SSE。
- feed unchanged 请求 p95 < 50ms、响应 < 1KB；changed 首屏压缩后目标 < 200KB。
- feed GET 不写 SQLite；后台写事务短且可取消。
- 连续网络错误时轮询自动退避，隐藏页停止轮询，卸载后无遗留请求。

Implementation Plan

1. 建立基线并保护现有优化

在修改前记录真实生产基线，并为当前未提交优化补最小回归保护。

- 记录 3013 启动到监听耗时、PM2 stop/SIGKILL、feed unchanged/changed 延迟和字节数、SQLite busy、event-loop lag、position-delta 周期耗时。
- 保留并继续整合：
  - lib/server/eventsRepo.ts 的查询索引约束和 cursor/action 跳过昂贵 COUNT。
  - app/api/feed/route.ts 的 diagnostics、人物页 assets/meta 精简。
  - lib/server/sqlite.ts 的 FTS 初始化 guard 和 PASSIVE checkpoint 方向。
  - lib/server/feedPrewarmService.ts 的全局覆盖判断。
  - hooks/useActivityPolling.ts 的客户端缓存和 FeedRequestArbiter。
- 纠正已有潜在回归：cursor total 合同与测试不一致、silent poll 漏传 revision、pageSize 上限 400、revision 无法感知删除。

关键文件：

- scripts/test-events-feed-total.ts
- scripts/test-runtime-mode.ts
- scripts/test-feed-prewarm-service.ts
- scripts/test-feed-request-arbiter.ts
- scripts/test-activities-api.ts

2. 先止血：修复发布、ready 与关停流程

2.1 构建成功后再操作生产进程

修改 scripts/runtime-mode.ts：

1. 先执行 npm run build。
2. build 失败立即退出，保持当前 pili-web-prod 不动。
3. build 成功后再更新 PM2 进程；禁止 delete -> build -> start。
4. 更新后轮询 /api/runtime/ready，确认 PID、HTTP 和 DB 均可用；失败时明确报错并保留日志。
5. runtime:refresh 仍只刷新 Web，不重启 Telegram 或新后台 worker。

第一阶段不引入常驻网关、Redis 或双槽部署。对个人本机工具，先把分钟级主动停机降到单次进程交接；只有实测仍无法接受这段短间隙，再单独设计蓝绿切换。

2.2 增加真实 readiness

复用现有 runtime status 路由和 context，在 server/runtime.ts、server/server.ts、server/runtime-context.ts 中维护最小状态：booting / ready / draining。

- 增加 /api/runtime/live：进程和 listener 存活即 200。
- 增加 /api/runtime/ready：HTTP 已监听、静态产物存在、SQLite 可执行轻量查询、schema 兼容时才 200。
- PM2 配置 wait_ready: true、合理的 listen_timeout，ready 后调用 process.send?.('ready')。
- readiness 不等待 holdings、prewarm、Telegram 或任何外部 API。
- 启动日志记录 DB open、runtime init、listen、ready 各阶段耗时。

2.3 正确排空 HTTP

调整 server/server.ts 的 stop 顺序：

1. 状态切到 draining，readiness 立即失败。
2. 先停止接受新连接并关闭 HTTP server。
3. 等在途请求在有界期限内完成。
4. 再停止该进程拥有的任务。
5. 超时必须记录具体未结束任务和请求，不允许无限等待。

把 PM2 kill_timeout 调整到能覆盖 drain deadline，但不依赖延长 timeout 掩盖不可取消任务。

2.4 删除正常页面上的 debug SSE

- 从 hooks/useActivityPolling.ts 移除 useFeedJudgmentStream。
- 删除或默认禁用 /api/debug/tx-judgment/stream route；正常页面不再创建 EventSource。
- 若调试仍需读取 judgment，只保留显式 debug 开关下的一次性 GET，不保留 1.5 秒 timer 和自动重连。

关键文件：

- scripts/runtime-mode.ts
- server/runtime.ts
- server/server.ts
- server/runtime-context.ts
- server/runtime-api.ts
- pm2/ecosystem.config.cjs
- hooks/useActivityPolling.ts
- hooks/useFeedJudgmentStream.ts
- app/api/debug/tx-judgment/stream/route.ts
- server/legacy-routes.ts

3. 核心隔离：Web 变成纯 HTTP 进程

新增一个 PM2 管理的 pili-background-worker，复用现有任务注册和 worker 生命周期，不新建任务框架。

- 复用 createLoopTask、createTaskRegistry、createDefaultRuntimeTasks：server/runtime-tasks.ts。
- 复用 WorkerLease、createWorkerStatusReporter：scripts/lib/workerLifecycle.ts。
- 复用 worker_status / lease 表：lib/server/workerStateRepo.ts。
- 新 worker 承载：Feishu enablement、completeness、holdings、holder snapshot、live monitor、position-delta、orphan cleanup、feed healing、PASSIVE checkpoint。
- server/runtime-context.ts 的生产 Web 默认不再创建/启动这些周期任务；保留一个短期 emergency flag 仅用于回滚。
- Telegram bridge/channel worker 保持现状，不被 runtime:refresh 触碰。
- 明确每项任务只有一个所有者，删除 completeness 内部与 task registry 重复触发的任务。
- 给 holdings、completeness、live monitor、position-delta 等完整传递 AbortSignal；循环、分页、网络请求和写 batch 之间检查取消状态。
- createLoopTask.stop() 使用有界等待：abort、等待 soft deadline、记录 timeout、退出 worker；不能因单个外部请求无限卡住。
- 每项写任务使用现有 lease，避免误启动两份 worker 时重复执行。

关键文件：

- server/runtime-context.ts
- server/runtime-tasks.ts
- scripts/lib/workerLifecycle.ts
- lib/server/workerStateRepo.ts
- pm2/ecosystem.config.cjs
- package.json
- 各任务 runtime：lib/server/holdingsRefreshRuntime.ts、lib/server/liveMonitorRuntime.ts、lib/server/positionDeltaService.ts 等。

4. 收紧 SQLite：迁移单一所有者，GET 严格只读

4.1 GET 不得修库

拆分 eventsRepo 中的 monitor repair：

- 读取时允许做纯内存 projection，但不得 UPDATE monitor state、upsert events 或触发 FTS 写入。
- readEventsFeed() 和 /api/feed GET 不再调用 scheduleTelegramMonitorRepairBatch() 或任何持久化 healing。
- healing、orphan sync cleanup 移入 pili-background-worker。
- getSyncStatus() 变成纯读；markOrphanedSyncRunsAsFailed() 由 worker 周期执行。
- 增加 GET read-only 测试：请求前后关键表 revision/changes 不变；必要时在测试连接使用 PRAGMA query_only=ON 暴露隐藏写入。

4.2 统一 checkpoint 和锁等待策略

- 只有 background worker 周期执行 wal_checkpoint(PASSIVE)。
- Web、Telegram workers 不各自启动 checkpoint timer；在线期间禁止自动 TRUNCATE。
- Web 请求使用较短 busy timeout，锁忙时返回可重试 503 + Retry-After，不要同步卡满 8 秒。
- 后台 writer 可保留更长 busy timeout 和有界退避；事务不跨网络请求，按小批量提交并检查 abort。

4.3 schema migration 不再由所有进程启动时竞争

把真正 DDL/FTS migration 收敛到显式 migration 命令或唯一 owner；普通 Web/worker 启动只做 schema version 检查和 statement 准备。先复用现有 SQLite init/version guard，不引入新 migration 库。

关键文件：

- lib/server/sqlite.ts
- lib/server/eventsRepo.ts
- lib/server/syncService.ts
- app/api/feed/route.ts
- lib/server/telegramMonitorTxStateRepo.ts
- 新 background worker entrypoint。

5. Feed 后端：可靠 revision、缓存和轻量响应

5.1 修复快速路径

- GET /api/feed 的第一条业务查询必须是 revision；revision 相同立即返回 unchanged，不先读 prewarm/sync/users。
- changed 请求只创建一次 request-local context，复用同一份 users、sync、prewarm、window state，避免重复 getSyncStatus() 和 listTrackedUsers()。
- silent/background poll 默认自动带当前 revision，调用者不能漏传。

5.2 用单调 revision 代替 MAX(updated_at)

用 SQLite 中的轻量单行 revision/version 记录 feed 内容变化；events 的 insert/update/delete 都显式 bump，删除也必须可见。

- feed content revision 只由会改变 UI feed 的数据写入触发。
- worker heartbeat、prewarm 状态等不应让整个 200 条 feed 失效。
- 保留现有 query revision 参数兼容，后续可同时返回 ETag。

5.3 简单进程内缓存

使用原生 Map 做小型有界缓存，不加依赖：

- key：revision + canonical query + pageSize + cursor + filter/user。
- 缓存查询 DTO 或已序列化响应。
- 只保留少量最新 entries，并限制总字节；revision 改变自然失效。
- runtime status 暴露 hit/miss/bytes，证明确实有收益后再调整容量。

5.4 瘦身 feed 协议

在保持前端可迁移的前提下逐步调整：

- 首屏默认 100，最大 200；删除最大 400。
- cursor 页不执行 COUNT，只返回 hasMore、nextCursor；total 改为可选，不伪造当前页长度。
- 每个 item 只引用 userId，用户资料在顶层去重一次；不重复下发完整 user_json。
- activity 使用 UI 实际字段 allow-list，剔除原始 provider payload、内部 reconciliation 和诊断字段。
- sync/prewarm/assets/latestActivity 等低频 meta 不随每次 5 秒 items poll 重复下发，可拆成独立低频响应或仅在初次/目录 revision 变化时返回。
- 使用 Hono/平台已有压缩能力，不引入新的压缩依赖。

关键文件：

- app/api/feed/route.ts
- lib/server/eventsRepo.ts
- lib/activitiesApi.ts
- lib/server/httpCompat.ts
- hooks/useActivityPolling.ts
- types.ts 及 feed 客户端状态类型。

6. 前端轮询：single-flight、退避、可见性和取消

继续复用 FeedRequestArbiter，不引入新状态库或复杂跨标签页选主。

- 把固定 setInterval 改成请求完成后再安排下一次的递归 setTimeout。
- 成功时约 5 秒；连续失败按 5/10/20/40/60 秒退避，加入小幅 jitter；429/503 优先遵守 Retry-After。
- document.hidden 时停止背景 feed poll；重新可见或网络恢复时做一次 revision poll。
- 给 FeedRequestArbiter 增加 cancelActive() / dispose()，在 unmount、隐藏、筛选变化、foreground 抢占时 abort。
- AbortError 视为正常取消，不显示“拉取失败”。
- 保持单实例 single-flight；多标签页协调暂不实现，先观察 visibility + backoff 后的真实 QPS，只有仍有明显重复流量才增加 BroadcastChannel。
- 人物详情等其他周期请求同步应用 hidden/abort 原则。

关键文件：

- hooks/useFeedSnapshotPolling.ts
- hooks/useActivityPolling.ts
- hooks/useSelectedUserDetails.ts
- lib/feed/requestArbiter.ts
- lib/activitiesApi.ts
- lib/userDetailsApi.ts

7. position-delta：先隔离，再增量化

阶段 3 把 position-delta 移出 Web 后，API 阻塞问题已先解决；随后减少 worker 自身每 10 分钟全量扫描。

优先复用 positionDeltaService.ts 已有 seriesKey() 和 fillPositionDeltaRatios()：

1. ingestion 写入交易事件时记录或推导 chain|wallet|token series key。
2. 新增一个小型 dirty-series job 表，同一 series 多次变更合并为一项，并记录最早脏时间。
3. worker 每次领取有限数量 series，只读取该 series 的历史并调用现有算法。
4. 只写真正变化的 event；无变化时不刷新 updated_at 和 feed revision。
5. 每批检查 AbortSignal，事务保持短小。
6. 当前全量 runPositionDeltaFill() 保留为人工审计/修复命令，不再每 10 分钟自动扫描全部 6.1 万条。

关键文件：

- lib/server/positionDeltaService.ts
- blockchain event ingestion/upsert 路径。
- lib/server/sqlite.ts 中的新 job 表和索引。
- background worker task 注册。

Verification

自动测试

新增或更新最小、针对性的测试：

- runtime:refresh：build 发生在 PM2 操作前；build 失败不停止旧进程；不触碰任何 worker。
- readiness：listener/live、DB ready、draining 状态合同。
- graceful shutdown：先关闭 HTTP，再等待任务；慢请求可在期限内完成；无强制 SIGKILL。
- debug SSE：正常 feed 页面无 EventSource，stream route 默认不可用。
- runtime task：所有重任务收到 AbortSignal；stop 有界；lease 防重复执行。
- feed unchanged：revision 相同时不调用 prewarm/sync/users，body < 1KB。
- feed revision：insert/update/delete 都改变 revision。
- GET read-only：feed GET 前后数据库无写入。
- cursor：不执行 COUNT，分页无重复/遗漏，total 合同统一。
- payload budget：top 100 raw < 500KB、压缩目标 < 200KB。
- polling：失败退避、jitter、Retry-After、hidden pause、visible resume、unmount abort。
- position-delta：dirty series 去重、结果与全量算法一致、无变化不写 revision。

真实运行验证

遵守项目运行规则：Node 24.11.1；先 build/test，成功后才刷新生产 Web，不默认重启 workers。

1. 运行 TypeScript/check、相关 tests 和 npm run build。
2. 在生产库只读/影子副本上测 unchanged、changed 100/200 条 feed 的 DB、serialize、body bytes。
3. 启动 background worker，等待至少一个完整 holdings、live-monitor、position-delta 周期，确认 Web event-loop lag 不随任务抬升。
4. 连续执行至少 10 次 runtime:refresh，同时每 100–500ms 请求 live/ready/feed：
  - build 期间旧服务持续工作；
  - 无分钟级 refused；
  - 无 incomplete chunked response；
  - 无 PM2 forced SIGKILL；
  - workers PID 不变。
5. 30 分钟 soak：多客户端 5 秒 poll、Telegram writers 和 background worker 同时运行，统计 p95/p99、5xx、DB busy、event-loop lag、forced kill。
6. 使用 runtime:status 和 PM2 日志确认：Web tasks 列表为空或仅请求级状态；后台任务状态来自 worker_status。

阶段完成门槛

每阶段独立上线和观察，未达门槛不进入下一阶段：

- 止血阶段：build 不停旧服务；20 次 refresh 无 forced SIGKILL；正常页面无 SSE。
- 隔离阶段：position-delta/holdings 运行时 Web event-loop lag p95 < 50ms、p99 < 100ms。
- SQLite 阶段：feed GET 写入次数为 0；在线无 TRUNCATE；feed DB busy < 0.1%。
- feed 阶段：unchanged p95 < 50ms；changed top 100 本地 cold p95 < 500ms、warm p95 < 100ms；公网目标 p95 < 2s。
- 前端阶段：隐藏页背景 poll 为 0；持续错误最终降至约每 60 秒一次；卸载后无在途请求。

Scope Boundary

本计划能从设计上消除当前已确认的主动停机、后台任务阻塞 Web、错误 shutdown、debug SSE 放大、GET 写库、删除不可见 revision 和固定频率失败重试。它不能承诺单机在断电、磁盘损坏、Bun/PM2 自身崩溃、家庭网络或第三方 API 故障下绝对零中断；这些剩余风险应被隔离在对应 worker，并通过 ready、退避、状态和结构化日志清晰暴露，而不再拖垮整个 Web。

  Thought for 10s

先锁定当前未提交 diff 和已有 worker/状态路由，避免覆盖正在做的优化；然后按“最小可上线闭环”实施，不会一次性把协议和数据库全推倒。

  Thought for 10s, read 5 files, ran 1 shell command
6. 使用 runtime:status 和 PM2 日志确认：Web tasks 列表为空或仅请求级状态；后台任务状态来自 worker_status。

阶段完成门槛

每阶段独立上线和观察，未达门槛不进入下一阶段：

- 止血阶段：build 不停旧服务；20 次 refresh 无 forced SIGKILL；正常页面无 SSE。
- 隔离阶段：position-delta/holdings 运行时 Web event-loop lag p95 < 50ms、p99 < 100ms。
- SQLite 阶段：feed GET 写入次数为 0；在线无 TRUNCATE；feed DB busy < 0.1%。
- feed 阶段：unchanged p95 < 50ms；changed top 100 本地 cold p95 < 500ms、warm p95 < 100ms；公网目标 p95 < 2s。
- 前端阶段：隐藏页背景 poll 为 0；持续错误最终降至约每 60 秒一次；卸载后无在途请求。

Scope Boundary

本计划能从设计上消除当前已确认的主动停机、后台任务阻塞 Web、错误 shutdown、debug SSE 放大、GET 写库、删除不可见 revision 和固定频率失败重试。它不能承诺单机在断电、磁盘损坏、Bun/PM2 自身崩溃、家庭网络或第三方 API 故障下绝对零中断；这些剩余风险应被隔离在对应 worker，并通过 ready、退避、状态和结构化日志清晰暴露，而不再拖垮整个 Web。