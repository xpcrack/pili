# Sprint 1 执行状态快照 — 2026-07-13

> 计划：交易工具链开发计划 v1  
> 范围：阶段 0 + 阶段 1 + Sprint1 边界（不改 Workspace 数据、不新增交易功能）

## 三仓 HEAD（记录时）

| 仓库 | 分支 | HEAD |
|---|---|---|
| pilipili | main | `5e606c552814f59fd5ae12b966be1723e7f41e4b` |
| BID2 | main | `23bfae59101c8c1f2d9f6b1a2a32e745f34aed33` |
| BID2-xtracker-worker | feature/xtracker-worker-delivery-1 | `f0a34430d16ac0b5be6f817a58729328cb885fd7` |

## 阶段 0

| 项 | 状态 | 证据 |
|---|---|---|
| 基线 HEAD 可复查 | ✅ | 上表 |
| xtracker shadow 基线 | ✅ | `BID2-xtracker-worker/docs/SHADOW_BASELINE_PHASE1_2026-07-12.md` |
| FROZEN_COMPAT_ONLY 登记 | ✅ | `BID2/docs/FROZEN_COMPAT_ONLY.md` · `pilipili/docs/FROZEN_COMPAT_ONLY.md` |

## 阶段 1 — 已做

| 项 | 状态 | 证据 |
|---|---|---|
| pilipili Agent opportunities 410 | ✅ | `server/api.ts` / `app/api/agent/opportunities/route.ts` → 410 `AGENT_OPPORTUNITIES_DISABLED`；测试 `scripts/test-agent-opportunities-410.ts` |
| opportunitySelector 删除 | ✅（工作区） | git status: `D lib/server/opportunitySelector.ts` |
| BID2 KOL Analysis 入口 410 | ✅ | `backend/src/app.ts` 统一 410 `FEATURE_DISABLED` |
| BID2 Sherlock 入口 410 | ✅ | 同上 |
| BID2 WalletDiscovery 入口 410 | ✅ | 同上 |
| 前端无三产品导航 | ✅ | `frontend/src/App.tsx` 视图仅 token/address/api/xtracker |

## 阶段 1 — 明确未做（符合“先停入口再删”）

| 项 | 状态 |
|---|---|
| 删除 kolAnalysis/sherlock/walletDiscovery routes/controllers/services/models | ❌ 仍在磁盘 |
| 删除 frontend `kolAnalysisAPI` 客户端 | ❌ 仍有 @deprecated 包装 |
| 物理删除 opportunities 路由文件 | ❌ 保留 410 桩 |

## Sprint 1 退出条件对照

- 废弃功能用户不可见 / API 410：✅
- 冻结模块有清单：✅（本轮补齐）
- 不改 Workspace 数据：✅
- 不新增交易功能：✅

## 后续

- Sprint 2 已完成（SingleUser 四模型）
- 下一主线：阶段 3 Workspace 依赖图 → 地址迁移 → 持仓双写
- xtracker：VLESS race + 48–72h 长稳，独立轨并行
