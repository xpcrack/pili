# pilipili 代码审计与改进方案（最终合并版）

> 来源：四模型独立审计（gpt-5.6-sol / gpt-5.6-luna / Ox Alpha / deepseek-v4-flash）+ 人工复核。
> 所有条目均已回到源码核实，标注「已核实」的为确认事实；标注「待确认」的为证据链仍不完整、需读调用方后才能定性的。
> 已剔除的幻觉：deepseek 1.3「acquire 失败时 finally 仍释放未持有租约」——early return 位于 try 块之前，finally 不会执行，该条不成立。

---

## 总览

本次审计共确认 **8 个 Bug/高风险**、**12 个值得优化**。核心风险集中在三处：完整性维护 worker 的租约与异常路径、Twitter 富化管线的隔离性、worker 心跳状态机。

---

## 一、Bug / 高风险

### B1. Completeness 维护租约全程无心跳续期，90s 后可能被第二个实例接管 【已核实】

**位置：** `lib/server/completenessMaintenanceWorkerRuntime.ts`（WORKER_LEASE_TTL_MS = 90_000，`runCompletenessMaintenancePass()`）

**证据：**
```ts
if (!acquireIngestionLease(WORKER_KEY, ownerId, nowMs, WORKER_LEASE_TTL_MS)) { ... return busy }
const run = createCompletenessRun({ ... });   // ← 只在开头 acquire 一次
try {
  const result = await service.runOnce(input);  // ← MTProto 历史回填，单步可能超 90s
  ...
} finally {
  releaseIngestionLease(WORKER_KEY, ownerId);
}
```
该文件只导入了 `acquireIngestionLease / releaseIngestionLease`，**没有 `heartbeatIngestionLease`**。入口脚本 `scripts/completeness-maintenance-worker.ts` 只调 loop，未用 `WorkerLease`。

**风险（已核实为条件性，非必然）：** 单进程 loop 串行不会自竞争；触发需「pass 超 90s」+「第二个活着的进入者」（手动再跑一次 `npm run completeness:worker`、pm2 多实例、未来 API 触发）。一旦发生 = 同一 source 并发回填、checkpoint 覆盖、外部 API 重复请求、`activeRunId` 状态不一致。

**建议：**
1. acquire 成功后启动 `setInterval(() => heartbeatIngestionLease(...), ttl/3)`，`finally` 中 `clearInterval` + release；
2. 心跳返回 false 时：不再启动新 source step、将当前 run 标记 `lease-lost`/`failed`、不提交全局完整性状态；
3. 对已经开始且无法取消的外部调用，返回后再次验证租约所有权再提交 DB 结果；
4. 加并发测试：A 运行超 90s → B 尝试获取必须失败；A 丢租约后不得继续提交完成状态。

---

### B2. `createCompletenessRun()` 在 try 外，抛错时租约泄漏 + 无结束记录 【已核实】

**位置：** `lib/server/completenessMaintenanceWorkerRuntime.ts`（`runCompletenessMaintenancePass()`）

**证据：** `createCompletenessRun()` 位于 `try { ... } finally { release }` 之前。若它抛错（SQLite locked、schema 错误），`finally` 不执行 → 租约只能等 TTL 过期，期间其他 worker 持续认为 busy。
`service.runOnce()`、`appendCompletenessRunSource()`、`finishCompletenessRun()` 抛错时同理：**run 记录永远停留在 running 态**，无 catch 标记失败。

**风险：** completeness run 表残留未结束记录、全局状态可能保留错误 `activeRunId`、UI/诊断误判任务仍在执行、失败后 90s busy 窗口。

**建议：**
1. 租约获取成功后的第一行就进 `try/finally`，`createCompletenessRun()` 也放进去；
2. 用可空 `runId`：创建成功后记录 ID，任意后续异常时若已有 ID 则标记 `failed`（失败收尾 best-effort，不能阻止租约释放）；
3. 原始错误继续抛给 worker loop 保留重试行为；
4. 周期性修复超时未结束的 run，标记 `abandoned`；
5. 测试：`createCompletenessRun()` 抛错后租约被释放；`service.runOnce()` 抛错后 run 被标记失败。

---

### B3. `WorkerLease` 心跳失败后状态机矛盾：`isOwned()===true` 且 `isLost()===true` 【已核实】

**位置：** `scripts/lib/workerLifecycle.ts`（`startHeartbeat()`）

**证据：**
```ts
isOwned(): boolean { return this.leaseOwned; }
isLost(): boolean  { return this.leaseLost; }
shouldRun(): boolean { return !this.shuttingDown; }   // ← 不检查租约！

if (!heartbeatIngestionLease(...)) {
  this.leaseLost = true;          // ← 只设 leaseLost
  this.opts.status.set('lease-lost', ...);
  return;
}
```
没有：`leaseOwned = false`、停止心跳、中止当前消费循环。心跳**抛异常**时（SQLite busy）连 `leaseLost` 都不设，只打日志。结果：任何调用方只检查 `isOwned()` 或 `shouldRun()` 都会得到错误结果；租约过期被新实例取得后，旧实例可能继续消费（Telegram 更新重复消费、重复通知、并发推进 cursor）。

**建议：**
1. 心跳明确返回 false 时立即：`leaseLost = true` + `leaseOwned = false` + `stopHeartbeat()`；
2. `shouldRun()` 语义明确：若表示「进程未关闭」改名 `isActive()`；若表示「允许继续处理」必须同时检查 `leaseOwned` 和 `leaseLost`；
3. 为 `WorkerLease` 增加统一 `onLeaseLost` 回调（或 AbortSignal），让长轮询/批处理可中止；
4. 区分「单次 SQLite busy」与「已接近 TTL 仍无法续租」：前者记录重试，后者按租约失效处理（连续 2–3 次失败即停）；
5. 审计所有 `WorkerLease` 调用方，确认每个新任务/每批任务前检查租约状态；
6. 加状态机单测：acquire → heartbeat failure → release → reacquire。

---

### B4. 持仓刷新依赖完整性周期成功，周期持续报错时被永久饿死 【已核实】

**位置：** `lib/server/completenessMaintenanceWorkerRuntime.ts`（`runCompletenessMaintenanceWorkerLoop()`）

**证据：**
```ts
while (true) {
  try {
    const cycle = await runCompletenessMaintenanceWorkerCycle();
    await sleep(cycle.sleepMs);
    const nowMs = Date.now();
    if (nowMs - lastHoldingsRefreshMs >= HOLDINGS_REFRESH_INTERVAL_MS) {   // ← 在同一个 try 内
      lastHoldingsRefreshMs = nowMs;
      try { const result = await refreshCurrentHoldings(); ... }
      catch (error) { ... }
    }
  } catch (error) {          // ← cycle 抛错直接跳到这里
    upsertCompletenessWorkerStatus('error', message);
    await sleep(BUSY_RETRY_DELAY_MS);
  }
}
```
只要 `runCompletenessMaintenanceWorkerCycle()` 持续抛错，持仓刷新判断永远不会执行。且 `lastHoldingsRefreshMs = nowMs` 在刷新前更新，失败后需等完整间隔（默认 1h）才重试。

**风险：** Telegram/Twitter/完整性状态的永久错误连带停止持仓刷新；外部 API 短暂故障导致持仓延迟 1h 重试；两个职责互相影响，排障看不出持仓为何停。

**建议：**（保持轻量，不引入调度框架）
1. 「是否到期刷新持仓」的检查移出 cycle 的 try，独立函数，cycle 成功/失败后都执行；
2. 仅刷新成功后更新 `lastHoldingsRefreshMs`；
3. 单独记录 `lastHoldingsRefreshAttemptMs`，失败后 5–10 分钟短重试；用 `refreshInProgress` 防并发；
4. 测试：cycle 连续抛错时持仓仍按时刷新；失败按短间隔重试；成功后遵守正常间隔。

---

### B5. Twitter 富化：一条推文抛错炸掉整批 + 毒丸推文被 projector 无限重试 【已核实，四模型分歧最大处】

**位置：** `lib/server/twitterEnrichmentService.ts` + `lib/server/twitterFeedMapper.ts`

**证据（三处叠加）：**
1. `runEnrichmentForTweet()` 在写入 `processing` 状态（L335）之后，`enrichMentionsMarketData`（L447）、`findAddressesWithTrackedRiders`（L476）、最终 upsert 均不在 try/catch 内——已核实：L355 的 try 只包 `model.enrichTweet` 翻译调用；
2. 批处理主循环 `runTweetEnrichmentForTweetIds()` 对 `runEnrichmentForTweet` **没有 try/catch**（对比引号推文循环 L624 反而有）——一条推文抛错会中断同批剩余所有推文；
3. `twitterFeedMapper.ts:300-305` 的 pending 过滤条件是 `!enrich || translationStatus === 'pending' || 'processing'`——卡在 `processing` 的推文**每次投影都会重新入队**。

**修正后的后果（推翻「永久卡死」的说法）：** 不是推文永久停在 processing，而是反过来的两个问题：
- **毒丸放大**：某条推文持续抛错（如 DexScreener 异常），每个投影周期都重跑整批 LLM/vision/DexScreener，无退避、无上限；
- **孤儿行**：老推文滑出同步窗口后不再被投影扫到，此时才真正停在 processing。
- 另：主循环的 `failed` 计数是死逻辑（函数要么返回 true 要么 throw）。

**建议：**
1. `upsertTwitterTweetEnrichment('processing')` 之后整体包 try/catch，catch 中写 `'failed'` + `lastError` 再吞掉；
2. 主循环每条推文单独 try/catch（对齐引号推文循环的写法）；
3. projector 重试过滤对 `failed` 且 `lastError` 相同的行加退避（如 `lastProcessedAtMs` 距今 < 30min 跳过），防毒丸循环；
4. 加测试：一条推文抛错不影响同批其他推文；毒丸推文不会无限重试。

---

### B6. `parsePositiveFiniteNumber()` 接受尾部垃圾字符串，可能污染资金数据 【已核实】

**位置：** `lib/positiveNumber.ts`

**证据：**
```ts
const parsed = Number.parseFloat(value.trim().replaceAll(',', ''));
return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
```
`parseFloat()` 是前缀解析：`"123abc" → 123`、`"1.2USD" → 1.2`、`"10e2foo" → 1000`；`replaceAll(',', '')` 也接受错误格式 `"1,2,3" → 123`。该函数用于交易金额、tokenAmount、explicitPriceUsd（`tradeUsd.ts`），错误会静默进入 PnL、持仓和历史统计。

**注意（luna 的修正）：** 注释明确允许 comma-separated string，`'1,234'` 是合法输入，不能一刀切禁逗号；真正的问题是**尾部垃圾**。

**建议：**（先确认实际输入格式再改，避免误伤）
```ts
const normalized = value.trim().replaceAll(',', '');
if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;   // 完整匹配，不解析前缀
const parsed = Number(normalized);
return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
```
若业务需要科学计数法，显式加入格式。测试：`123abc → null`、`1.2xyz → null`、`1,234.56 → 1234.56`、空串/负数/Infinity → null。

---

### B7. 原生币历史价格查询抛错时，不回退到已有显式美元价格 【已核实】

**位置：** `lib/tradeUsd.ts`（`resolveTradeAmountUsdAtTx()`）

**证据：** 代码意图「优先 native quote × 历史价格，否则回退显式价格」，但 `fetchHistoricalTokenPrice()` 抛错（OKX 超时、代理失败、DNS 失败）时整个函数 reject，显式价格回退分支不会执行。已有可用 `explicitPriceUsd` 的交易仍无法计算 USD。

**建议：**
1. 只包历史价格查询分支：查询失败记录低频 warning 后走显式价格回退；**不要吞整个函数中的编程错误**；
2. 校验 `txTimestampMs` 是有限、合理的毫秒时间戳，无效则跳过历史查询用 fallback；
3. 测试：历史查询成功 / 返回空 / 抛错但显式价格存在 / 抛错且无 fallback。

---

### B8. `PILI_HOLDINGS_REFRESH_INTERVAL_MS` 配错产生两种相反故障，且静默 【已核实】

**位置：** `lib/server/completenessMaintenanceWorkerRuntime.ts`

**证据（Ox Alpha 修正了 sol 的证据错误）：**
```ts
const HOLDINGS_REFRESH_INTERVAL_MS = process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS
  ? parseInt(process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS, 10) : 60 * 60_000;
```
- `parseInt("abc")` → NaN → `nowMs - last >= NaN` 恒 false → **持仓永不刷新且无日志**；
- `parseInt("1h")` → **1**（不是 NaN）→ **每个 cycle 都触发一次全量持仓刷新**（打 GMGN 配额）；
- 两种配错都静默。

**建议：**
```ts
const parsed = Number.parseInt(process.env.PILI_HOLDINGS_REFRESH_INTERVAL_MS ?? '', 10);
const HOLDINGS_REFRESH_INTERVAL_MS = Number.isFinite(parsed) && parsed >= 60_000
  ? parsed : 60 * 60_000;
```
非法/过小值打印一次 warning 并回退默认值。

---

## 二、条件性风险（证据链仍缺一环，先确认再动）

### C1. Public Feed 明文 HTTP + Basic Auth 绑 0.0.0.0 【已核实代码，部署方式待确认】

`server/public-feed-server.ts:31,73`：fail-closed 逻辑没问题（未配口令直接 503），问题是凭证与内容明文过网，且默认绑所有网卡。**不要直接改绑 127.0.0.1**——如果当前是局域网 IP 直连或端口转发，改了当场断掉使用。先确认访问路径（本机反代 / Cloudflare Tunnel / 局域网直连）：
- 已有反代/隧道 → 默认绑 127.0.0.1，`PUBLIC_FEED_HOST` 环境变量保留覆盖能力；
- 确实直连公网 → 优先上 Cloudflare Tunnel（几行配置换最大收益），或 Caddy/Nginx 提供 TLS。

### C2. Media/avatar SSRF 防护基于 hostname allowlist，无 DNS/IP 层防护 【已核实，定性修正】

`lib/mediaProxy.ts`：suffix allowlist + 每跳 redirect 校验 + `redirect: 'manual'` 已做对。但 hostname 校验 ≠ 解析后 IP 校验：允许域名可能解析到内网（DNS rebinding/配置异常）。**luna 的修正是对的**：不能直接定性为「已确认 SSRF 漏洞」，因为 hostname 不是任意用户输入目标，触发需先让允许域名解析到内网地址。按暴露面定级：
- 仅本机监听 + 无不可信调用方 → P2，暂不处理；
- 可能暴露给局域网其他用户 → P1，拒绝解析到 loopback/private/link-local/multicast。

### C3. Stablecoin 仅按 symbol 判定等价 USD 【已核实，修复方案需重写】

`lib/tradeUsd.ts:67-73,93-99`：`STABLE_SYMBOLS.has(quoteTokenSymbol)`。**Ox Alpha 核实了关键事实**：三处调用方（`telegramMonitorActivity.ts:334,361`、`toActivity.ts:120`）传的都是 `quoteSymbol`——**整条链路没有 quote 代币地址**，「按链+地址建白名单」在现有数据结构下不可执行，需上游解析层先产出地址。定性：中低风险（受监控钱包恰好在假 USDT 池成交且解析出 "USDT" symbol 才触发），但污染 PnL 是静默的。
**务实建议（按成本递增）：**
1. 快路径命中时若同笔交易带 `explicitPriceUsd`，交叉校验偏差超阈值则弃用快路径；
2. 给 symbol-only 快路径结果打 `stableBySymbolOnly` 标记入库，便于事后清洗；
3. 长期：解析层能拿到 quote 地址时再落地址白名单。
另：`STABLE_SYMBOLS` 缺 FDUSD/TUSD/USDe/PYUSD/USDS/BUSD——这些只是掉慢路径，非错误。

### C4. Twitter 富化 `processing` 卡死恢复（B5 的补充） 【待确认】

`upsertTwitterTweetEnrichment` 的 `processing` 状态没有 `processingStartedAtMs` 超时恢复机制（B5 修好后主要靠 catch 写 failed 兜底）。建议在完整函数读完后确认是否需要加超时恢复任务。

### C5. 优雅退出可能永久挂起 【已核实】

`scripts/lib/workerLifecycle.ts:81-97`：第二个信号被 `exiting` 标志忽略；`onShutdown` 里卡死的 await（GramJS disconnect 等）会让进程既不退出也不响应 Ctrl-C，只能 SIGKILL。**建议**：进入 handler 时挂 10s 强制退出 timer（不 unref），正常完成后 clearTimeout，保留「第二次信号不打断清理」的原意。

---

## 三、值得优化

### O1. Media/avatar 缓存合并 + 总字节预算 + single-flight 【已核实】

两路由 ~80% 重复（fetchBytes、正负缓存、evict 全套）。问题：
- 只有条目数上限（media 300 × 1.5MB ≈ 450MB 上界；avatar 200 × 1MB ≈ 200MB 上界）——**上界不代表常态 RSS，但条目数无法反映真实内存成本**；
- 缓存 miss 无 in-flight Promise 合并：N 个并发请求各打一次上游（惊群）；
- avatar 最坏 4 候选 × 7s 串行 = 28s（常态首选 URL 命中，仅上游故障时恶化）；
- media 用 FIFO（命中不 bump recency），avatar 用近似 LRU，两套实现不一致。

**建议：** 抽 `lib/server/imageFetchCache.ts`：fetchBytes + 正负缓存 + in-flight Promise 共享 + 总字节预算（media 64–128MB、avatar 16–32MB），两路由各剩 ~30 行配置。不引入第三方缓存库，Map 够用。`POSITIVE_CACHE_MS` 与下发 `Cache-Control` 收敛为同一常量（注：服务端 6h / 浏览器 1h 本身是合理分层，**不是 bug**，只是该有个单一出处）。测试：20 个相同 URL 并发只触发一次 fetch。

### O2. 媒体代理失败统一 404 + 2min 负缓存，无法区分永久失败和临时故障 【已核实】

`app/api/media/route.ts`：真实 404、超时、429、5xx、不支持的 MIME、图片过大全部返回 `null` → 客户端统一 404 + 2min 负缓存。上游短暂故障看起来像资源不存在。
**建议：** 返回判别联合类型（ok / not_found / timeout / upstream_error / unsupported_type / too_large）；只对 404/410 用当前 2min 负缓存；超时/429/5xx 用 5–15s 短缓存；客户端状态码更准确（上游故障 502、超时 504、类型不支持 415、太大 413）。

### O3. avatar 缓存 key 使用未规范化 `preferredUrl` 【已核实】

`app/api/avatar/route.ts:190`：`cacheKey = twitter::preferredUrl`，无效 URL 也进 key → 同一用户 `?url=invalid-1` 和 `?url=invalid-2` 产生不同缓存项但请求同一 fallback，可被外部参数驱逐正常缓存。**建议**：先验证并规范化 `preferredUrl` 再进 key（不允许的 URL 统一按空串）；`handle`/`twitter`/`url` 设长度上限。media 同理：`cacheKey = raw` 未规范化（hostname 大小写、默认端口、URL 编码差异都会降低命中率），用 `new URL(raw)` 规范化后做 key。

### O4. `upsertWorkerStatus` 把已有 `last_update_id` 抹成 NULL 【已核实，防御性修复】

`lib/server/workerStateRepo.ts`：普通 `set('running'/'waiting')` 不带 `lastUpdateId` → 覆写为 NULL。**Ox Alpha 核实**：游标恢复实际走 `telegram_ingest_cursors`，当前无消费方读 `worker_status.last_update_id` 做恢复——所以是防御性修复，不是现行 bug。UPDATE 分支改 `last_update_id = COALESCE(excluded.last_update_id, worker_status.last_update_id)` 即可。

### O5. claimed pokes 无崩溃恢复路径 【已核实】

`lib/server/completenessRepo.ts`：`readPendingCompletenessPokes` 只取 `claimed_at IS NULL`；claim/release/delete 都以 `claimed_at` 精确匹配。cycle 中 claim 后进程崩溃 → 这批 pokes 永久滞留 claimed 态，repo 层无 stale 回收。影响低（pokes 只是触发器，interval sweep 兜底）。**建议**：`readPendingCompletenessPokes` 增加 `OR claimed_at < ?(-10min)` 分支重新认领。

### O6. 重定向被拒绝时部分路径未 cancel response body 【已核实】

`lib/mediaProxy.ts`：3xx 无 Location / 已达最大重定向数时直接返回 null 未 cancel body。通常 redirect body 很小，非高风险，但影响连接复用确定性。封装 `discardResponse()` 统一处理。

### O7. Public feed 每请求打内部 API + CORS `*` + SPA fallback 返回 HTML 200 【已核实】

- 每请求都 `fetch` 内部 `/api/feed`：个人工具访问量低可暂不改；如需，加 5–30s 内存缓存 + in-flight 去重 + `X-Feed-Stale: 1`；
- `'access-control-allow-origin': '*'`：SPA 同源则直接删掉，跨域用固定 allowlist；
- 缺失 `/assets/*` 资源或未知 `/api/*` 会进 SPA fallback 返回 HTML 200：fallback 前加 `/assets/*` 明确 404、`/api/*` 明确 JSON 404；HTML 用 `no-cache`、hash 资源用长期缓存；启动时检查 `dist/client/index.html` 存在。

### O8. `readTelegramIngestCursor()` 读取路径无 busy retry 【已核实，需谨慎】

写入路径走 `runBookkeepingWrite`（retry + 非致命），读取路径裸查。**不能简单吞异常返回 0**——否则可能从错误位置重新拉取大量历史数据。建议：调用方明确区分「无 cursor → undefined」「DB 暂不可读 → 抛错重试」「重试耗尽 → degraded 状态，不从 0 开始」。

### O9. 测试 runner 子进程树清理 + 超时 SIGKILL 【已核实】

`scripts/lib/runTests.ts`：`spawn('npx', ['tsx', file])` 超时 `child.kill('SIGKILL')`，Unix 下杀 wrapper 不保证整个 process tree 终止。建议：独立 process group、超时杀整组、`close` 事件后清理临时目录、超时先 SIGTERM 再 SIGKILL。另：`child.on('error')` 回调应先 `clearTimeout(timer)`（deepseek 这条是对的，已核实代码确实在 error 分支缺 clearTimeout）。

### O10. `NODE_USE_ENV_PROXY` 运行时设置不生效 【已核实，影响面待确认】

`scripts/lib/workerLifecycle.ts` 运行时设置 `NODE_USE_ENV_PROXY=1` 和 `HTTP(S)_PROXY=127.0.0.1:7897`，但该变量是 Node fetch 启动时读取的。package.json 里 `telegram:bridge`、`background:worker` 有前置声明，`completeness:worker`、`telegram:channel:worker` 没有。**待确认**：completeness/telegram-channel worker 是否实际依赖 Node 全局 fetch 代理（若用 undici 显式 ProxyAgent 则无影响）。建议：统一 worker launcher 或 pm2 ecosystem 注入，避免脚本里复制长串环境变量。

### O11. 媒体/头像缓存过期项不主动清理 + `readResponseBodyLimited` 组装期双倍内存 【已核实】

- 命中过期项时不删除，只有容量淘汰；建议命中过期立即删、插入前清理过期项；
- `readResponseBodyLimited` 先存 chunks 再分配最终 buffer，单次读取峰值双倍内存——1.5MB 上限下可接受，合并 O1 重构时顺手优化。

### O12. 工程一致性：Node/Bun/tsx 三套运行时边界不明确 【已核实】

`package.json` engines 要求 Node 24，web runtime 用 Bun，worker 用 tsx，native 依赖 better-sqlite3 的安装/验证运行时未明确。建议：文档明确各 runtime 边界；`npm run check` 增加最小启动 smoke test（不只是 vite build）。

---

## 四、已核实为「非问题」（防止未来重复报）

- **deepseek 1.3**：acquire 失败时 finally 释放未持有租约——early return 在 try 前，不成立。
- **media 缓存 650MB**：是理论上界，不是常态 RSS，降为优化项（O1）。
- **octet-stream 伪装 PNG = XSS**：已有 `X-Content-Type-Options: nosniff` + `image/png`，浏览器不会执行 HTML，降为内容校验优化（O2 附带）。
- **CSRF（sec-fetch-site）**：当前片段无法证明 mutation 路由用 Cookie + 公网可达，定性为「不完整认证边界」而非已确认漏洞；保持现状 + 绑定 127.0.0.1 即可（若引入 Cookie 认证再补 Origin 校验）。
- **POST redirect 方法语义**：调用方全为 GET，无实际影响。
- **服务端 6h / 浏览器 1h 缓存分层**：合理设计，不是 bug。

---

## 五、实施顺序

### P0（本周，数据正确性 + 稳定性）
1. **B2**：`createCompletenessRun()` 纳入 try/finally + run 失败收尾（顺带修租约泄漏）
2. **B1**：completeness pass 加租约心跳续期
3. **B3**：WorkerLease 心跳失败状态机修复（leaseOwned=false + stopHeartbeat）
4. **B5**：Twitter 富化 try/catch 隔离 + projector 重试退避
5. **B6**：`parsePositiveFiniteNumber` 完整字符串校验

### P1（近期）
6. **B7**：历史价格查询异常回退显式价格
7. **B8**：持仓刷新间隔严格校验
8. **B4**：持仓刷新与完整性周期解耦 + 失败短重试
9. **O1**：media/avatar 缓存合并 + 字节预算 + single-flight
10. **O2**：媒体代理失败分类（502/504/415/413）

### P2（按实际使用情况）
11. **C1**：确认 public-feed 访问路径后决定绑定/TLS
12. **O4–O9**：防御性修复（last_update_id COALESCE、pokes 回收、body cancel、feed 缓存、test tree、cursor 读取）
13. **C5**：优雅退出 10s 强制超时
14. **C2/C3**：SSRF IP 层防护（若暴露局域网）、stablecoin 交叉校验
15. **O10–O12**：代理注入统一、缓存过期清理、运行时边界文档

---

## 附：四模型方案质量速评（供参考）

| 维度 | 最佳 | 备注 |
|------|------|------|
| 综合 | gpt-5.6-sol | 广度深度均衡，独有发现最多（B4 饿死、NODE_USE_ENV_PROXY） |
| 证据纪律 | gpt-5.6-luna | 主动保留「未确认结论」清单，纠正 octet-stream 误判 |
| 单条深挖 | Ox Alpha | B5 毒丸重试、O4/O5 核实调用方，但享受了工具访问加成 |
| 幻觉率 | deepseek-v4-flash 最高 | 1.3 为编造 bug |
| 未覆盖 | 全部 | 均未发现「直接贴 CA 绕过小币过滤」（需业务语义理解） |
