# Feed Completeness Window And User Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在全局与单人视图里显示“完备时间窗”，并在单人视图里显示推特条数与交易条数。

**Architecture:** 由 `/api/feed` 统一返回当前视图对应的统计与完备窗。全局视图使用 `windowState.globalEarliestMs`，单人视图使用 `windowState.perUserEarliestMs[userId]`。前端只负责展示，不在客户端推导数据口径。

**Tech Stack:** Next.js App Router, TypeScript, better-sqlite3, tsx scripts

---

### Task 1: Feed API 补充统计与完备窗

**Files:**
- Modify: `app/api/feed/route.ts`
- Modify: `lib/server/eventsRepo.ts`
- Test: `scripts/test-events-feed-total.ts`

- [ ] **Step 1: 写失败测试**

在 `scripts/test-events-feed-total.ts` 里补充断言：
- `readLatestActivityAtByUser()` 返回全量用户最近活跃时间
- 后续 API 字段使用这个口径

- [ ] **Step 2: 运行测试确认失败**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/test-events-feed-total.ts`
Expected: FAIL

- [ ] **Step 3: 实现最小代码**

- `lib/server/eventsRepo.ts`
  - 新增 `readLatestActivityAtByUser()`
- `app/api/feed/route.ts`
  - 在 payload 中新增：
    - `completenessWindow`
    - `activityBreakdown`
  - 全局视图使用 `globalEarliestMs`
  - 单人视图使用 `perUserEarliestMs[userId]`
  - 单人视图下返回 twitter / blockchain 两类条数

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/test-events-feed-total.ts`
Expected: PASS

### Task 2: 页面展示完备窗与单人统计

**Files:**
- Modify: `lib/activitiesApi.ts`
- Modify: `hooks/useActivityPolling.ts`
- Modify: `app/page.tsx`
- Test: `npx tsc --noEmit --pretty false --incremental false`

- [ ] **Step 1: 先让类型报错**

给 `ActivityFeedResponse`、hook 返回值和页面消费处增加新字段引用，让 `tsc` 先失败。

- [ ] **Step 2: 运行类型检查确认失败**

Run: `npx tsc --noEmit --pretty false --incremental false`
Expected: FAIL

- [ ] **Step 3: 实现最小代码**

- `lib/activitiesApi.ts`
  - 解析 `completenessWindow` / `activityBreakdown`
- `hooks/useActivityPolling.ts`
  - 暴露给页面
- `app/page.tsx`
  - 全局视图显示“全局完备窗口”
  - 单人视图显示“个人完备窗口”
  - 单人视图显示“推特 X 条 / 交易 Y 条”

- [ ] **Step 4: 跑验证**

Run: `npx tsc --noEmit --pretty false --incremental false`
Expected: PASS

### Task 3: 全量回归

**Files:**
- Modify: `package.json`（如无需改则跳过）

- [ ] **Step 1: 运行关键脚本**

Run:
- `NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' npx tsx scripts/test-events-feed-total.ts`
- `npx tsc --noEmit --pretty false --incremental false`
- `npm run test`

Expected: PASS

## Spec Self-Review
- 完备窗口区分全局与单人，口径与用户刚确认的一致。
- 单人统计只展示推特和交易动态，不额外引入新维度。
- 展示逻辑放在页面，统计口径放在服务端，边界清晰。
