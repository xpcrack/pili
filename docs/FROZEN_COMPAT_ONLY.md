# FROZEN_COMPAT_ONLY — 冻结兼容模块清单（pilipili）

> 状态：`FROZEN_COMPAT_ONLY`  
> 登记日期：2026-07-13  
> 依据：交易工具链开发计划 v1 · 阶段 0.2  
> 规则优先级：高于日常功能迭代

## 允许修改

1. **编译修复**
2. **数据迁移兼容**（SQLite schema additive、读路径兼容）
3. **安全/崩溃级热修**（不改变评分语义与对外行为）

## 禁止修改

- 扩展 importance 评分维度、权重、新策略
- 新增 Agent opportunities 类能力（该 API 已永久 410）
- 把 importance 做成新业务产品入口
- 删除本清单文件（须评审）

---

## A. importance 评分（冻结保留现状）

| 路径 | 角色 |
|---|---|
| `lib/server/activityImportanceService.ts` | 评分核心 |
| `lib/server/activityImportanceBackfill.ts` | 回填逻辑 |
| `scripts/backfill-importance-score.ts` | 回填 CLI |
| `scripts/test-activity-importance*.ts` | 既有测试（可修断言适配，不可改产品语义） |
| `scripts/test-activity-importance-service.ts` | 服务测试 |
| `scripts/test-activity-importance-ingest.ts` | 入库测试 |
| `scripts/test-activity-importance-backfill.ts` | 回填测试 |

调用方（**只读消费**，改调用方可以，但不得倒逼扩展评分服务）：

- `lib/server/eventsRepo.ts`
- `lib/server/feedSnapshotRepo.ts`
- `lib/server/twitterFeedMapper.ts`
- `lib/server/telegramMonitorFeed.ts`
- `lib/server/telegramMonitorIngest.ts`
- `lib/server/telegramMonitorActivity.ts`
- 相关 telegram monitor 路径（监控链路可修，不得借机改 importance 语义）

## B. 已停用 API

| 路径 | 状态 |
|---|---|
| `server/api.ts` → `GET /api/agent/opportunities` | **410** `AGENT_OPPORTUNITIES_DISABLED` |
| `app/api/agent/opportunities/route.ts` | **410** 同语义 |
| `lib/server/opportunitySelector.ts` | 已删除（工作区 D） |
| `scripts/test-agent-opportunities-410.ts` | 410 回归测试（保留） |

禁止恢复 opportunities 业务实现。

## C. 变更门禁

```
FROZEN_COMPAT_ONLY: yes
reason: compile-fix | migration-compat | security-hotfix
behavior_change: none
```
