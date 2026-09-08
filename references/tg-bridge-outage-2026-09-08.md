# pili-telegram-bridge TG 断流告警 + 代理池 failover （2026-09-08）

## 症状
bridge 用 `getUpdates` 长轮询从 Telegram 拉 xxyy 消息，走 Clash 代理
`http://127.0.0.1:7897`。当 7897 隧道到 `api.telegram.org:443` 断流时，bridge
只是在 `catch` 里 `sleep(3s)` 重试，**没有告警** —— 直到用户自己发现同车
落后 2h 才知道。

实测（sus × pow 交易）：
- xxyy 报事件时间 `event_time_ms` = 20:18:35
- bridge 落库 `telegram_monitor_events.created_at` = 22:23:22
- lag = 7487s ≈ **2h4min**

`pili-telegram-bridge-error.log` 全是
`ConnectTimeoutError / ECONNRESET api.telegram.org:443`；bridge 没挂
(process 仍 running, heartbeat ok)，只是 getUpdates 轮询永远 timeout。

近 24h 统计：2020 条事件 lag >1h（一次性积灯），正常波动 1271 条 <1min。

## 根因
- 2026-08-29 的「偶发 360s」断流写进 `co-ride-delay-triage-2026-08-29.md`
  时当作「单次抽风自愤」处理，没加告警 / failover。
- 7897 是 Clash **默认组**，单条隧道抽风 = 全业务 halt。

## 修复（2026-09-08 落地）

### 1. `lib/server/telegramBotApi.ts` — 代理池 failover
- `proxyUrl?: string | string[] | null`（兼容旧单字符串）
- 网络错误（ECONNRESET/timeout 等 `isTransientNetworkError`）时，
  `rotateProxy()` 顺序切到下一个代理 + 重建 ProxyAgent。
- 新增 `onNetworkFailure({ attempt, proxy, error })` 钩子。
- 导出 `readTelegramBotApiProxyList()`（读 `TELEGRAM_BOT_API_PROXY_POOL`
  逗号分隔，回退 `TELEGRAM_BOT_API_PROXY`/`HTTPS_PROXY`/...）。

### 2. `scripts/telegram-bridge.ts` — 断流 Bark 告警
- 连续 `getUpdates network failed` ≥5 次 → `pushBark` 一次
  「⚠️ pili TG 通道断流（N consecutive failures）」；
- 告警间隔 `GETUPDATES_REALERT_MS = 30min` 节流；
- 成功后清零 `consecutiveGetUpdatesErrors`。

### 3. `pm2/ecosystem.config.cjs` — 多代理 env
```
TELEGRAM_BOT_API_PROXY_POOL: 'http://127.0.0.1:7897,http://127.0.0.1:17890,http://127.0.0.1:17891'
```
17890/17891 是 Clash listeners 绑的固定地区出口 IP（香港/日本），
单条隧道抽风自动切另一个出口，**不用等用户发现**。

### 4. `lib/server/telegramBridgeRuntime.ts` — 同步改掉
- `proxyUrl: readTelegramBotApiProxyUrl()` → `readTelegramBotApiProxyList()`。

**重启**：`pm2 restart pili-telegram-bridge`。

## 验证
- 单元测试新增代理池 failover block，`npx tsx scripts/lib/runTests.ts --root=scripts --filter=telegram-bot-api` PASS；
- bridge 日志：`getUpdates recovered after N consecutive failures` 出现在一次性告警后。

## 排查 checklist
1. `sqlite3 web3-feed.sqlite "SELECT … lag_sec … ORDER BY id DESC LIMIT 5"` — lag 又 >360s 时看下一步；
2. `tail -50 ~/.pm2/logs/pili-telegram-bridge-error.log | grep getUpdates` — 连续 `api.telegram.org:443 timeout/ECONNRESET`；
3. `curl -s -m 8 --proxy http://127.0.0.1:7897 https://api.telegram.org/` — 000 = 7897 断了，切 17890；
4. 代理池生效否：bridge env 里 `TELEGRAM_BOT_API_PROXY_POOL` 是否 3 项。

## 相关
- 同车断流诊断方法论：`references/co-ride-delay-triage-2026-08-29.md`
- Clash TG 自动组 + listener 出口 IP：`clash-verge-admin` skill / `profiles/sjFDxxzD2a7l.js` `config.listeners`
