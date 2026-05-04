# Feed + Telegram 保守重构设计

日期：2026-05-04  
状态：草案（已在 brainstorming 过程中确认）  
负责人：Feed pipeline / Telegram monitor

## 1. 背景与问题
当前项目在 feed 与 Telegram monitor 相关路径上已经形成了可工作的功能闭环，但可读性和局部一致性正在变差，主要体现在：

- 客户端 feed 拉取链路过长，`hooks/useActivityPolling.ts` 同时承担请求编排、分页收集、本地用户同步、状态落地、错误恢复、调试暴露等职责。
- `lib/activitiesApi.ts` 与 `hooks/useActivityPolling.ts` 之间存在隐式契约，例如 feed payload 中 `users`、`nextCursor`、本地用户过滤等逻辑分散在多处。
- `lib/server/telegramMonitorFeed.ts` 同时承担用户匹配、event/tx-state 投影、fallback 持久化、评分、去重、Bid event 输出等多段逻辑，控制流冗长。
- 最近两次修复都暴露出同一个问题：行为并不一定错，但“数据流不显式”使得问题容易隐藏在客户端过滤、read-time self-heal、持久化补写之间。

这轮目标不是重做架构，而是在保持功能不变的前提下，让关键路径更容易读、测、改。

## 2. 目标与非目标
目标：
- 在不改变用户可见行为的前提下，缩短关键函数长度，提升职责清晰度。
- 把 feed 客户端链路中的“请求 → 归一化 → 用户同步 → feed 过滤 → state 落地”做成显式步骤。
- 把 Telegram feed 服务端链路中的“投影 → fallback 持久化 → 去重”做成显式步骤。
- 补足围绕新抽取 helper 的回归测试，确保重构不是“纯搬代码无验证”。
- 在新的 git worktree 中完成实现，避免污染当前工作区。

非目标：
- 不重写 feed 架构。
- 不调整页面功能、排序规则、筛选规则、对外接口含义。
- 不修改数据库 schema。
- 不顺手拆解所有超大文件。
- 不把 repo 层统一重构成新的基础设施抽象。

## 3. 已确认约束
- 重构力度选择为“保守”。
- 必须新建 git worktree 进行实现。
- 功能行为保持不变，以现有测试与 build 结果为基线。
- 允许少量新增 helper/module，但不做大面积公开接口迁移。

## 4. 方案对比
### 4.1 方案 A：文件内整理
- 仅在原文件内抽局部函数。
- 优点：最稳，变更面最小。
- 缺点：超大文件仍然超大，复用边界不明显。

### 4.2 方案 B：薄层分离（采用）
- 保留现有公开入口。
- 将纯计算、结果归并、投影步骤提炼为小 helper 或同目录小模块。
- 优点：风险低，可读性和测试性提升明显。
- 缺点：不能一次性解决所有架构债务。

### 4.3 方案 C：职责重组
- 对 client feed pipeline 与 telegram projector 做更大范围拆层。
- 优点：长期更整洁。
- 缺点：已超出本轮“保守重构”允许范围，验证成本过高。

## 5. 范围与切口
本轮只覆盖两条主线：

### 5.1 Client Feed Pipeline
目标文件：
- `hooks/useActivityPolling.ts`
- `lib/activitiesApi.ts`

关注点：
- `fetchActivities()` 的步骤化拆分
- `ActivityFeedResponse` 归一化职责收敛
- 服务端返回的 `users` 与本地 store 同步逻辑显式化
- feed 结果落地与状态写入逻辑收敛

### 5.2 Telegram Feed Projection
目标文件：
- `lib/server/telegramMonitorFeed.ts`
- 视需要触达 `lib/server/telegramMonitorActivity.ts`
- 视需要触达 `lib/server/eventsRepo.ts` 的 Telegram 相关 helper 调用点

关注点：
- `projectTelegramMonitorEvent()` / `projectTelegramMonitorTxState()` 公共步骤提取
- fallback event 评分与持久化流程提取
- dedupe key 生成逻辑提取
- 用户匹配与 tracked address 选择逻辑收敛

## 6. 目标结构
### 6.1 Client Feed Pipeline
保留现有 `useActivityPolling()` 与 `fetchAllActivities()` 作为对外入口，但内部拆为更清晰的步骤：

1. 请求参数解析
2. 分页收集
3. feed payload 归一化
4. 服务端用户结果并入本地用户视图
5. feed 合并与本地可见用户过滤
6. React state 落地
7. 调试/回灌/后续轮询逻辑

设计要求：
- 每一步尽量通过命名函数表达意图，而不是继续堆积在一个大 callback 中。
- 涉及纯输入输出的部分优先提成纯函数，便于脚本测试。
- 涉及 React state 的部分保留在 hook 内，避免过度抽象。

### 6.2 Telegram Feed Projection
保留以下公开函数签名不变：
- `projectTelegramMonitorEvent()`
- `projectTelegramMonitorTxState()`
- `readTelegramMonitorFeed()`
- `readBidOnchainEvents()`

内部重构方向：
- 将“根据用户和原始 event 解析投影 activity”的步骤抽成独立 helper。
- 将“fallback rows 打分并写回 projected activity”的步骤抽成独立 helper。
- 将“feed 去重键生成”和“按时间取新值”的逻辑抽成独立 helper。

设计要求：
- 不改变当前的投影结果字段。
- 不改变当前对 reconciled / failed / provisional tx-state 的显示策略。
- 不改变 fallback 持久化条件。

## 7. 一致性原则
### 7.1 数据流显式优先
本轮优先消除“函数 A 假设函数 B 已经做了某事，但没有显式命名”的代码结构。

### 7.2 公开接口稳定
除非测试证明必要，本轮不修改外部调用方式：
- 页面仍通过 `useActivityPolling()` 使用 feed。
- API 客户端仍通过 `fetchAllActivities()` 获取 feed。
- 服务端其余模块仍通过现有 Telegram feed 入口函数调用。

### 7.3 小步验证
每个抽取动作都应有直接验证：
- 新 helper 对应脚本测试，或
- 原有测试子集覆盖，或
- `npm run build` 类型检查兜底。

## 8. 测试策略
本轮至少执行下列验证：

必跑：
- `npm run test:activities-api`
- `npm run test:feed-client-state`
- `npm run test:feed-page-state`
- `npm run test:telegram-monitor-reconciliation`
- `npm run build`

按改动触发追加：
- 若触及 feed 搜索/筛选行为：`npm run test:search-filters`
- 若触及事件 upsert / feed 总量：`npm run test:events-feed-total`

测试原则：
- 先补或调整失败测试，再搬代码。
- 不允许把“只改结构”的说法当成跳过验证的理由。

## 9. Worktree 执行要求
实现前必须：

1. 检查 `.worktrees/` 是否已存在并被 git ignore。
2. 新建独立分支与 worktree，例如 `codex/feed-telegram-conservative-refactor`。
3. 在新 worktree 中安装依赖（若需要）并跑本轮基线测试。
4. 只有基线通过，才进入重构。

本 spec 编写阶段不要求先切 worktree；真正代码实施阶段必须切换到 worktree。

## 10. 验收标准
- 功能行为不变，至少现有相关测试子集与 `npm run build` 全部通过。
- `hooks/useActivityPolling.ts` 中主流程复杂度明显下降，关键步骤可一眼分辨。
- `lib/server/telegramMonitorFeed.ts` 中投影、fallback 持久化、去重三段职责边界更清晰。
- 最近两次修复涉及的隐式契约（如 feed payload users、本地用户过滤、Telegram self-heal 持久化）在代码结构上更显式。
- 新增 helper 的命名能直接反映步骤意图，而不是再次制造抽象噪音。

## 11. 实施计划边界
后续 implementation plan 应按以下顺序展开：

1. 建立 worktree 与基线验证。
2. Client feed pipeline 的保守拆分与测试。
3. Telegram feed projection 的保守拆分与测试。
4. 全量收尾验证与差异复核。

