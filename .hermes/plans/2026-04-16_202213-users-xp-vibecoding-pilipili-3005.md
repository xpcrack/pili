# 诊断：pilipili 首页无动态

## 问题
项目在 localhost:3005 跑起来了，但首页看不到任何动态。

## 根因分析

数据流追踪如下：

```
客户端 Zustand store (users) 
  -> POST /api/feed (body: { users })
    -> importTrackedUsers(users) // 写入 SQLite
    -> triggerSync()
      -> buildActivityFeed(users) // 调用外部 API 拉链上数据
      -> replaceFeedSnapshot(feed) // 写入 activity_feed 表
  <- 返回 feed + summary + users
客户端渲染
```

**最可能的原因：`DEFAULT_USERS` 为空数组，且 localStorage 中也没有用户数据。**

关键证据：

1. `types/index.ts:62` — `export const DEFAULT_USERS: User[] = [];`
   没有任何预置用户，首次打开全是空的。

2. `hooks/useActivityPolling.ts:653` — 当 `currentUsers.length === 0` 时直接返回空数据，不请求 API：
   ```ts
   if (currentUsers.length === 0) {
     // ...清空所有数据
     setFeed([]);
     return { feedLength: 0, ... };
   }
   ```

3. `store/usersDataStore.ts:73` — Zustand store 初始值为 `DEFAULT_USERS`（空数组），通过 localStorage 持久化。首次访问时 store 为空。

**结果**：首页 sidebar 无用户列表 -> feed 请求发送空 users 数组 -> 服务端无数据可同步 -> 首页空白。

## 次要可能原因（排除顺序）

| # | 原因 | 判断依据 |
|---|------|----------|
| 1 | 无用户数据（主因） | DEFAULT_USERS = [] |
| 2 | sync 未触发/失败 | 但即使 sync 成功，空 users 也没有数据可拉 |
| 3 | 外部 API 不可用 | 如果有用户但 API 挂了，会显示 error 信息 |
| 4 | 浏览器 localStorage 被清 | 与首次打开等价，回到原因 1 |

## 修复方案

### 方案 A：添加默认用户（最快验证）
在 `types/index.ts` 中给 `DEFAULT_USERS` 填入几个测试用户：
```ts
export const DEFAULT_USERS: User[] = [
  {
    id: 'test-1',
    name: '测试用户',
    handle: 'test-user',
    avatar: '',
    addresses: [
      { address: '<某个BSC地址>', name: '#1', chain: 'bsc', totalAssetUsd: null, assetUpdatedAt: null },
    ],
    totalAssetUsd: 0,
    historicalMaxAssetUsd: 0,
    assetUpdatedAt: null,
    tags: [],
  },
];
```

### 方案 B：引导用户进入 /manage 页面导入（推荐用于生产）
在首页当 `users.length === 0` 时，显示一个引导卡片，提示用户去 `/manage` 页面导入地址。

### 方案 C：服务端预置种子数据
在 `lib/server/trackedUsersRepo.ts` 或数据库初始化时插入种子用户。

## 建议执行步骤

1. 先用方案 B — 在首页加空状态引导 UI（无侵入，不改业务逻辑）
2. 如果需要立即看到数据验证流程，再用方案 A 填入真实地址
3. 访问 `http://localhost:3005/manage` 手动导入用户，确认导入后首页是否正常显示动态

## 关键文件
- `types/index.ts:62` — DEFAULT_USERS 定义
- `store/usersDataStore.ts:73` — store 初始值
- `hooks/useActivityPolling.ts:653` — 空 users 短路逻辑
- `app/page.tsx` — 首页组件，需加空状态引导
- `app/manage/page.tsx` — 用户管理页

## 验证方法
1. `curl http://localhost:3005/api/feed -X POST -H 'Content-Type: application/json' -d '{"users":[]}'` — 应返回空 feed
2. 浏览器打开 DevTools -> Application -> Local Storage -> 检查 `web3-users-data` 键值
3. 进入 `/manage` 页面导入用户后返回首页确认动态是否出现
