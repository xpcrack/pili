# 聪明钱复合分 (Compound Quality Score) 改动文档

> 起源：2026-07-31 对话「挖掘能带量的 KOL/聪明钱」，基于 @TendersAlt 的《Solana Memecoin Playbook》方法论。
> 本文档记录**改动理由 + 过程**，便于日后回溯为什么从单 `followability_score` 升级到复合分。

---

## 0. 一句话动机

`user_pnl_stats.followability_score` 是单维综合分，会把**小样本高素养**和**大样本真水平**混在同一榜里。
demo 跑出来榜单第一的「深大」follow=0.815 但只有 11 个 roundtrip、已实现盈亏 $2.3k；而「Rop」follow 仅 0.650 却有 376 roundtrip、已实现 $1.88M、持仓均时 397h。

@TendersAlt 方法论反复强调「**持有越久越好、经过检验**」——单 `followability_score` 没有体现「体量验证」和「信念时长」。
本改动引入复合分，让小样本假高下沉、大样本真钱上浮，作为后续「KOL 带量榜」的输入。

---

## 1. 背景：tendy 方法论与 pili 现状的对应

### 1.1 tendy 信号分野

| 类别 | tendy 的说法 | 信号 |
|---|---|---|
| 聪明钱（钱包） | 「用 Fomo 看谁在**实际买入**」 | 钱包持仓质量 > 社交活动；信念度（不止盈 3% 就跑） |
| KOL（嘴） | 「在推这个币」 | 第二位；只有跟持仓重合时才是强信号 |

核心对立贯穿第 2 章 C / 第 3 章 因子 2、3：
> **「谁在真实买入」>「谁在喊」**；**「有些只发推不持仓」「有些静静持仓不发声」**——金矿是「持仓 + 喊单」双满足的叙事领袖。

### 1.2 pili 现状（demo 调查确认）

| tendy 要的 | pili 现状 | 差距 |
|---|---|---|
| 聪明钱钱包 | `tracked_addresses` + `user_pnl_stats` + `tradeSignal.ts smart-entry` | 基本齐全。`followability_score` 已是可跟单性综合分 |
| 信念度（持仓久） | `user_pnl_stats.avg_hold_hours_excl_swap`（排除满仓换仓） | 字段已存在，但未进综合分 |
| 经受检验的体量 | `user_pnl_stats.round_trips` / `realized_pnl_usd` | 字段已存在，但未进综合分 |
| KOL 提及影响力 | `twitter_tweet_token_mentions` 提取 | 有提取，无「带量」打分（第 2 档，本次不做） |

**结论**：第 1 档（聪明钱复合分）不是从零建，是**把现有 `followability_score` 与 `round_trips`/`avg_hold_hours_excl_swap` 组合成复合分**。数据全在 `user_pnl_stats` 表里。

---

## 2. 数据勘察结论（已实地确认）

主库：`.data/web3-feed.sqlite`（3.5 GB，有 WAL）。

### 2.1 `user_pnl_stats`（核心表）

- PK: `(user_id, window_key)`；window_key 取值 `all` / `365d` / `90d`。
- `all` 窗口 98 行、`followability_score` 在 163/285 行上有值。
- 关键字段（`all` 窗口平均：win_rate 0.42、profit_factor 2.03）：
  - `followability_score` — 现有可跟单性综合分（0~1）
  - `followability_parts_json` — 分项 JSON `{tokenConcentration, holdDuration, winRate, entryMarketCap}`
  - `avg_hold_hours_excl_swap` — 排除满仓换仓的持仓时长（信念度）
  - `round_trips` — 已平仓往返次数（体量验证）
  - `realized_pnl_usd` / `unrealized_pnl_usd` — 盈亏
  - `win_rate` / `profit_factor` — 胜率与盈亏比
  - `distinct_tokens` — 出手币数（越少越好）
  - `big_buy_win_rate` / `big_buy_round_trips` — 大本金胜率
  - `selector_score` / `selector_hit_rate` — 选币命中率
- 表注释明示 wiki 口径：「出手币数越少越好、持仓越久越好、入场市值越高越好、胜率越高越好」。

### 2.2 demo：聪明钱榜 TOP（`all` 窗口，现有单分排序）

| follow | 胜率 | PF | rt | 已实现 | 持仓h | 币数 | name |
|---|---|---|---|---|---|---|---|
| 0.815 | 0.45 | 0.64 | 11 | $2.3k | 213.7 | 29 | 深大 ← 小样本假高 |
| 0.650 | 0.41 | 1.46 | 376 | $1.88M | 397 | 508 | Rop ← 大样本真钱 |
| 0.590 | 0.43 | 1.92 | 733 | $1.35M | 118 | 835 | 重仓 ← 真钱被压低 |

**问题一眼可见**：深大 vs Rop，单 `followability_score` 把「小样本高素养」排到了「大样本真钱」之上。

### 2.3 JOIN 路径（第 2 档可行性预留）

- `events` 表 20.9 万条（blockchain 16.5 万 + twitter 3 万 + telegram 1.3 万），时间跨度 2024-02 ~ 2026-07。
- blockchain buy/sell 事件 30.5 万条可经 `address_lower` JOIN 回 `tracked_addresses`。
- `twitter_tweet_token_mentions` 2082 条带 `token_address_lower`，可与聪明钱交易按 token 地址对齐。
- → 「KOL 提及 X → N 小时内聪明钱也买 X」JOIN 路径完整可算（第 2 档，本次不做）。

---

## 3. 改动方案（已定位，行号均已确认）

### 3.1 计算入口与触发（定位结果）

- **计算入口**：`lib/server/walletPnlService.ts:243` `runWalletPnlFill()`。
  - `lib/server/walletPnlService.ts:352-364` 算 `followability`（调 `computeFollowability`）。
  - `:366-374` 算 `selectorMap`（调 `computeSelectorScore`）。
  - `:376` `return { windowKey, userStats, followability, selectorMap }` —— 新增 `compoundQuality` 在此后并列产出。
  - `:406` `writeResults()` → `:470-479` INSERT 列清单 → `:514-518` VALUES。
- **纯算法**：`lib/walletPnl.ts:414` `computeFollowability`（百分位 + 加权）、`:502` `computeSelectorScore`。新函数 `computeCompoundQualityScore` 加在 `lib/walletPnl.ts`，仿 selector 风格。
- **触发调度**：`server/runtime-tasks.ts:461-474` `wallet-pnl` LoopTask，**30 分钟一周期**（`CYCLE_INTERVAL_MS`），仅 background-worker 注册。复合分复用同一周期，无需新 worker。
- **迁移套路**：`lib/server/sqlite.ts:1563` `ensureWalletPnlColumns()` 用 `ensureColumn()` 发 `ALTER TABLE`，应用启动时自动补列。照 `selector_*` 当年进表的先例。
- **消费点**（决定复合分是否暴露）：
  - `app/api/ranking/route.ts:19` → `readUserPnlRanking()`（`walletPnlService.ts:528`）排行 API，`SELECT s.*` 自动带新列。
  - `app/ranking/page.tsx:265` 前端渲染 followability%。
  - `lib/server/tradeSignalService.ts:122-140` `loadTraderQuality()`、`lib/tradeSignal.ts:83-88` `isProvenTrader()` 门控 smart-entry（用 `followability_score`）。
  - **本次决定**：复合分算出并存库 + 进排行 API/类型；**暂不改 `isProvenTrader` 门控**（避免动到正在跑的信号推送，留第 2 档再评估接入）。

### 3.2 复合分定义（关键设计决策）

```
compound_quality_score = followability_score
                      × volume_factor(round_trips)
                      × conviction_factor(avg_hold_hours_excl_swap)
```

**为什么体量/信念用绝对阈值曲线、不用百分位**（读原码后的核心判断）：
`followability_score` 本身已是**同批次百分位**综合分，给出"相对位置"——但百分位**不区分样本量**：
11 roundtrip 的深大与 376 roundtrip 的 Rop 在同一百分位池里比，这正是病根。若体量系数也用百分位，则等于"在样本量上再排一次相对位置"，对"小样本是否可信"毫无约束、且与基础分循环耦合。
所以两系数都用**绝对阈值饱和曲线**：从小样本起步系数低、达到阈值后饱和到 1。这样只做"修正"而非"重排"——followability 高但样本不足者被往下压，大样本者不受惩罚。

- **volume_factor**（体量）：`round_trips` 的饱和曲线。
  - `rt=0` → 近 0；`rt` 到达 `VOLUME_SAT_RT`（暂定 **50**）后饱和到 1。
  - 11 rt 的深大 → 约半饱和；376 rt 的 Rop → 已饱和。
- **conviction_factor**（信念，tendy"持仓越久越好"）：`avg_hold_hours_excl_swap` 的饱和曲线。
  - 到达 `CONVICTION_SAT_HOURS`（暂定 **72h**）后饱和到 1；超长持仓不再额外加分（避免极端拉偏）。
  - null（持仓时长缺失）→ 系数 1（中性，不当惩罚，沿用 followability 的缺失中性原则）。
- **null 语义**：`followability_score` 为 null（round_trips < 10 样本不足置灰）→ 复合分也为 null，保持现有"样本不足不参排"语义。

新字段：`compound_quality_score REAL` + `compound_quality_parts_json TEXT`（记录 `{ volumeFactor, convictionFactor }` 便于解释）。

### 3.3 改动清单（行号已确定）

1. **schema**：`lib/server/sqlite.ts:1189` 后 CREATE TABLE 加两列；`:1581` 后 `ensureWalletPnlColumns` 加两行 `ensureColumn`。
2. **计算函数**：`lib/walletPnl.ts` 加 `computeCompoundQualityScore(inputs)` + 输入/结果 interface + 饱和曲线常量。
3. **接入计算**：`walletPnlService.ts:374` 后（selector 之后）调 `computeCompoundQualityScore` 产 `compoundMap`；`:404` `WindowResult` 加字段。
4. **回写**：`walletPnlService.ts:478` INSERT 列清单加 2 列、VALUES 占位加 2 个 `?`、`:518` 后加两行取值。
5. **类型 + 读取**：`lib/walletPnl.ts:549` `UserPnlRankingRow` 加两字段；`walletPnlService.ts:582` 后 `readUserPnlRanking` map 加两字段。
6. **不改**：`isProvenTrader` / `loadTraderQuality` / 前端排序键（本次只算 + 暴露，不动门控与排序）。

---

## 4. 过程日志

- **2026-07-31** 起源对话；读 tendy playbook；两路并行调查（仓库架构 + fomo 平台接口）。
  - fomo 结论：无公开 API，TOS 禁抓取；不接。需求落到「pili 现有 feed 聚合器 + 新增打分」。
- **2026-07-31** 实地勘察主库表结构（user_pnl_stats / events / twitter 三表 / tracked_* / newone.sqlite tokens）。
  - 关键发现：`user_pnl_stats` 已带 wiki 口径可跟单性维度，第 1 档是「复合化升级」非「从零建」。
- **2026-07-31** 跑 demo：聪明钱榜暴露「小样本假高 vs 大样本真钱」问题；JOIN 路径验证第 2 档可行。
- **2026-07-31** 定位计算入口（`walletPnlService.ts` / `walletPnl.ts` / `sqlite.ts`），行号逐一确认；精化设计——体量/信念系数用**绝对饱和曲线**而非百分位（避免与 followability 百分位循环耦合）。
- **2026-07-31** 落地代码 6 步：
  1. `lib/walletPnl.ts` 加 `computeCompoundQualityScore` + `compoundQualityScore`/`Parts` 类型 + `VOLUME_SAT_ROUND_TRIPS=50`/`CONVICTION_SAT_HOURS=72` + smoothstep `saturate()`。
  2. 同文件 `UserPnlRankingRow` 加 `compoundQualityScore`/`compoundQualityParts` 字段。
  3. `lib/server/sqlite.ts` CREATE TABLE + `ensureWalletPnlColumns` 各加两列。
  4. `lib/server/walletPnlService.ts` 加 import、selector 后接 `compoundMap`、`WindowResult` 加字段、INSERT 列+VALUES+取值、`readUserPnlRanking` map 加两字段。
  5. **不改** `isProvenTrader` / `loadTraderQuality` / 前端排序键（本次只算+暴露，不动门控）。
- **2026-07-31** 验证：
  1. `npx tsc --noEmit`：我改的三个文件零错误（仓库预存历史类型债与我无关）。
  2. `npm run build`：客户端构建通过（1927 模块，542ms）。
  3. dry-run backfill：算分逻辑跑通，98 人全覆盖，14.3s 无报错。
  4. `runtime:refresh`：`pili-web-prod` 用新代码重启，`ensureWalletPnlColumns` 自动迁移加列（PRAGMA 确认 34/35 列 `compound_*`）。
  5. `PILIPILI_ALLOW_PROD_DB_HEAVY=1` backfill 写库：98 人 / 57 个有复合分（与 followability 非空人数一致），15.1s。
  6. `/api/ranking?window=all`：消费侧正确吐出 `compoundQualityScore` + `compoundQualityParts`。

### 4.1 验证结果：新旧榜对比（设计目标达成）

旧榜（followability 排序）前几名全是小样本：深大 0.815(rt=11)、Jimmy 0.673(rt=10)、Kermit持8(rt=18)。
新榜（compound 排序）前几名全是大样本真钱：

| name | compound | follow | rt | realized | volFactor | convFactor |
|---|---|---|---|---|---|---|
| Rop | 0.650 | 0.650 | 376 | $1.88M | 1.000 | 1.000 |
| TimeA | 0.636 | 0.645 | 228 | $128k | 1.000 | 0.987 |
| 重仓 | 0.590 | 0.590 | 733 | $1.35M | 1.000 | 1.000 |
| 惠姐 | 0.542 | 0.619 | 39 | $44k | 0.876 | 1.000 |
| **深大** | **0.101** | **0.815** | **11** | **$2.3k** | **0.124** | 1.000 |

深大从旧榜第一跌出新榜前 15：followability 0.815 × volumeFactor 0.124（11 rt 半饱和以下）= 0.101。
Rop 从旧榜第四升到第一：两因子已饱和，compound = followability。
复合分「只 dampen 不 inflate」：compound ≤ followability 恒成立（两因子 ≤ 1），素质判断仍由 followability 主导。

### 4.2 待办（第 2 档）

- [ ] 复合分已就位，可作为第 2 档「KOL 带量榜」的「聪明钱」输入（JOIN 路径已验证：events 30.5万条↔tracked_addresses、twitter_tweet_token_mentions 2082 条带 token 地址）。
- [ ] 评估是否把 `compound_quality_score` 接入 `isProvenTrader` 门控（替/并 `followability_score`）——需先观察复合分稳定性。

### 4.3 收尾：worker 重启 + 前端暴露

- **2026-07-31** `pm2 restart pili-background-worker`：让它用新代码跑 wallet-pnl 周期，否则下次周期会把 compound 写成 null 冲掉 web 写入的值。已确认 online（新 pid）。
  - 净效果：复合分从此随 30 分钟周期自动更新，不再需要手动 backfill。
- **2026-07-31** 前端 `app/ranking/page.tsx` 暴露复合分：
  1. `SortKey` 加 `compoundQualityScore`，默认排序从 `followabilityScore` 切到 `compoundQualityScore`。
  2. 在「人物」后、「跟单分」前加「复合分」列（emerald 高亮主分）；跟单分降为 zinc-400 辅助，主次分明。
  3. 表格 `min-w` 900→1000px 容下新增列；底部说明加一段解释复合分公式与「只压不抬」语义。
  4. `npm run build` 通过（479.79KB，+1KB）；`runtime:refresh` 上线；bundle 确认含「复合分」+ `compoundQualityScore`。
  5. 设计选择：复合分列与跟单分列并列展示（而非用复合分替换跟单分），便于用户对照「修正前 vs 修正后」，符合「不删除既有信息」原则。
