# pilipili 代码审计与改进方案

> 审计范围：全仓（重点为当前 25 个未提交修改文件 + 7 个新文件），基于 `git diff`（871 insert / 423 delete）与热点文件通读。
> 验证基线：`tsc --noEmit` 通过、`eslint` 零告警。以下问题均为逻辑/架构层面，非编译错误。

## 总评

本批改动整体质量高：媒体代理的 SSRF 加固（redirect 逐跳校验、流式限长读取、MIME 白名单 + nosniff）、API 层 bodyLimit + CSRF 防护、测试 DB 隔离（mkdtemp）都是正确的方向。下面按严重程度列出发现的问题。

---

## 一、Bug / 高风险

### 1. 直接贴 CA 的帖子完全绕过小币噪声过滤（twitterEnrichmentService.ts:460-477）
`directCaAddresses` 命中后 `return true` 无条件保留。任何人发一条含随机 CA 的推文（垃圾盘、rug 币），该 mention 就绕过 MC<100K + 无同车的过滤直接进 feed。
- 风险：feed 质量回退，且这是可被外部行为触发的（发推即可）。
- 建议：直接 CA 保留但仍要求最低门槛（如 MC 已解析且 > 某阈值，或至少去重同一 CA 短窗口内多次出现只保留首条）。

### 2. `touchWorkerHeartbeat` 改为快失败后，心跳静默丢失无任何观测（workerStateRepo.ts:93-108）
busy_timeout=0 撞锁即失败，只 `console.warn`。设计动机正确（不阻塞事件循环），但后果是：主库写入繁忙期间 worker_status 心跳会连续缺失，而监控/恢复逻辑若依赖 `last_heartbeat_at_ms` 判活，会出现「worker 活着但被判死」或「告警噪声」。
- 建议：a) 连续 N 次失败后升级为一次带重试的 `upsertWorkerStatus`（低频补偿写）；b) 或在 warn 里带上连续失败计数，便于日志排查。

### 3. avatar 请求最坏 21 秒串行阻塞（app/api/avatar/route.ts:174-178）
`resolveTwitterAvatar` 串行尝试最多 3 个候选 URL，每个 7s 超时。且**没有并发去重**：feed 一屏几十个头像同时请求同一 handle 时，全部各自发起上游抓取（惊群），缓存只在各自完成后才写入。
- 建议：加 in-flight Promise map（同 key 复用同一个抓取 Promise），候选 2/3（unavatar）可考虑缩短超时。

### 4. media/avatar 代理无速率限制（app/api/media/route.ts、avatar/route.ts）
两个端点接受任意 `?url=` 并经本机 Clash 代理拉外链。虽然域名白名单挡住了 SSRF，但没有限流：一个失控的前端循环或恶意页面（内网可直连 3013）可让本机持续代刷 twimg/unavatar，消耗代理流量并可能触发上游封禁。
- 建议：简单的进程内令牌桶（按 IP 或全局）即可，个人工具不需要复杂方案。

### 5. CSRF 中间件只拦 `sec-fetch-site: cross-site`（server/api.ts:23-30）
不带该头的客户端（curl、旧浏览器、部分 WebView）全部放行。当前服务只绑 127.0.0.1，实际暴露面小，但 public-feed（0.0.0.0 + basic auth）只代理 GET /api/feed，所以写接口目前是安全的——**前提是这个代理白名单不再扩大**。建议在 legacy-routes 加路由时加一条测试：任何非 GET 路由进入 public-feed 代理必须失败（防止将来顺手加 POST 代理时打开洞）。

---

## 二、值得优化

### 6. 测试断言源码字符串位置，过于脆弱（scripts/test-runtime-env-fallback.ts:15-20）
用 `indexOf('loadRuntimeEnv(...)') < indexOf('process.env.PUBLIC_FEED_PORT')` 断言顺序——重命名变量或加一行注释都可能误伤。
- 建议：改为运行时验证（在子进程里设 `PUBLIC_FEED_PORT` + 伪造 .env.local，断言监听端口正确），源码文本断言只留作兜底或删除。

### 7. media/avatar 缓存的过期项不主动清理
`evict` 只在 `size >= max` 时逐出最旧项；过期但未到容量上限的条目一直驻留（avatar 上限 200 条 × 1MB ≈ 200MB 常驻上限，media 300 × 1.5MB ≈ 450MB）。实际到不了上限问题不大，但建议在缓存命中检查时顺手删除过期项，或把上限调低（头像 200 条明显偏大，1MB/张的"头像"本身就该拒收，建议 MAX_AVATAR_BYTES 降到 256KB）。

### 8. public-feed 的 `serveStatic({ root: './dist/client' })` 依赖 cwd（public-feed-server.ts:47）
launchagent/pm2 若从别的目录启动就 404。同文件 `repoRoot = process.cwd()` 同理。建议统一用 `import.meta.dirname` 推导 repoRoot（vite.config.mts 已经这么改了，保持一致）。

### 9. `fetchAllowedRedirects` 重定向时未按规范处理 303/302 方法改写
当前只用于 GET 且不带 body，无实际 bug；但作为通用工具，303 应改写为 GET 并丢弃 body。加个注释或直接实现，避免将来有人拿它发 POST。

### 10. avatar 缓存 key 含未截断的原始 `url` 参数（route.ts:190）
`cacheKey = twitter::preferredUrl`，url 是外部输入，超长字符串会进 Map key。截断到 512 字符或只保留规范化后的 URL。

### 11. 仓库卫生
- `.claude/worktrees/`（7 个）+ `.worktrees/`（3 个）陈旧工作树留在仓库里：污染全局搜索（本次审计 grep 命中的大半是副本）、占磁盘。建议合并/清理后删除，只保留 eslint ignore。
- `.data/` 已 11GB；且存在 4 个 0 字节的遗留 db（app.db / pili.db / pilipili.db / prod.db），真实库另有其名——容易误导排查（"改了半天怎么没生效"）。确认无用后删除。
- `tsconfig.tsbuildinfo` 提交在仓库根目录，应进 .gitignore。

### 12. runTests.ts 临时目录清理边界（scripts/lib/runTests.ts:95-145）
`mkdtempSync` 在 spawn 前；若 spawn 同步抛错（罕见）临时目录泄漏。把 mkdtemp 挪进 try 或在 spawn 的 try/catch 里补 rmSync。另外超时 kill 后 `rmSync` 在 exit 事件里执行，Windows 上可能 EBUSY——macOS 单机使用可忽略。

### 13. 依赖升级批次（package-lock）
本批同时升级了 vite 8.0.14→8.2.1、hono 4.12→4.13、rolldown 1.0→1.2、tsx 4.21→4.23。跨度不小，建议单独一个 commit（当前与功能改动混在一起），并在 `npm run check` 里跑过完整 build 后再合入——rolldown 大版本跳变是本次最可能引入回归的项。

---

## 三、做得好的（保持）

- `readResponseBodyLimited` 流式限长 + content-length 预检，正确防住了"声明小实际大"的攻击面。
- `fetchAllowedRedirects` 每一跳都过白名单，注释把"为什么不用 redirect: follow"讲清楚了。
- 测试默认隔离 DB（PILIPILI_DATA_DIR/PILIPILI_DB_PATH 指向 mkdtemp），消除了测试写真实库的隐患。
- `vite.config.ts → .mts` + `import.meta.dirname`，修掉了 CJS 解析歧义。
- worker 心跳不阻塞事件循环的取舍有清晰的注释说明动机（677 次 pm2 重启的教训）。

## 建议处理顺序

1. #1（feed 质量回退，直接影响使用）
2. #2（监控误判）+ #3（头像惊群，体感明显）
3. #4/#5（安全收尾，半小时工作量）
4. #11（仓库卫生，一次清理）
5. 其余按顺手程度处理
