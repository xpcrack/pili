# 交易流服务

一个实时聚合并展示链上交易事件（买入/卖出）的 Web 应用，支持人物画像、持仓分析、行情联动。

---

## 核心功能

- **实时交易流**：按 revision 轮询获取链上交易事件（买入/卖出），自动刷新
- **人物画像**：地址关联真实人物，展示交易统计（胜率、盈亏比、热门代币）
- **持仓明细**：当前持仓代币、数量、成本、浮盈亏
- **代币详情**：K线、市值、持仓者网络（谁跟谁买了同一币）
- **行情联动**：顶部 ticker 实时显示持仓代币价格

---

## 数据流架构

```
[链上事件] → telegram-bridge 摄取(xxyy 信号/监控) → 后台写入器批量入库
    ↓
[SQLite: events / raw_transactions] → feedSnapshotRepo / eventsRepo
    ↓
[Hono REST] → GET /api/feed（前端按 revision 轮询）→ JSON: events[]
    ↓
[前端 React] → /feed → 交易流 UI
```

---

## 数据源

- **Telegram 桥**：`pili-telegram-bridge` 摄取链上交易信号并入库
- **前端拉取**：React 前端通过 `GET /api/feed` 按 revision 轮询获取动态（非 WebSocket/SSE）

---

## 数据存储

- **SQLite**：`.data/web3-feed.sqlite`（`.data/` 不入库）
  - `events` / `raw_transactions`：链上交易与原始事件
  - `tracked_users` / `tracked_addresses`：人物与地址标签
  - `current_holdings`：当前持仓
  - `activity_feed` / `activity_judgments`：动态流与判定
  - 另有 pnl、twitter、completeness、holder_snapshot 等多张表

---

## 快速启动

```bash
# 依赖安装
npm install

# 开发模式（hot reload）
npm run dev

# 生产构建
npm run build
npm start

# PM2 管理
npm run runtime:status
npm run runtime:refresh
```

---

## PM2 进程拓扑

```
pm2 ecosystem:
  pili-web-prod                → 生产 Web/API（Bun/Hono，端口 3013）
  pili-web-dev                 → 开发模式（端口 3005）
  pili-background-worker       → 后台写入/资产同步/PnL
  pili-telegram-bridge         → 链上信号摄取入库
  pili-telegram-channel-worker → Telegram 频道监控
```

---

## 技术栈

- **运行时**：Bun 1.x / Node 24
- **框架**：Hono（后端）+ React + Vite（前端）
- **数据库**：SQLite（better-sqlite3）
- **实时推送**：SSE（Server-Sent Events）
- **进程管理**：PM2

---

## 项目结构

```
pilipili/
├── app/
│   ├── api/           # REST/SSE API handlers
│   └── feed/          # React 交易流 UI
├── lib/server/        # 后端核心（SQLite、事件仓库、缓存）
├── scripts/           # 数据脚本（backfill、refresh）
├── pm2/               # PM2 配置
└── .data/             # SQLite 数据库
```
