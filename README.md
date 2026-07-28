# 交易流服务

一个实时聚合并展示链上交易事件（买入/卖出）的 Web 应用，支持人物画像、持仓分析、行情联动。

---

## 核心功能

- **实时交易流**：WebSocket 推送链上交易事件（买入/卖出），支持自动重连
- **人物画像**：地址关联真实人物，展示交易统计（胜率、盈亏比、热门代币）
- **持仓明细**：当前持仓代币、数量、成本、浮盈亏
- **代币详情**：K线、市值、持仓者网络（谁跟谁买了同一币）
- **行情联动**：顶部 ticker 实时显示持仓代币价格

---

## 数据流架构

```
[数据源链上] → telegram-bridge(WS) → memory buffer(10s批量)
    ↓
[SQLite: trades/raw] → lib/server/eventsRepo.ts → 内存 200 条
    ↓
[Hono REST] → GET /api/feed → JSON: events[]
    ↓
[SSE] → GET /api/feed/stream → 实时推送
    ↓
[前端 React] → /feed → 交易流 UI
```

---

## 数据源

- **Telegram 桥**：链上事件通过 Telegram Bot API 实时推送
- **WebSocket**：前端通过 SSE（Server-Sent Events）连接 `/api/feed/stream`

---

## 数据存储

- **SQLite**：`.data/web3-feed.sqlite`
  - `trades` 表：交易事件（地址、代币、方向、金额、时间）
  - `addresses` 表：地址标签（人物名、标签、社交链接）
  - `persons` 表：人物画像统计（胜率、盈亏比、总 PnL）
- **内存缓存**：最新 200 条事件常驻内存

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
  pili-web-prod       → 生产 Web 服务（Bun/Hono，端口 3005）
  pili-feed-writer    → 写入器（消费 telegram-bridge，批量写 SQLite）
  pili-tg-forwarder   → Telegram 转发器
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
