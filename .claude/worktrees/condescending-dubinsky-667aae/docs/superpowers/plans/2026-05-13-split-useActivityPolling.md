# useActivityPolling 拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `hooks/useActivityPolling.ts` 从 913 行减到 ~250 行；将每个独立副作用抽到单独的 focused hook，提高可读性和可调试性。**外部 API 100% 不变**（page.tsx 不动）。

**Architecture:** Orchestrator 模式。主 hook 仅保留 state、refs、`fetchActivities` 主流程；将 7 个独立副作用（debug bridge、refs sync、prewarm trigger、SSE judgment stream、snapshot polling、refresh scheduler、server backfill）各自抽到 `hooks/useFeed*.ts`。每个新 hook 是原代码的**纯搬运**（不改逻辑、不变接口），确保等价改造。

**Tech Stack:** Next.js 16.2.3, React 19.2.4, TypeScript 5, Zustand。测试：`tsx scripts/lib/runTests.ts` 跑 `scripts/test-*.ts`（项目无 jsdom/RTL，hook 整体只能手测）。

---

## Scope Check

本 plan 单一职责：拆 `useActivityPolling.ts`。不动其他文件（page.tsx 不变；lib/feed/* 不变；其他 hook 不变）。每个 task 抽出一个独立 hook，独立 commit，独立验证。

### 有意识的范围限制（不在本 plan 内）

体检报告 (`docs/superpowers/specs/2026-05-13-codebase-health-audit.md`) 曾建议拆成 4 个 hook，其中包含 `useFeedFetcher`（把 fetchActivities 主体抽出）。**本 plan 不做这一步**，原因：

1. `fetchActivities` 是 352 行的核心闭包，依赖 ≥10 个 setState/refs/store callback，单独抽出风险极高（容易引入 stale closure bug，正是今天那个"已检查 0 人"问题的同类型陷阱）。
2. 本 plan 优先抽**周边独立副作用**（7 个 hook），完成后主 hook 已从 913 行降到 ~250-350 行，可读性大幅改善，**fetchActivities 的边界自然显形**。
3. 抽 fetchActivities 应作为**后续独立 plan**（Plan A.2），届时再单独评估、单独测试。

如果执行本 plan 期间发现 fetchActivities 内某段逻辑可以无风险纯函数化（如失败回滚的 setState 序列），允许在不改语义的前提下抽到 `lib/feed/` 下并加 unit test，但**不是必需**。

## File Structure

### 新建文件（7 个 hook）
- `hooks/useFeedDebugBridge.ts` — 挂载/卸载 `window.__feedDebug`，依赖 feedRef
- `hooks/useActiveContextRefs.ts` — 把 4 个 props 同步到 4 个 refs
- `hooks/useFeedPrewarmTrigger.ts` — 1500ms 延迟调 `/api/feed/prewarm` 设置 label
- `hooks/useFeedJudgmentStream.ts` — SSE `/api/debug/tx-judgment/stream`，事件触发 fetch
- `hooks/useFeedSnapshotPolling.ts` — 5s 间隔调 fetchActivities (local)
- `hooks/useFeedRefreshScheduler.ts` — 1h 间隔调 fetchActivities (refresh)
- `hooks/useFeedServerBackfill.ts` — backfillLocalUsersToServer 函数包装

### 修改文件
- `hooks/useActivityPolling.ts` — 删除被抽走的代码段，import 并调用新 hook

### 不动文件
- `app/page.tsx` — 外部接口不变
- `lib/feed/*` — 依赖模块全部不动
- `lib/activitiesApi.ts` — 不动
- `store/*` — 不动

---

## Pre-flight

- [ ] **Pre-flight 1: 工作区干净**

   先确认或处理已有未提交改动（git status 显示 `M app/page.tsx` `M components/SelectedUserDetailsPanel.tsx` `M lib/server/syncService.ts` 等）。建议：要么先在主分支提交/暂存，要么用 `git worktree add` 在独立 worktree 进行本 plan。

   Run: `git status --short`

   预期：要么无 `app/page.tsx` 类改动，要么你已经主动用 worktree 隔离了。如果还有未提交改动，**停下来让用户决定怎么处理**，不要硬上。

- [ ] **Pre-flight 2: 基线 build 通过**

   Run: `npx tsc --noEmit`

   预期：无错误（如果当前已有 ts 错误，先记录基线，后续每个 task 的 build 检查只对比是否引入新错）。

   Run: `npm run lint`

   预期：无错误或仅有原有 warning（同上，记录基线）。

- [ ] **Pre-flight 3: 浏览器基线截图**

   打开 http://localhost:3001/ ，手动确认：
   - "已检查 X 人 / X 个地址 / X 条动态" 的数字
   - "近 7 天已补齐" 的 label
   - 切换"最近活跃 / 最高资产" 行为
   - 切换某个用户进入详情面板的行为
   - 浏览器 DevTools Network → 有定期的 `GET /api/feed?...` 请求

   把这些当作每个 task 完成后的对照基线（任何一项变化都视为 regression）。

---

## Task 1: Extract `useFeedDebugBridge`

**Files:**
- Create: `hooks/useFeedDebugBridge.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 242-273 行的 `useEffect`，import 新 hook 并调用）

**职责：** 挂载 `window.__feedDebug.findTx`，组件卸载时清除。

- [ ] **Step 1: 创建 `hooks/useFeedDebugBridge.ts`**

```typescript
'use client';

import { useEffect, type MutableRefObject } from 'react';
import { User, Activity } from '@/types';
import {
  buildFeedDebugEntries,
  filterPoisonFromFeed,
  type FeedDebugEntry,
} from '@/lib/feed/feedPoisonFilter';

type FeedItem = { user: User; activity: Activity };

export function useFeedDebugBridge(feedRef: MutableRefObject<FeedItem[]>) {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const target = window as Window & {
      __feedDebug?: {
        findTx: (txHash: string) => {
          raw: FeedDebugEntry[];
          visibleAfterFilter: boolean;
          filtered: FeedDebugEntry[];
        };
      };
    };

    target.__feedDebug = {
      findTx: (txHash: string) => {
        const rawEntries = buildFeedDebugEntries(feedRef.current, txHash);
        const filteredFeed = filterPoisonFromFeed(feedRef.current);
        const filteredEntries = buildFeedDebugEntries(filteredFeed, txHash);
        return {
          raw: rawEntries,
          visibleAfterFilter: filteredEntries.length > 0,
          filtered: filteredEntries,
        };
      },
    };

    return () => {
      delete target.__feedDebug;
    };
  }, [feedRef]);
}
```

- [ ] **Step 2: 在 `useActivityPolling.ts` 顶部 import 新 hook**

   找到（约 36-37 行）：
   ```
   import { useUserStore } from '@/store/userStore';
   import { useUsersDataStore } from '@/store/usersDataStore';
   ```

   在其下方加一行：
   ```typescript
   import { useFeedDebugBridge } from './useFeedDebugBridge';
   ```

- [ ] **Step 3: 删除原 useEffect 代码块，替换为新 hook 调用**

   定位 `useActivityPolling.ts` 中 `useEffect(() => {\n    if (typeof window === 'undefined') {` 这个块（在 `applyNewStatusForActivities` 上方），整个 useEffect 大约 30 行。

   将整个 useEffect 块（从 `useEffect(() => {` 到 `}, []);`）替换为：
   ```typescript
   useFeedDebugBridge(feedRef);
   ```

   同时删除该 useEffect 内部对 `buildFeedDebugEntries`、`filterPoisonFromFeed`、`FeedDebugEntry` 的依赖 — 这些已经搬到新 hook。

- [ ] **Step 4: 移除原文件中只在被抽走代码中用到的 import**

   检查 `useActivityPolling.ts` 是否还有用到 `buildFeedDebugEntries` 和 `FeedDebugEntry`。注意 `filterPoisonFromFeed` 在 `fetchActivities` 内还用着（行 557 附近），**不能删**。

   只删除 `buildFeedDebugEntries` 和 `FeedDebugEntry` 这两个名字（如果已无引用）。修改 import 语句：
   ```typescript
   import {
     filterPoisonFromFeed,
   } from '@/lib/feed/feedPoisonFilter';
   ```

- [ ] **Step 5: 验证编译**

   Run: `npx tsc --noEmit`

   预期：无新错误。

   Run: `npm run lint`

   预期：无新错误。

- [ ] **Step 6: 手动浏览器验证**

   打开 http://localhost:3001/，刷新一次。在 DevTools Console 输入：
   ```
   window.__feedDebug
   ```

   预期：返回对象 `{ findTx: ƒ }`。

   切换到任意其他页面再回来，再次输入：
   ```
   window.__feedDebug
   ```

   预期：仍然存在（hook 重新挂载）。

- [ ] **Step 7: Commit**

```bash
git add hooks/useFeedDebugBridge.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedDebugBridge"
```

---

## Task 2: Extract `useActiveContextRefs`

**Files:**
- Create: `hooks/useActiveContextRefs.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 222-240 行的 5 个 useEffect，引入 4 个 ref 通过新 hook 获得）

**职责：** 把 props 同步到 refs，方便闭包内总能拿到最新值。原代码有 5 个 useEffect 做 ref 同步（users 一个 + 4 个 active*）；本任务只搬"4 个 active* refs"，`usersRef` 的同步保持在主 hook 内（因为 users 来自 store，不是 prop）。

- [ ] **Step 1: 创建 `hooks/useActiveContextRefs.ts`**

```typescript
'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';
import { Activity } from '@/types';
import { type FeedSearchFilters } from '@/lib/smartSearch';

interface ActiveContextRefs {
  selectedUserIdRef: MutableRefObject<string | null>;
  searchQueryRef: MutableRefObject<string>;
  sourceRef: MutableRefObject<Activity['source'] | null>;
  searchFiltersRef: MutableRefObject<FeedSearchFilters | undefined>;
}

export function useActiveContextRefs(params: {
  selectedUserId: string | null | undefined;
  searchQuery: string | undefined;
  source: Activity['source'] | null | undefined;
  searchFilters: FeedSearchFilters | undefined;
}): ActiveContextRefs {
  const selectedUserIdRef = useRef<string | null>(params.selectedUserId ?? null);
  const searchQueryRef = useRef<string>((params.searchQuery || '').trim());
  const sourceRef = useRef<Activity['source'] | null>(params.source ?? null);
  const searchFiltersRef = useRef<FeedSearchFilters | undefined>(params.searchFilters);

  useEffect(() => {
    selectedUserIdRef.current = params.selectedUserId ?? null;
  }, [params.selectedUserId]);

  useEffect(() => {
    searchQueryRef.current = (params.searchQuery || '').trim();
  }, [params.searchQuery]);

  useEffect(() => {
    sourceRef.current = params.source ?? null;
  }, [params.source]);

  useEffect(() => {
    searchFiltersRef.current = params.searchFilters;
  }, [params.searchFilters]);

  return {
    selectedUserIdRef,
    searchQueryRef,
    sourceRef,
    searchFiltersRef,
  };
}
```

- [ ] **Step 2: 在 `useActivityPolling.ts` 顶部 import 新 hook**

   找到（在 Task 1 添加的 useFeedDebugBridge import 下方）：
   ```typescript
   import { useFeedDebugBridge } from './useFeedDebugBridge';
   ```

   加一行：
   ```typescript
   import { useActiveContextRefs } from './useActiveContextRefs';
   ```

- [ ] **Step 3: 删除原 4 个 useRef 声明 + 4 个 useEffect，替换为新 hook 调用**

   找到这 4 个 useRef 声明（约 202-205 行）：
   ```typescript
   const activeSelectedUserIdRef = useRef<string | null>(activeSelectedUserId ?? null);
   const activeSearchQueryRef = useRef((activeSearchQuery || '').trim());
   const activeSourceRef = useRef<Activity['source'] | null>(activeSource ?? null);
   const activeSearchFiltersRef = useRef<FeedSearchFilters | undefined>(activeSearchFilters);
   ```

   将这 4 行替换为：
   ```typescript
   const {
     selectedUserIdRef: activeSelectedUserIdRef,
     searchQueryRef: activeSearchQueryRef,
     sourceRef: activeSourceRef,
     searchFiltersRef: activeSearchFiltersRef,
   } = useActiveContextRefs({
     selectedUserId: activeSelectedUserId,
     searchQuery: activeSearchQuery,
     source: activeSource,
     searchFilters: activeSearchFilters,
   });
   ```

   找到对应的 4 个 useEffect（约 226-240 行）：
   ```typescript
   useEffect(() => {
     activeSelectedUserIdRef.current = activeSelectedUserId ?? null;
   }, [activeSelectedUserId]);

   useEffect(() => {
     activeSearchQueryRef.current = (activeSearchQuery || '').trim();
   }, [activeSearchQuery]);

   useEffect(() => {
     activeSourceRef.current = activeSource ?? null;
   }, [activeSource]);

   useEffect(() => {
     activeSearchFiltersRef.current = activeSearchFilters;
   }, [activeSearchFilters]);
   ```

   全部删除这 4 个 useEffect 块。

- [ ] **Step 4: 验证编译**

   Run: `npx tsc --noEmit`
   预期：无新错误。

   Run: `npm run lint`
   预期：无新错误。

- [ ] **Step 5: 手动浏览器验证**

   打开 http://localhost:3001/ ，
   - 切换"最近活跃 / 最高资产" → 列表正常重排
   - 选择一个用户 → 进入详情面板正常
   - 返回 → 列表正常恢复
   - 搜索框输入字符 → debounce 后能正常筛选

   预期：所有交互与基线一致。

- [ ] **Step 6: Commit**

```bash
git add hooks/useActiveContextRefs.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useActiveContextRefs"
```

---

## Task 3: Extract `useFeedPrewarmTrigger`

**Files:**
- Create: `hooks/useFeedPrewarmTrigger.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 817-832 行的 prewarm useEffect）

**职责：** 组件挂载 1500ms 后调用 `POST /api/feed/prewarm`，把返回的 `prewarm.label` 通过回调传给上层 state。

- [ ] **Step 1: 创建 `hooks/useFeedPrewarmTrigger.ts`**

```typescript
'use client';

import { useEffect } from 'react';

const PREWARM_DELAY_MS = 1500;

export function useFeedPrewarmTrigger(onLabel: (label: string) => void) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/feed/prewarm', { method: 'POST', cache: 'no-store' })
        .then((response) => response.json())
        .then((payload) => {
          if (
            payload?.ok &&
            typeof payload?.prewarm?.label === 'string' &&
            payload.prewarm.label.trim()
          ) {
            onLabel(payload.prewarm.label as string);
          }
        })
        .catch(() => undefined);
    }, PREWARM_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [onLabel]);
}
```

- [ ] **Step 2: 在主 hook import**

```typescript
import { useFeedPrewarmTrigger } from './useFeedPrewarmTrigger';
```

- [ ] **Step 3: 替换主 hook 中的 prewarm useEffect**

   找到（约 817-832 行）：
   ```typescript
   useEffect(() => {
     const timer = window.setTimeout(() => {
       void fetch('/api/feed/prewarm', { method: 'POST', cache: 'no-store' })
         .then((response) => response.json())
         .then((payload) => {
           if (payload?.ok && typeof payload?.prewarm?.label === 'string' && payload.prewarm.label.trim()) {
             setPrewarmLabel(payload.prewarm.label as string);
           }
         })
         .catch(() => undefined);
     }, 1500);

     return () => {
       window.clearTimeout(timer);
     };
   }, []);
   ```

   替换为：
   ```typescript
   useFeedPrewarmTrigger(setPrewarmLabel);
   ```

- [ ] **Step 4: 验证编译**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 5: 手动浏览器验证**

   打开 http://localhost:3001/ ，DevTools → Network 面板，过滤 `prewarm`。
   - 应该看到一个 `POST /api/feed/prewarm` 请求（页面加载 ~1.5s 后）
   - 页面上"近 7 天已补齐 / 更新于 XX:XX"的 label 显示正常

- [ ] **Step 6: Commit**

```bash
git add hooks/useFeedPrewarmTrigger.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedPrewarmTrigger"
```

---

## Task 4: Extract `useFeedJudgmentStream`

**Files:**
- Create: `hooks/useFeedJudgmentStream.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 834-886 行的 SSE useEffect 块、`judgmentStreamRef`、`judgmentVersionRef`、`sseRefetchingRef`）

**职责：** 连接 SSE `/api/debug/tx-judgment/stream`；收到 `updated` 事件且 version 改变时调用 `onUpdate` 回调（即触发 fetchActivities）。

- [ ] **Step 1: 创建 `hooks/useFeedJudgmentStream.ts`**

```typescript
'use client';

import { useEffect, useRef } from 'react';

const STREAM_ENDPOINT = '/api/debug/tx-judgment/stream';

export function useFeedJudgmentStream(onUpdate: () => Promise<unknown> | void) {
  const versionRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const stream = new EventSource(STREAM_ENDPOINT);
    streamRef.current = stream;

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; version?: number };
        if (!payload || typeof payload.version !== 'number') {
          return;
        }
        if (payload.type === 'hello') {
          versionRef.current = payload.version;
          return;
        }
        if (payload.type !== 'updated') {
          return;
        }
        if (payload.version === versionRef.current) {
          return;
        }
        versionRef.current = payload.version;
        if (inFlightRef.current) {
          return;
        }
        inFlightRef.current = true;
        const result = onUpdate();
        if (result && typeof (result as Promise<unknown>).finally === 'function') {
          (result as Promise<unknown>).finally(() => {
            inFlightRef.current = false;
          });
        } else {
          inFlightRef.current = false;
        }
      } catch {
        // ignore malformed events
      }
    };

    stream.onerror = () => {
      // browser EventSource auto-reconnects
    };

    return () => {
      stream.close();
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
    };
  }, [onUpdate]);
}
```

- [ ] **Step 2: 在主 hook import**

```typescript
import { useFeedJudgmentStream } from './useFeedJudgmentStream';
```

- [ ] **Step 3: 删除主 hook 内 SSE 相关 useEffect + 3 个 refs**

   删除以下 3 个 useRef 声明（约 189-191 行）：
   ```typescript
   const judgmentStreamRef = useRef<EventSource | null>(null);
   const judgmentVersionRef = useRef<number>(0);
   const sseRefetchingRef = useRef(false);
   ```

   删除整个 SSE useEffect 块（约 834-886 行，从 `useEffect(() => {\n    if (typeof window === 'undefined') {\n      return;\n    }\n\n    const stream = new EventSource` 开始，到 `}, [fetchActivities]);` 结束）。

- [ ] **Step 4: 替换为新 hook 调用**

   在原 SSE useEffect 删除位置（通常是 `return {` 输出对象之前），插入：
   ```typescript
   useFeedJudgmentStream(() =>
     fetchActivities({
       selectedUserId: activeSelectedUserIdRef.current,
       searchQuery: activeSearchQueryRef.current,
       source: activeSourceRef.current,
       syncStrategy: 'local',
     })
   );
   ```

- [ ] **Step 5: 验证编译**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 6: 手动浏览器验证**

   打开 http://localhost:3001/ ，DevTools → Network 面板，过滤 `tx-judgment/stream`。
   - 应该看到一个 EventStream 类型的长连接（状态 `pending`）
   - 在 Console 输入 `EventSource.prototype` 确认连接存在
   - 等 ~5 分钟（或手工触发后端写一条 judgment）后，列表应该自动刷新一次

   ⚠️ **回归测试重点**：今天那个"已检查 0 人"问题可能与此 SSE 有关。务必确认页面 summary 数字正常。

- [ ] **Step 7: Commit**

```bash
git add hooks/useFeedJudgmentStream.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedJudgmentStream"
```

---

## Task 5: Extract `useFeedSnapshotPolling`

**Files:**
- Create: `hooks/useFeedSnapshotPolling.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 782-797 行的 polling useEffect + `snapshotPollIntervalRef`）

**职责：** 每 5 秒触发一次本地快照读取（`syncStrategy: 'local'`）。

- [ ] **Step 1: 创建 `hooks/useFeedSnapshotPolling.ts`**

```typescript
'use client';

import { useEffect } from 'react';

const SNAPSHOT_POLL_INTERVAL_MS = 5 * 1000;

export function useFeedSnapshotPolling(tick: () => Promise<unknown> | void) {
  useEffect(() => {
    const id = setInterval(() => {
      void tick();
    }, SNAPSHOT_POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, [tick]);
}
```

- [ ] **Step 2: 在主 hook import**

```typescript
import { useFeedSnapshotPolling } from './useFeedSnapshotPolling';
```

- [ ] **Step 3: 删除原 polling useEffect + ref**

   删除 ref 声明（约 188 行）：
   ```typescript
   const snapshotPollIntervalRef = useRef<NodeJS.Timeout | null>(null);
   ```

   删除整个 polling useEffect（约 782-797 行）：
   ```typescript
   useEffect(() => {
     snapshotPollIntervalRef.current = setInterval(() => {
       void fetchActivities({
         syncStrategy: 'local',
         selectedUserId: activeSelectedUserIdRef.current,
         searchQuery: activeSearchQueryRef.current,
         source: activeSourceRef.current,
       });
     }, SNAPSHOT_POLL_INTERVAL);

     return () => {
       if (snapshotPollIntervalRef.current) {
         clearInterval(snapshotPollIntervalRef.current);
       }
     };
   }, [fetchActivities]);
   ```

   删除原常量定义（约 40 行）：
   ```typescript
   const SNAPSHOT_POLL_INTERVAL = 5 * 1000; // 每5秒读取一次本地快照，及时拿到后台刷新结果
   ```

- [ ] **Step 4: 替换为新 hook 调用**

   在原 useEffect 位置插入：
   ```typescript
   useFeedSnapshotPolling(() =>
     fetchActivities({
       syncStrategy: 'local',
       selectedUserId: activeSelectedUserIdRef.current,
       searchQuery: activeSearchQueryRef.current,
       source: activeSourceRef.current,
     })
   );
   ```

- [ ] **Step 5: 验证编译**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 6: 手动浏览器验证**

   打开 http://localhost:3001/，DevTools → Network 面板。
   预期：每 5 秒应该看到一次 `GET /api/feed?...` 请求（syncStrategy=local）。

- [ ] **Step 7: Commit**

```bash
git add hooks/useFeedSnapshotPolling.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedSnapshotPolling"
```

---

## Task 6: Extract `useFeedRefreshScheduler`

**Files:**
- Create: `hooks/useFeedRefreshScheduler.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 800-815 行的 refresh useEffect + `refreshIntervalRef`）

**职责：** 每 1 小时触发一次后台刷新（`syncStrategy: 'refresh'`）。

- [ ] **Step 1: 创建 `hooks/useFeedRefreshScheduler.ts`**

```typescript
'use client';

import { useEffect } from 'react';

const REFRESH_TRIGGER_INTERVAL_MS = 60 * 60 * 1000;

export function useFeedRefreshScheduler(tick: () => Promise<unknown> | void) {
  useEffect(() => {
    const id = setInterval(() => {
      void tick();
    }, REFRESH_TRIGGER_INTERVAL_MS);

    return () => {
      clearInterval(id);
    };
  }, [tick]);
}
```

- [ ] **Step 2: 在主 hook import**

```typescript
import { useFeedRefreshScheduler } from './useFeedRefreshScheduler';
```

- [ ] **Step 3: 删除原 refresh useEffect + ref + 常量**

   删除 ref 声明（约 187 行）：
   ```typescript
   const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
   ```

   删除整个 refresh useEffect（约 800-815 行）：
   ```typescript
   useEffect(() => {
     refreshIntervalRef.current = setInterval(() => {
       void fetchActivities({
         syncStrategy: 'refresh',
         selectedUserId: activeSelectedUserIdRef.current,
         searchQuery: activeSearchQueryRef.current,
         source: activeSourceRef.current,
       });
     }, REFRESH_TRIGGER_INTERVAL);

     return () => {
       if (refreshIntervalRef.current) {
         clearInterval(refreshIntervalRef.current);
       }
     };
   }, [fetchActivities]);
   ```

   删除原常量（约 39 行）：
   ```typescript
   const REFRESH_TRIGGER_INTERVAL = 60 * 60 * 1000; // 1小时触发一次后台刷新
   ```

- [ ] **Step 4: 替换为新 hook 调用**

   ```typescript
   useFeedRefreshScheduler(() =>
     fetchActivities({
       syncStrategy: 'refresh',
       selectedUserId: activeSelectedUserIdRef.current,
       searchQuery: activeSearchQueryRef.current,
       source: activeSourceRef.current,
     })
   );
   ```

- [ ] **Step 5: 验证编译**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 6: 手动浏览器验证**

   1 小时间隔无法在短时手测验证 → 临时把 `REFRESH_TRIGGER_INTERVAL_MS` 改成 `10000`（10 秒），观察是否有 `syncStrategy=refresh` 的请求，验证后**改回来**。

- [ ] **Step 7: Commit**

```bash
git add hooks/useFeedRefreshScheduler.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedRefreshScheduler"
```

---

## Task 7: Extract `useFeedServerBackfill`

**Files:**
- Create: `hooks/useFeedServerBackfill.ts`
- Modify: `hooks/useActivityPolling.ts`（删除 286-361 行的 `backfillLocalUsersToServer` useCallback + `serverBackfillInFlightRef`、`serverBackfillAttemptedRef` 两个 refs）

**职责：** 提供 `backfillLocalUsersToServer(users, signal)` 函数，调用 `POST /api/users/import` 带 10s 超时。状态由 hook 内部 ref 管理。

- [ ] **Step 1: 创建 `hooks/useFeedServerBackfill.ts`**

```typescript
'use client';

import { useCallback, useRef } from 'react';
import { User } from '@/types';

const SERVER_BACKFILL_ENDPOINT = '/api/users/import';
const SERVER_BACKFILL_TIMEOUT_MS = 10000;

export function useFeedServerBackfill() {
  const inFlightRef = useRef(false);
  const attemptedRef = useRef(false);

  const backfill = useCallback(
    async (localUsers: User[], signal?: AbortSignal): Promise<boolean> => {
      if (inFlightRef.current) {
        return false;
      }

      const usersWithAddresses = localUsers.filter((user) => user.addresses.length > 0);
      if (usersWithAddresses.length === 0) {
        return false;
      }

      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      inFlightRef.current = true;
      const controller = new AbortController();
      let abortedByExternalSignal = false;
      let detachExternalAbortListener: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          abortedByExternalSignal = true;
          controller.abort();
        } else {
          const handleExternalAbort = () => {
            abortedByExternalSignal = true;
            controller.abort();
          };
          signal.addEventListener('abort', handleExternalAbort, { once: true });
          detachExternalAbortListener = () => {
            signal.removeEventListener('abort', handleExternalAbort);
          };
        }
      }
      const timer = setTimeout(() => {
        controller.abort();
      }, SERVER_BACKFILL_TIMEOUT_MS);

      try {
        let response: Response;
        try {
          response = await fetch(SERVER_BACKFILL_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              users: usersWithAddresses,
              replaceExisting: false,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            if (abortedByExternalSignal) {
              throw error;
            }
            throw new Error(`回灌超时（>${SERVER_BACKFILL_TIMEOUT_MS}ms）`);
          }
          throw new Error(error instanceof Error ? error.message : '回灌失败');
        }

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `回灌失败（HTTP ${response.status}）`);
        }

        console.info(
          `[useFeedServerBackfill] 已将本地用户回灌到服务端 users=${usersWithAddresses.length}`
        );
        return true;
      } finally {
        clearTimeout(timer);
        detachExternalAbortListener?.();
        inFlightRef.current = false;
      }
    },
    []
  );

  const markAttempted = useCallback(() => {
    attemptedRef.current = true;
  }, []);

  const resetAttempted = useCallback(() => {
    attemptedRef.current = false;
  }, []);

  const isAttempted = useCallback(() => attemptedRef.current, []);

  return {
    backfill,
    markAttempted,
    resetAttempted,
    isAttempted,
  };
}
```

- [ ] **Step 2: 在主 hook import**

```typescript
import { useFeedServerBackfill } from './useFeedServerBackfill';
```

- [ ] **Step 3: 在主 hook 顶部调用新 hook，替换原 refs 和 callback**

   删除原 2 个 ref 声明（约 198-199 行）：
   ```typescript
   const serverBackfillAttemptedRef = useRef(false);
   const serverBackfillInFlightRef = useRef(false);
   ```

   删除整个 `backfillLocalUsersToServer` useCallback（约 286-361 行）。

   在原 useCallback 删除位置插入：
   ```typescript
   const {
     backfill: backfillLocalUsersToServer,
     markAttempted: markServerBackfillAttempted,
     resetAttempted: resetServerBackfillAttempted,
     isAttempted: isServerBackfillAttempted,
   } = useFeedServerBackfill();
   ```

- [ ] **Step 4: 调整 fetchActivities 内部对原 ref 的引用**

   定位 fetchActivities 内部使用 `serverBackfillAttemptedRef.current` 的代码（约 614-620 行）：
   ```typescript
   if (
     result.summary.addressCount === 0 &&
     localAddressCount > 0 &&
     !serverBackfillAttemptedRef.current
   ) {
     try {
       const restored = await backfillLocalUsersToServer(currentUsers, ticket.signal);
       if (restored && isMountedRef.current && requestId === requestIdRef.current) {
         serverBackfillAttemptedRef.current = true;
   ```

   替换为：
   ```typescript
   if (
     result.summary.addressCount === 0 &&
     localAddressCount > 0 &&
     !isServerBackfillAttempted()
   ) {
     try {
       const restored = await backfillLocalUsersToServer(currentUsers, ticket.signal);
       if (restored && isMountedRef.current && requestId === requestIdRef.current) {
         markServerBackfillAttempted();
   ```

   定位 usersFingerprint useEffect 内部对 `serverBackfillAttemptedRef.current = false` 的引用（约 752 行）：
   ```typescript
   serverBackfillAttemptedRef.current = false;
   ```

   替换为：
   ```typescript
   resetServerBackfillAttempted();
   ```

- [ ] **Step 5: 更新 fetchActivities 的 useCallback 依赖**

   原依赖数组（约 708-717 行）中有 `backfillLocalUsersToServer`，仍然保留（它现在是从新 hook 返回的）。但若 lint 报新增依赖（如 `isServerBackfillAttempted`、`markServerBackfillAttempted`），按提示加入。

- [ ] **Step 6: 验证编译**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 7: 手动浏览器验证（关键）**

   这是最敏感的一个 task：
   1. **常规场景**：打开 http://localhost:3001/ ，列表正常加载（不应该触发 backfill）
   2. **触发回灌场景**：手工临时让 `/api/feed` 返回 `summary.addressCount === 0` 的情形（最简单方法：在 DevTools Network 面板用 Block request URL 块掉 `/api/feed/prewarm`，强制刷新页面）。预期能看到 `POST /api/users/import` 被调用。
   3. **重复触发避免**：连续刷新，应只看到一次 `/api/users/import`（直到 users 变化）。

- [ ] **Step 8: Commit**

```bash
git add hooks/useFeedServerBackfill.ts hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): extract useFeedServerBackfill"
```

---

## Task 8: 最终验证 + 清理 import

**Files:**
- Modify: `hooks/useActivityPolling.ts`（最后扫一遍剩余 imports，删掉不再用到的）

- [ ] **Step 1: 行数对比**

   Run: `wc -l hooks/useActivityPolling.ts`
   预期：~250-350 行（从原 913 减少至少 60%）。

   Run: `wc -l hooks/useFeed*.ts hooks/useActiveContextRefs.ts`
   预期：每个 30-130 行不等，总和约 400-500 行。

- [ ] **Step 2: 清理孤儿 import**

   打开 `hooks/useActivityPolling.ts`，逐个检查 import 行内的名字是否还在文件中被引用：
   - `buildFeedDebugEntries` / `FeedDebugEntry` → Task 1 应已删除
   - `FeedRequestArbiter` → 仍在用（arbiterRef）
   - 其他每一项 → 在文件内 grep 是否还被引用

   删掉所有没人用的名字。

- [ ] **Step 3: 全量 build + lint**

   Run: `npx tsc --noEmit && npm run lint`
   预期：无新错误。

- [ ] **Step 4: 跑现有测试**

   Run: `npm run test`
   预期：所有现有测试通过（hook 拆分不应破坏现有测试，因为它们针对 lib/* 模块）。

- [ ] **Step 5: 浏览器全量手测清单**

   严格对照 Pre-flight 3 的基线，逐项确认：
   - [ ] "已检查 X 人 / X 个地址 / X 条动态" 数字与基线一致
   - [ ] "近 7 天已补齐 / 更新于 XX:XX" label 正常
   - [ ] 切换 "最近活跃 / 最高资产" → 列表正常重排
   - [ ] 选择用户进入详情面板 → 内容正常加载
   - [ ] 返回列表 → 状态恢复
   - [ ] 搜索框输入 → debounce 筛选正常
   - [ ] 5 秒后看到下一次 `GET /api/feed?...` 请求
   - [ ] Console 输入 `window.__feedDebug` → 对象存在
   - [ ] Console 无新增 error / warning

- [ ] **Step 6: Final commit（如有清理）**

```bash
git add hooks/useActivityPolling.ts
git commit -m "refactor(feed-hook): clean up imports after split"
```

   如无清理，跳过 commit。

---

## Definition of Done

- [ ] `hooks/useActivityPolling.ts` 行数 ≤ 350
- [ ] 7 个新 hook 文件全部存在且独立 commit
- [ ] `npx tsc --noEmit` 无新错误
- [ ] `npm run lint` 无新错误
- [ ] `npm run test` 全绿
- [ ] 浏览器手测清单全部对照基线通过

## Risk & Rollback

- **风险点**：fetchActivities 中 `serverBackfillAttemptedRef.current` 的引用（Task 7）涉及 7 处闭包，最容易遗漏改写。
- **回滚**：每个 task 独立 commit，任何一步出问题都能 `git revert <sha>` 单独回退。
