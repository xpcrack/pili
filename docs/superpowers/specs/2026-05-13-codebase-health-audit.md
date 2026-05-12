# Pilipili 项目代码体检报告

生成日期：2026-05-13
扫描范围：`app/` `components/` `lib/` `hooks/` `store/` `scripts/`
体量基线：305 个 ts/tsx 文件，66,300 行代码

---

## 一句话结论

**项目整体很健康**（零 TODO/FIXME、零 any 类型、依赖只有 25 个，纪律性强），但**少数几个超大文件是定时炸弹**——尤其是 `useActivityPolling.ts` 这个 913 行的 "上帝 Hook" 和几个动辄上千行的服务端文件，改它们就像拆雷。

**最该动的 3 件事（按 ROI 排序）**：

1. 🔴 **拆 `hooks/useActivityPolling.ts`**（913 行，独占 hooks/ 目录三分之一）——直接关系到你今天看到的 "页面 0 数据" 这类问题，难改、难调试。
2. 🟡 **删 3 个明显没人用的 lib 文件**——10 分钟工作，立刻减负。
3. 🟡 **`app/manage/page.tsx`（1195 行）+ `app/page.tsx`（723 行）拆组件**——后续 UI 改动会舒服很多。

---

## TOP 5 肥大文件（应用代码，已排除测试脚本）

| 文件 | 行数 | 在干啥 | 肥在哪 / 能怎么瘦 |
|---|---|---|---|
| `lib/server/twitterFetcher.ts` | **1448** | 推特数据抓取的总入口，多 provider 适配 | 多个 provider 的实现都塞一个文件。可拆成 `providers/{xread,6551,…}.ts`，主文件只留路由分发。 |
| `app/manage/page.tsx` | **1195** | 管理后台页（人物/地址/同步管理） | 一个 1200 行的 client component，里面包了表格、模态框、表单、状态机。该拆 5-8 个子组件。 |
| `lib/server/sqlite.ts` | **1160** | DB 连接 + schema 初始化 + 迁移 + 工具函数 | 把 schema 定义、migration、helper 拆三个文件。当前一个文件改一处影响全家。 |
| `lib/server/trackedUsersRepo.ts` | **1089** | 人物/地址的增删改查 | 45 个 `prepare()` 调用，多到怀疑有重复 SQL。可抽公共查询，至少能砍 200 行。 |
| `hooks/useActivityPolling.ts` | **913** | Feed 数据轮询 + SSE + 缓存合并 + 后台刷新 | "上帝 Hook"，11 个 useRef，混合了 polling/SSE/backfill/dedup/state。这是你今天那个 0 数据 bug 的潜在源头之一。**优先级最高**。 |

补充榜单（虽未进前 5 但值得关注）：
- `app/system/page.tsx` 834 行 — 系统设置页，同样有"页面承担太多"的问题
- `components/ActivityCard.tsx` 695 行 — 单个卡片组件这么肥，里面一定有未抽离的子状态
- `lib/okx.ts` 1067 行 — OKX SDK 封装，可能需要按交易/钱包/市场拆模块

---

## 风险热区（按严重程度排）

### 🔴 1. "上帝 Hook"：`useActivityPolling.ts`
- 913 行、11 个 ref 变量、混 polling + SSE + 后端 backfill + 客户端 dedup + 投毒过滤
- 任何 Feed 数据问题都得啃这个文件
- **风险**：你今天看到的 3001 端口"已检查 0 人"——前端调用回来的 summary 是 0，最大嫌疑就是这个 hook 里某条 race condition 把数据吞了
- **建议**：按职责拆 → `useFeedFetcher`（数据获取）+ `useFeedSnapshot`（本地缓存）+ `useJudgmentStream`（SSE）+ `useBackfillTrigger`（后台触发）。每个 200 行内

### 🟡 2. 调试 API 暴露在生产路由树
出现在 `app/api/` 下的调试入口：
- `app/api/debug-tx/route.ts`
- `app/api/debug-tx-simple/route.ts`
- `app/api/debug/tx-judgment/route.ts`
- `app/api/debug/tx-judgment/stream/route.ts`
- `app/api/system-config/test-notify/route.ts`

虽然这是个人工具不开放，但散落在主路由树下迟早会忘记自己加过什么。**建议**：统一放 `app/api/debug/` 下，加一个 `NODE_ENV !== 'production'` 守卫或固定 token 校验。

### 🟡 3. `console.log` 当日志用（26 处）
集中在：
- `app/api/backfill-14days/route.ts`（多条 `console.log('开始补充...', ...)` 这种白描叙事）
- 几个其他 API 路由

**建议**：要么删掉这些纯调试输出，要么换成 `lib/log` 类的统一 logger（如果有的话——如果没有就用 console.error 仅留错误分支）。

### 🟡 4. `app/manage/page.tsx` 不该是一个文件
1195 行的 client component。这种规模意味着每改一处都得加载整文件上下文。Next.js 渲染也会承担更大的 JS bundle。
**建议**：先识别其中独立的"功能区"（人物列表、地址列表、批量操作、模态框…），抽到 `app/manage/components/` 子目录。

### 🟢 5. 命名风格混用（小问题）
- `app/api/` 下 kebab-case (`backfill-14days`, `debug-tx`) 和扁平 (`sync`, `feed`) 并存
- 不算 bug，但新人或半年后的你看会困惑
- **建议**：约定一个 → 全 kebab，或全扁平短词。但 ROI 低，可以最后做

---

## 可清理的明显垃圾

### 没被任何文件引用的 lib（疑似死代码）
（搜索方式：grep import 路径包含这些文件名的次数 = 0）

- `lib/server/twitterEnrichmentService.ts`
- `lib/server/historicalPeakRepair.ts`
- `lib/server/activityImportanceBackfill.ts`

⚠️ **删之前要核实**：可能是通过 `npm run xxx` 这种 package.json 脚本动态调用的（看到 `audit:historical-asset-peaks` 和 `importance:backfill` 两个 npm scripts，可能就是用这些文件）。**核实 10 分钟，确认无引用再删 1 分钟。**

### `scripts/` 目录 (24,062 行)
112 个 .ts 文件，几乎占整个项目 1/3 的代码量。其中很多是 `test-*` 前缀（实际是夹具/集成测试），不少 1000+ 行。
**说明**：这部分不是生产代码，但量大意味着维护成本高。后续可以单独做一次 "scripts 精简" 体检。当前不动。

---

## 下一步建议（按 ROI）

### 建议 A：🔴 拆 `useActivityPolling.ts`（强推）
- **能解决**：Feed 数据相关 bug 的可调试性。也直接相关于你今天那个 0 数据问题。
- **工作量**：中等（2-4 小时）。需要先理解原 hook 的状态流，再按职责切分。
- **风险**：中。涉及前端数据流，改完要手测 Feed 页所有交互（切换用户、轮询、SSE 触发）。
- **副产物**：拆完后大概率能定位到今天那个"已检查 0 人"的真正原因。

### 建议 B：🟡 删 3 个疑似死代码 + 清 console.log
- **能解决**：减少认知噪音。
- **工作量**：小（30 分钟）。
- **风险**：低。死代码删错可以从 git 找回；console.log 清掉只会让日志更干净。

### 建议 C：🟡 拆 `app/manage/page.tsx` 和 `app/page.tsx`
- **能解决**：后续 UI 改动效率。
- **工作量**：大（半天）。
- **风险**：中。client 组件拆分会涉及 props 传递、状态提升。改完要手测页面所有交互。
- **暂缓建议**：如果近期没大幅改这两页的计划，可以放后面。

### 不建议现在动
- `twitterFetcher.ts` / `sqlite.ts` / `*Repo.ts` 这些服务端大文件：**虽然肥但不疼**。你不写底层代码、改它们也不影响日常使用。先放着。
- `scripts/` 精简：单独一次任务，不和这次混。
- 命名风格统一：纯审美，最后做。

---

## 等你选

报告完了。你看完后告诉我：

- **想动 A、B、C 哪个？**（可多选）
- 选定后我会调 `writing-plans` 写实施计划，然后再开工。
