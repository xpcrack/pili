# Reusable Backfill Workflow Design

日期：2026-04-28  
状态：草案（已在 brainstorming 过程中确认）  
负责人：Feed pipeline

## 1. 背景与问题
当前仓库里已经存在多条“补数据”链路，但它们还不是同一个可复用流程：

- 链上交易有按时间窗构建 feed 的能力，也有单独的 `14days` 回填入口。
- Twitter 已经支持按 `windowDays` 做同步与补拉。
- Telegram bridge / monitor 具备历史回灌入口，但当前是按条数抓取最新消息。
- Telegram channel 已具备增量拉新能力，但历史补齐仍偏向“拉最近 N 条”，不是按时间窗证明覆盖完成。

这带来三个问题：

1. 每次要补齐新的时间窗，都需要再写一套 `7d` / `14d` / `30d` 特化逻辑。
2. “所有源已补齐到某个起点”的语义没有统一定义，难以判断任务是否真正完成。
3. 编排、分页、断点恢复、统计口径分散在不同入口里，失败后难以安全重试。

## 2. 目标与非目标
目标：

- 设计一个可复用的 backfill workflow，输入“想要的完备起点时间”和目标结束时间，自动补齐到该时间窗。
- 统一管理 `blockchain`、`twitter`、`telegram-bridge`、`telegram-channel` 四类 source 的补齐流程。
- 为每个 source 定义统一的“覆盖完成”判断方式，而不是只返回“跑过了”。
- 支持断点恢复、失败重试、部分成功汇总和可观测状态。
- 让“近 14 天补齐”成为该 workflow 的一次调用，而不是新的专用实现。

非目标：

- 本期不修改默认前台 `7d` 预热 / prewarm 行为。
- 不在本期重做 feed API、首页状态条或全局调度器。
- 不把所有 source 强行做成完全相同的分页协议；差异保留在 adapter 内部。
- 不在本期引入前端复杂管理 UI，先以服务层 + 管理 API / CLI 为主。

## 3. 关键定义
### 3.1 完备起点时间
“完备起点时间”指 workflow 希望保证某一组 source 在 `[startMs, endMs]` 时间窗内已经补齐数据，其中：

- `startMs`：期望覆盖到的最早时间。
- `endMs`：期望覆盖到的最晚时间，默认可取当前时间。

若某个 source 能证明其实际覆盖满足：

- `coveredStartMs <= startMs`
- `coveredEndMs >= endMs`

则可视为该 source 在本次 workflow 中“已补齐”。

### 3.2 补齐完成
workflow 完成不再只看“任务是否执行结束”，而要看：

1. 指定 source 是否都执行完成。
2. 每个 source 是否都能证明覆盖已经触达目标窗口。
3. 若存在部分 source 失败或覆盖不足，workflow 结果应为 `partial`，而不是伪装成成功。

## 4. 总体架构
新增一层统一编排服务，例如：

- `lib/server/backfillWorkflowService.ts`

该服务负责：

1. 标准化输入时间窗与 source 选择。
2. 维护 workflow run 状态与每个 source 的检查点。
3. 以统一协议调度各 source adapter。
4. 汇总结果并输出统一统计。

整体分层：

1. `backfillWorkflowService`
   - 负责编排、状态、重试、汇总。
2. `backfillSourceAdapters`
   - 每个 source 一个 adapter，封装自己的分页 / 游标 / 覆盖判定逻辑。
3. 现有业务服务复用层
   - 链上复用 `buildActivityFeed`
   - Twitter 复用 `runTwitterSyncAction`
   - Telegram bridge 复用并扩展 `backfillTelegramBridgeHistory`
   - Telegram channel 复用并扩展 `telegramChannelSync` / GramJS client

## 5. Workflow 输入与输出契约
### 5.1 输入
建议的统一输入：

```ts
export type BackfillWorkflowSource =
  | 'blockchain'
  | 'twitter'
  | 'telegram-bridge'
  | 'telegram-channel';

export interface BackfillWorkflowInput {
  startMs: number;
  endMs: number;
  userId?: string | null;
  sources?: BackfillWorkflowSource[];
  mode?: 'upsert' | 'rebuild';
  reason?: string | null;
  resumeStrategy?: 'resume' | 'restart';
  maxRoundsPerSource?: number;
  maxRuntimeMsPerSource?: number;
  maxTotalRuntimeMs?: number;
}
```

说明：

- `startMs` / `endMs` 是核心输入。
- `userId` 允许只为单个用户补齐，未传则默认全局。
- `sources` 允许只跑某些 source，默认是全部已接入 source。
- `mode = 'upsert'` 表示补齐缺失数据并幂等写入。
- `mode = 'rebuild'` 仅在明确需要重建某段窗口时使用，风险更高。
- `resumeStrategy` 控制是从已有检查点继续，还是重置本次 workflow 状态重新开始。
- 运行时预算用于防止单个 source 或整个 workflow 无限循环。

### 5.2 输出
建议统一输出：

```ts
export interface BackfillSourceRunResult {
  source: BackfillWorkflowSource;
  status: 'success' | 'partial' | 'failed';
  requestedStartMs: number;
  requestedEndMs: number;
  coveredStartMs: number | null;
  coveredEndMs: number | null;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  roundCount: number;
  complete: boolean;
  notes?: string[];
  error?: string | null;
}

export interface BackfillWorkflowResult {
  ok: boolean;
  status: 'success' | 'partial' | 'failed';
  runId: string;
  requestedStartMs: number;
  requestedEndMs: number;
  sourceResults: BackfillSourceRunResult[];
  coveredSources: BackfillWorkflowSource[];
  incompleteSources: BackfillWorkflowSource[];
  failedSources: BackfillWorkflowSource[];
  startedAtMs: number;
  finishedAtMs: number;
}
```

输出重点不是“返回多少条”，而是：

- 哪些 source 覆盖已经达标。
- 哪些 source 还没补齐。
- 哪些 source 直接失败。

## 6. Source Adapter 设计
### 6.1 统一接口
每个 source 都应接入统一 adapter 契约：

```ts
export interface BackfillSourceState {
  cursor?: string | null;
  coveredStartMs?: number | null;
  coveredEndMs?: number | null;
  rounds?: number;
  notes?: string[];
}

export interface BackfillSourceChunkResult {
  requestedStartMs: number;
  requestedEndMs: number;
  coveredStartMs: number | null;
  coveredEndMs: number | null;
  fetchedCount: number;
  storedCount: number;
  projectedCount: number;
  complete: boolean;
  nextState?: BackfillSourceState;
  notes?: string[];
}

export interface BackfillSourceAdapter {
  source: BackfillWorkflowSource;
  runChunk(input: BackfillWorkflowInput, state?: BackfillSourceState): Promise<BackfillSourceChunkResult>;
}
```

这里刻意使用 `runChunk`，而不是 `runAll`，因为不同 source 往往需要多轮分页才能真正补到目标起点。

### 6.2 Blockchain adapter
链上 source 的特点：

- 已有按 `[beginMs, endMs]` 构建 feed 的能力。
- 查询维度天然以时间窗为主。
- 单轮通常就能证明覆盖完成。

设计：

- 复用 `buildActivityFeed(users, { beginMs, endMs })`。
- 在 `upsert` 模式下继续复用现有 feed / asset / synced 标记写入流程。
- 若本轮请求就是 `[startMs, endMs]`，则 `coveredStartMs = startMs`、`coveredEndMs = endMs`。
- 若有部分地址失败，source 结果应为 `partial`，并附上失败地址统计。

### 6.3 Twitter adapter
Twitter source 的特点：

- 已有全局 / 单用户同步入口。
- 已有 `windowDays` 驱动的补拉能力。
- 完整性通常由 coverage watermark / cursor 决定，而不是单轮返回条数。

设计：

- 优先复用 `runTwitterSyncAction`。
- 需要从“天数窗口”过渡到“绝对时间窗”语义：
  - 内部可以继续把 `[startMs, endMs]` 转为 `windowDays` 或 `sinceMs`。
  - 但 adapter 的对外结果必须回到 `coveredStartMs` / `coveredEndMs`。
- 若当前 provider 只完成了部分覆盖，adapter 返回 `complete = false`，并把最新 coverage watermark 写入 `nextState`。

### 6.4 Telegram bridge adapter
Telegram bridge / monitor 的特点：

- 已有历史回灌入口，但当前是“抓最新 N 条”。
- 真正补齐到指定起点，需要按消息时间向历史翻页，而不是只限制条数。

设计：

- 扩展 `backfillTelegramBridgeHistory`，支持：
  - `startMs`
  - `endMs`
  - `offsetMessageId` 或同类分页检查点
- 每轮抓取后，取本轮最旧消息时间作为新的 `coveredStartMs` 候选。
- 当最旧消息时间已经早于 `startMs` 时，bridge source 才算补齐完成。
- 若某些消息无法解析，不应阻塞整体覆盖推进，但应记录 `ignoredCount` 和错误说明。

### 6.5 Telegram channel adapter
Telegram channel source 的特点：

- 当前增量同步是 `minMessageId` 向前推进，适合拉新。
- 历史补齐需要反向分页，直到消息时间穿过 `startMs`。
- 该 source 目前是“最缺一个真正按时间窗补齐能力”的部分。

设计：

- 扩展 `TelegramChannelSyncClient.listChannelMessages`，支持历史翻页参数，例如：
  - `maxMessageId`
  - `beforeMessageId`
  - 或等价的历史 offset 能力
- 新增 channel history backfill service，循环：
  1. 读取当前 source 的历史分页状态。
  2. 拉取更旧的一批消息。
  3. 原始帖幂等写入。
  4. 投影到 `events`。
  5. 更新 `coveredStartMs` 和分页检查点。
- 当本轮最旧帖子时间已经 `<= startMs` 时，该 channel source 才视为补齐完成。

## 7. 编排流程
### 7.1 Workflow 生命周期
统一状态建议为：

`pending -> running -> success | partial | failed`

其中：

- `success`：所有指定 source 覆盖都达标。
- `partial`：至少一个 source 已执行，但存在失败或覆盖不足。
- `failed`：workflow 级初始化失败，或没有任何 source 成功执行。

### 7.2 运行步骤
一次 workflow 的建议流程：

1. 校验输入时间窗。
2. 规范化 source 列表。
3. 创建 workflow run 记录。
4. 依次或受控并发执行 source adapter。
5. 每个 adapter 运行后立刻持久化 source state。
6. 若 source `complete = false` 且仍有剩余轮次预算，则继续下一轮。
7. 汇总所有 source 结果，得出最终 workflow 状态。

建议默认顺序：

1. `blockchain`
2. `twitter`
3. `telegram-bridge`
4. `telegram-channel`

理由：

- 链上与 Twitter 更接近现有主 feed 数据基础。
- Telegram 两条链路更容易受 MTProto 限流影响，排在后面更方便控制节奏。

## 8. 状态持久化与断点恢复
建议新增两类持久化对象：

1. `backfill_workflow_runs`
   - 存 workflow 级元信息。
2. `backfill_workflow_source_states`
   - 存每个 source 的检查点与覆盖进度。

示意字段：

- workflow：
  - `run_id`
  - `status`
  - `requested_start_ms`
  - `requested_end_ms`
  - `user_id`
  - `mode`
  - `sources_json`
  - `reason`
  - `started_at_ms`
  - `finished_at_ms`
  - `error`

- source state：
  - `run_id`
  - `source`
  - `status`
  - `cursor_json`
  - `covered_start_ms`
  - `covered_end_ms`
  - `round_count`
  - `fetched_count`
  - `stored_count`
  - `projected_count`
  - `error`
  - `updated_at_ms`

恢复策略：

- 若 workflow 中断，再次执行时可选择：
  - `resume`：从已有 source state 继续。
  - `restart`：清空本次 run state 后重新开始。
- 默认推荐 `resume`，避免 Telegram 历史分页重复扫太多数据。

## 9. 完备性判定策略
编排器不直接理解 provider 细节，只接受 adapter 给出的覆盖信息。

统一判定规则：

- 若 `coveredStartMs === null`，视为尚未建立覆盖证明。
- 若 `coveredStartMs > requestedStartMs`，说明还没补到目标起点。
- 若 `coveredEndMs < requestedEndMs`，说明上界也未补齐。
- 只有 `coveredStartMs <= requestedStartMs` 且 `coveredEndMs >= requestedEndMs` 时，source 才算 complete。

这样可以避免“只抓到一些数据就误判补齐完成”。

## 10. 错误处理与重试
### 10.1 Source 级错误
- 单个 source 失败，不应自动清空其他 source 已完成的成果。
- source 失败后应写入：
  - 错误消息
  - 失败轮次
  - 最近检查点

### 10.2 限流与退避
- Twitter provider 和 Telegram MTProto 都可能限流。
- adapter 应返回明确的 `notes` / `error`，由 workflow 统一决定是否：
  - 立即重试
  - 延迟后重试
  - 直接结束为 `partial`

### 10.3 重试边界
- workflow 应设置：
  - 每个 source 最大轮次
  - 每个 source 最大运行时长
  - 全局最大运行时长

避免因为某个 source 的历史过深而无限循环。

## 11. 管理入口
### 11.1 服务层
核心能力应先落在 server-only service 中，而不是先绑定到某个 route。

### 11.2 API 入口
建议新增管理接口，例如：

- `POST /api/backfill/workflow`

请求体示例：

```json
{
  "startMs": 1713139200000,
  "endMs": 1714348800000,
  "sources": ["blockchain", "twitter", "telegram-bridge", "telegram-channel"],
  "mode": "upsert",
  "reason": "manual-backfill-window"
}
```

要求：

- 必须走 `requireAdmin`
- 默认受 rate limit 保护
- 返回 workflow run 状态与每个 source 的结果摘要

### 11.3 CLI 入口
建议同时提供内部脚本，例如：

- `scripts/backfill-workflow.ts`

这样在需要本地运维、批量回补或 cron 触发时，不必依赖 HTTP。

## 12. 与现有 14 天回填入口的关系
现有 `14days` 入口不应继续扩张为更多特化逻辑。

迁移思路：

1. 保留现有入口一段时间，避免打断现有使用方式。
2. 内部把它改为调用新的通用 workflow：
   - `startMs = now - 14d`
   - `endMs = now`
   - `sources = all`
3. 等通用入口稳定后，再决定是否移除旧命名。

这样“14 天补齐”会变成一个参数化调用，而不是单独维护的第二套实现。

## 13. 测试策略
单元测试：

- 输入时间窗标准化与边界校验
- source complete 判定
- workflow 状态汇总
- source state 断点恢复逻辑

集成测试：

- blockchain adapter 在单窗口下直接完成覆盖
- twitter adapter 在 coverage 不足时返回 incomplete，再次运行后完成
- telegram bridge adapter 能向历史翻页直到穿过 `startMs`
- telegram channel adapter 能向历史翻页并持续写入 events

回归测试：

- 现有 feed 读取链路不受影响
- 默认 `7d` prewarm 行为不变
- 现有 Twitter / Telegram 增量同步链路不退化

## 14. 验收标准
- 传入任意合法 `[startMs, endMs]` 都能创建一次统一 workflow run。
- workflow 可以按 source 输出明确覆盖状态，而不只是成功 / 失败。
- `blockchain`、`twitter`、`telegram-bridge`、`telegram-channel` 都能接入同一编排层。
- Telegram 两条链路都支持按历史时间窗推进，而不是只抓最新固定条数。
- “近 14 天补齐所有源”可以通过该 workflow 参数化实现。
- 默认首页 `7d` prewarm 与手动 refresh 行为不发生变化。

## 15. 下一步实施计划范围
后续 implementation plan 应拆成以下独立工作流：

1. 抽取 workflow service 与运行状态仓储。
2. 实现 blockchain / twitter adapter。
3. 扩展 Telegram bridge 历史分页与 adapter。
4. 扩展 Telegram channel 历史分页与 adapter。
5. 新增管理 API / CLI 入口。
6. 将现有 `14days` 入口迁移为对通用 workflow 的一次封装调用。
