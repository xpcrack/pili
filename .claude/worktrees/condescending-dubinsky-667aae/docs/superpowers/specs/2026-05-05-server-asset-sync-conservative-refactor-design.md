# 服务端资产同步保守重构设计

日期：2026-05-05  
状态：草案（已在 brainstorming 过程中确认）  
负责人：Server asset sync / peak validation

## 1. 背景与问题
当前项目的服务端资产与同步链路已经具备完整功能，但代码边界开始变得模糊，主要体现在：

- [`/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`](/Users/xp/vibecoding/pilipili/lib/server/syncService.ts) 同时承担同步 run 编排、窗口状态计算、失败通知、feed 落库、资产快照写入、峰值校验衔接等多类职责。
- 资产相关逻辑分散在 [`/Users/xp/vibecoding/pilipili/lib/addressAssetSnapshots.ts`](/Users/xp/vibecoding/pilipili/lib/addressAssetSnapshots.ts)、[`/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts`](/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts)、[`/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`](/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts) 和 [`/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`](/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts) 中，流程相近但不完全收口。
- “异常资产”规则已经形成多个判断点，例如明细总额冲突、流动性比例、历史峰值异常，但规则与编排逻辑混在一起，后续继续调整时容易出现改一处漏一处。
- 脚本链路和正式同步链路的资产步骤虽然目标一致，但当前还是各自拼接流程，可维护性一般。

最近围绕 OKX 明细口径、异常峰值拦截、历史峰值修复的几次修正已经说明：功能闭环本身没有问题，但现在更需要的是让这条链路更容易读、测、改。

## 2. 目标与非目标
目标：

- 在不改变用户可见行为的前提下，压缩关键文件职责，提升可读性与一致性。
- 保持“资产来源、峰值判定、同步窗口策略”不变，只重构模块边界与流程组织方式。
- 让正式同步和补数脚本共用同一条资产流水线，减少重复编排。
- 将异常资产相关规则集中管理，降低后续维护成本。
- 用最小必要测试覆盖新增边界，确保这是有验证的重构而不是简单搬运代码。

非目标：

- 不改前端页面与交互。
- 不调整数据库 schema。
- 不改变 OKX / Dexscreener 的接口协议或返回口径。
- 不重写整个同步架构。
- 不顺手处理服务端其它无关模块的大文件问题。

## 3. 已确认约束
- 这轮工作选择“保守抽取型”重构，不做中度或重度架构改造。
- 资产口径保持为“OKX 明细接口求和”。
- 新高校验保持为“明细冲突拦截 + 流动性校验”。
- 历史峰值修复保持为“只修明显异常，没可靠旧记录时允许回落到当前可信资产”。
- 同步窗口策略保持不变，仍沿用现有 refresh / global backfill / user backfill 规则。

## 4. 方案对比
### 4.1 方案 A：最小清理
- 仅做命名、常量提取、局部函数抽取。
- 优点：风险最低。
- 缺点：`syncService.ts` 仍然过重，资产规则仍然分散，收益有限。

### 4.2 方案 B：保守抽取型（采用）
- 保留现有公开入口与行为。
- 抽出同步窗口状态、资产流水线、异常规则三个小模块。
- 优点：风险可控、收益明显，便于测试和后续继续维护。
- 缺点：不会一次性解决所有历史结构债务。

### 4.3 方案 C：中度架构型
- 进一步引入 coordinator/service 分层，重整同步与资产子系统接口。
- 优点：长期结构更整洁。
- 缺点：超出本轮“功能不变、风险可控”的范围。

## 5. 本轮范围与切口
本轮重构只覆盖“服务端资产/同步链路”，并明确聚焦以下四个文件簇：

### 5.1 同步编排层
- [`/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`](/Users/xp/vibecoding/pilipili/lib/server/syncService.ts)

### 5.2 资产采集层
- [`/Users/xp/vibecoding/pilipili/lib/addressAssetSnapshots.ts`](/Users/xp/vibecoding/pilipili/lib/addressAssetSnapshots.ts)

### 5.3 资产异常与峰值层
- [`/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts`](/Users/xp/vibecoding/pilipili/lib/server/assetPeakValidation.ts)
- [`/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`](/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts)

### 5.4 资产补数脚本层
- [`/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`](/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts)

## 6. 目标模块结构
### 6.1 `syncService.ts` 保留 orchestrator 角色
[`/Users/xp/vibecoding/pilipili/lib/server/syncService.ts`](/Users/xp/vibecoding/pilipili/lib/server/syncService.ts) 继续作为同步入口，但内部职责收窄为：

1. 创建与结束 sync run
2. 选择本轮 users / beginMs / endMs
3. 调用 feed 构建
4. 调用资产流水线
5. 写回窗口状态与 run 结果
6. 记录日志、失败状态与通知

它不再自己持有所有窗口状态细节和资产持久化细节。

### 6.2 新增 `syncWindowState.ts`
新增文件：
- [`/Users/xp/vibecoding/pilipili/lib/server/syncWindowState.ts`](/Users/xp/vibecoding/pilipili/lib/server/syncWindowState.ts)

职责：
- `normalizeSyncOptions`
- `createDefaultWindowState`
- `applyRefreshWindowState`
- `mergeRefreshWindowState`
- `applyGlobalBackfillWindowState`
- `applyUserBackfillWindowState`

要求：
- 只处理窗口状态与诊断结果的纯计算。
- 不触碰数据库和日志。
- 让调用方一眼看出“窗口怎么算”与“同步怎么执行”是两件事。

### 6.3 新增 `assetSyncPipeline.ts`
新增文件：
- [`/Users/xp/vibecoding/pilipili/lib/server/assetSyncPipeline.ts`](/Users/xp/vibecoding/pilipili/lib/server/assetSyncPipeline.ts)

职责：
- 接收一次 feed 构建结果中的 `addressAssets`、`userAssets`、`diagnostics`
- 统一做资产快照校验、持久化、审计信息整理、`markAddressesSynced`
- 返回结构化结果给 `syncService.ts` 和脚本层使用

目标是把目前散在 `syncService.ts` 和脚本中的资产步骤统一成固定顺序：

1. `validate`
2. `persist`
3. `mark synced`
4. `report`

### 6.4 新增 `assetAnomalyRules.ts`
新增文件：
- [`/Users/xp/vibecoding/pilipili/lib/server/assetAnomalyRules.ts`](/Users/xp/vibecoding/pilipili/lib/server/assetAnomalyRules.ts)

职责：
- 集中保存资产异常相关纯规则与阈值常量
- 为峰值校验与历史修复提供统一判断逻辑

本轮至少统一以下规则：
- `isDetailTotalMismatch`
- `isSuspiciousHistoricalPeak`
- `isCompleteAssetSnapshotForUser`

集中后的原则是：
- “是否异常”在规则文件判断
- “异常后怎么处理”留在各自服务中执行

## 7. 数据流设计
### 7.1 正式同步链路
本轮重构后，一次正式同步的资产路径应清晰表现为：

1. `buildActivityFeed()` 生成 `feed / diagnostics / addressAssets / userAssets`
2. `assetSyncPipeline` 接收资产相关结果
3. `assetPeakValidation` 对候选峰值做阻断判断
4. 允许写入的快照统一通过 `updateAssetSnapshots()` 落库
5. 成功同步的地址统一通过 `markAddressesSynced()` 标记
6. 将“哪些被拦截、哪些成功写入”以结构化结果返还上层

### 7.2 补数脚本链路
[`/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts`](/Users/xp/vibecoding/pilipili/scripts/backfill-14days-transactions.ts) 不再自己拼一遍资产写入步骤，而是复用 `assetSyncPipeline`。

这样保证：
- 脚本和正式同步使用同一套资产校验/落库口径
- 以后调整资产规则时，不需要在两处重复改动

### 7.3 历史峰值修复链路
[`/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts`](/Users/xp/vibecoding/pilipili/lib/server/historicalPeakRepair.ts) 继续保留“强制刷新当前可信资产 → 判断是否明显异常 → 必要时修正历史峰值”的逻辑。

本轮只做两件事：
- 使用统一异常规则模块
- 提升完整快照判断的可读性

不改变当前修复策略。

## 8. 一致性原则
### 8.1 公开入口保持稳定
本轮不改变以下入口语义：
- `triggerSync()`
- `getSyncStatus()`
- `collectAddressAssetSnapshots()`
- `validatePeakAssetSnapshots()`
- `validateAndPersistPeakAssetSnapshots()`
- `repairSuspiciousHistoricalPeaks()`

允许内部实现改为转调新 helper/module，但外部调用方式不变。

### 8.2 资产口径保持稳定
本轮明确保持以下行为不变：
- 地址资产继续来自 OKX 明细接口求和
- 人物新高仍然在写库前校验
- 明细合计与候选总额冲突时仍会拦截
- 流动性比例超限仍会拦截
- 历史峰值异常修复仍只针对明显离谱记录

### 8.3 脚本与正式链路尽量共用
凡是“正式同步”和“脚本补数”都需要做的资产步骤，本轮优先提炼为共享 helper，而不是继续复制流程。

## 9. 测试策略
本轮坚持 TDD，先补失败测试，再做实现。

必跑测试：
- `npm run test:address-assets`
- `npm run test:asset-peak-validation`
- `npm run test:asset-peak-audit`
- `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx --yes tsx scripts/test-historical-peak-repair.ts`

按重构面追加的测试建议：
- 为 `assetAnomalyRules.ts` 增加纯函数测试脚本
- 为 `assetSyncPipeline.ts` 增加最小行为测试，验证：
  - 被拦截用户不会写入
  - 成功地址会被标记 synced
  - 脚本链路与正式链路返回一致结构

若本轮触及 `syncService.ts` 的公共行为，还应追加：
- `npm run test:sync-failure-notifier`
- 必要时执行 `npm run build`

测试原则：
- 不允许以“只是重构”为由跳过红绿灯流程
- 不允许让脚本链路和正式链路在资产行为上继续漂移

## 10. 验收标准
- `syncService.ts` 的主流程更短，更像 orchestrator，而不是混合所有实现细节的大文件。
- 同步窗口状态逻辑被抽离后，调用方可以显式看出“窗口决策”和“run 执行”的边界。
- 资产写入、峰值校验、地址 synced 标记形成统一资产流水线，脚本与正式同步共用。
- 资产异常规则集中在单一模块中，阈值与判断口径不再散落在多个文件里。
- 相关测试子集通过，功能行为不变。

## 11. 实施计划边界
后续 implementation plan 应按以下顺序展开：

1. 为规则层和流水线层补失败测试。
2. 新增 `assetAnomalyRules.ts` 并迁移纯规则。
3. 新增 `assetSyncPipeline.ts` 并让脚本与正式同步复用。
4. 新增 `syncWindowState.ts` 并精简 `syncService.ts`。
5. 跑测试子集与必要的 build 验证。

本轮 spec 只覆盖“服务端资产/同步链路的保守重构”，不延伸到前端状态层或其它服务端子系统。
