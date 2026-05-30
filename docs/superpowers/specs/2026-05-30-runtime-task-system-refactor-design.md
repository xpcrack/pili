# Runtime Task System Refactor Design

生成日期：2026-05-30
范围：`server/runtime-tasks.ts`、运行时任务注册、任务状态快照、手动触发 API、生产态默认任务策略、相关测试与文档

---

## 一句话结论

把当前已经成形的 runtime task registry 收束成一个轻量、明确、可测试的任务系统：**web/API 进程只内嵌真正适合随 web 生命周期运行的任务，Telegram 长连接类任务默认继续保持外置；所有任务通过统一定义、统一状态、统一手动触发入口被管理。**

这不是引入复杂调度平台，也不是重写业务 worker。它是一轮边界整理：让个人工具的常驻运行更容易理解、观察和被 AI 安全操作。

---

## 背景

项目已经从长期开发态运行，逐步转向 `pm2` 管理的 production-only 日常运行模式。当前约束写在 `AGENTS.md` 中：

- 日常默认是 `pili-web-prod`。
- 改代码后使用 `runtime:refresh`，先 build，再替换 production web 进程。
- 默认不重启 workers，除非用户明确要求。
- production refresh 和正常运行共用 `.env.local`、`.data`、SQLite DB。

代码层面已经出现一个统一 runtime task 系统的雏形：

- `server/runtime-context.ts` 创建运行时上下文并挂载 `tasks` registry。
- `server/runtime-tasks.ts` 定义 `createLoopTask()`、`createTaskRegistry()`、默认任务列表、任务状态快照。
- `server/runtime-api.ts` 暴露 `/api/runtime/status` 和 `/api/runtime/tasks/:key/run`。
- `scripts/test-runtime-task-registry.ts` 已覆盖基础 loop task、single-flight、stop、默认任务、prod/live Telegram 嵌入策略、状态快照、启动失败不泄漏 unhandled rejection。

但当前边界仍然混在一个文件里：循环任务框架、业务任务适配、默认策略、环境变量解析都集中在 `server/runtime-tasks.ts`。随着任务变多，这会让后续 AI 很容易在同一个大文件里堆改动，也更难判断某个任务是否应该嵌入 web 进程。

---

## 设计目标

### 1. 轻量优先

这是个人开发工具，用户不是专业程序员，主要让 AI 代操作。任务系统要保持简单：纯 TypeScript、进程内 registry、SQLite/现有 repo 状态，不引入 Redis、队列服务、cron 平台、后台管理 UI 或额外守护进程。

### 2. 运行边界清楚

明确区分两类后台工作：

- **web-embedded runtime tasks**：适合跟随 web/API 进程生命周期运行，例如轻量维护任务、可中断轮询、按需刷新。
- **external workers**：长连接、登录态敏感、资源波动或需要独立重启策略的任务，例如 Telegram bridge/channel worker。

生产态默认应偏保守：web 内嵌任务少，外置 worker 不被 `runtime:refresh` 默认触碰。

### 3. 状态和操作入口统一

所有 runtime task 都应提供同一种状态结构，包括：是否启用、是否运行中、是否有待处理运行、运行次数、最近原因、最近错误、最近开始/结束时间、下次运行时间、任务详情。

手动触发通过同一个 registry/API 入口完成，而不是每个任务自己暴露一套临时 API。

### 4. 可测试、可回滚

重构应主要改变代码组织和边界，不改变任务业务语义。每一步都应有小测试覆盖，并保留现有 `scripts/test-runtime-task-registry.ts` 的行为断言。

---

## 非目标

这轮不做以下事情：

- 不重写 Telegram sync、Telegram bridge、completeness maintenance、holdings refresh 的业务逻辑。
- 不引入数据库任务队列表或持久化调度状态。
- 不做可视化后台任务管理页面。
- 不改变 `runtime:refresh` 的核心语义：build 成功后只替换 `pili-web-prod`。
- 不默认恢复已退休的独立 pm2 worker 拓扑，也不默认重启外置 workers。
- 不把所有任务都强制塞进 web/API 进程。

---

## 当前任务清单与归属

### 继续保留为 web-embedded tasks

#### `completeness-maintenance`

理由：当前已经作为默认 runtime task 存在，循环结果结构清晰，适合随 web 进程启动后做轻量维护。它应继续保留在生产态默认任务中。

#### `holdings-refresh`

理由：当前已被加入默认 runtime task，并且状态 detail 能表达刷新摘要。它适合继续作为生产态 web 内嵌任务，便于 `/api/runtime/status` 观察，也便于手动触发。

### 生产态默认不内嵌的 tasks

#### `telegram-channel-sync`

理由：Telegram channel worker 涉及登录态、长轮询/外部网络、历史上有资源占用问题。生产态默认不随 web 进程内嵌，除非显式设置 `PILIPILI_EMBED_TELEGRAM_TASKS=true`。

#### `telegram-bridge`

理由：Telegram bridge 同样属于 Telegram 相关外部同步工作。生产态默认不内嵌，避免 `runtime:refresh` 间接影响它。

### 设计假设

这轮 spec 按当前代码和 `AGENTS.md` 约束做如下假设：

- `prod` 模式默认 `embedTelegramTasks=false`。
- `live` 模式默认 `embedTelegramTasks=true`，便于本地一体化调试。
- 环境变量 `PILIPILI_EMBED_TELEGRAM_TASKS=true|false` 可以覆盖默认策略。
- `runtime:refresh` 不重启 Telegram 类外置 worker。

如果你希望生产态也默认内嵌 Telegram 任务，应在实施前改这份 spec；否则后续计划会按上述假设执行。

---

## 方案选择

### 方案 A：小模块拆分，保留进程内 registry（推荐）

把 `server/runtime-tasks.ts` 拆成少量职责清楚的模块：

- loop task 基础设施
- registry
- 默认任务适配器
- 默认任务策略
- 对外类型

优点：改动小、风险低、符合个人工具轻量原则；测试可以从旧文件迁移并补强；不会改变运行模型。

缺点：仍然是进程内状态，web 进程重启后 task runtime 状态会归零。

这是推荐方案，因为当前真正的问题是边界不清，而不是缺少一套复杂任务平台。

### 方案 B：引入 SQLite 持久化任务状态

把 task run、last error、next run 等写入 SQLite。

优点：重启后能看到历史任务状态；未来可以做任务审计。

缺点：需要 schema、迁移、写入节流、错误处理；对当前目标偏重。

本轮不采用。后续只有在任务失败追踪确实需要历史记录时再加。

### 方案 C：把 runtime task 全部交给 pm2 worker

每个任务都拆成独立 pm2 进程。

优点：隔离强，单个任务异常不影响 web。

缺点：进程数增加，用户和 AI 操作复杂度上升；与“日常 refresh 只动 web”规则容易冲突。

本轮不采用。Telegram 类任务可以继续外置，但轻量维护任务没必要拆出去。

---

## 推荐架构

### 文件边界

建议把 runtime task 相关代码整理为以下结构：

```text
server/runtime-tasks/
  index.ts
  types.ts
  loopTask.ts
  registry.ts
  defaults.ts
  taskOptions.ts
```

`server/runtime-tasks.ts` 可以保留为兼容 re-export 文件，避免一次性改动所有 import：

```ts
export * from './runtime-tasks';
```

各文件职责：

- `types.ts`：只放 `TaskCycleResult`、`TaskStartContext`、`TaskStatusSnapshot`、`TaskDefinition`、`RuntimeTaskRegistry` 等类型。
- `loopTask.ts`：只实现 `createLoopTask()`，负责 single-flight、排队、timer、stop/abort、错误截断、状态更新。
- `registry.ts`：只实现 `createTaskRegistry()`，负责按 key 管理任务、startAll/stopAll/runTaskNow/listStatuses。
- `taskOptions.ts`：只实现 `resolveDefaultRuntimeTaskOptions()`，负责 mode/env 到默认任务策略的映射。
- `defaults.ts`：只实现 `createDefaultRuntimeTasks()`，负责把业务 cycle 函数适配成 runtime task。
- `index.ts`：统一导出 public API。

### 运行时数据流

```text
server/runtime.ts
  -> createServer()
    -> createRuntimeContext({ mode, repoRoot, port })
      -> resolveDefaultRuntimeTaskOptions({ mode, env })
      -> createDefaultRuntimeTasks(deps, options)
      -> createTaskRegistry(tasks)
    -> runtimeContext.tasks.startAll()

/api/runtime/status
  -> readRuntimeContextSnapshot()
  -> tasks.listStatuses()

/api/runtime/tasks/:key/run
  -> runtimeContext.tasks.runTaskNow(key, reason)
  -> task.runNow(reason)
```

### `createLoopTask()` 行为契约

`createLoopTask()` 是任务系统里最关键的单元，应保留并明确以下语义：

- 同一个 task 同一时间只运行一个 cycle。
- 运行中再次 `runNow()` 时排队到当前 cycle 后执行。
- `autoStart !== false` 时，`start()` 会立即排入一次 startup run。
- cycle 成功后，如果仍启用且没有 pending run，则按 `sleepMs` 安排下一次自动 run。
- `stop(signal)` 会停止后续调度、清空等待队列、abort 当前 run，并等待当前 cycle 收尾。
- 后台自动 run 失败不能产生 unhandled rejection。
- `lastError` 最多保留 2000 字符，避免状态响应过大。

### 默认任务策略

默认策略由 `mode` 和环境变量共同决定：

```text
PILIPILI_EMBED_TELEGRAM_TASKS=true  -> embedTelegramTasks=true
PILIPILI_EMBED_TELEGRAM_TASKS=false -> embedTelegramTasks=false
mode=prod                           -> embedTelegramTasks=false
mode=live                           -> embedTelegramTasks=true
```

不额外增加更多开关。若未来某个任务需要独立开关，再按实际需求添加，不提前设计复杂矩阵。

### API 行为

`/api/runtime/status` 继续返回：

- runtime 基本信息：repoRoot、mode、port、process、bun version。
- `tasks`：当前 registry 的 task status list。
- `persistedWorkers`：现有 `workerStateRepo` 状态。

`/api/runtime/tasks/:key/run` 继续：

- 接收 JSON body 中的 `reason`，空值默认为 `manual`。
- 对未知 task 返回错误，由 Hono 全局 error handler 转成 500。实施计划可把未知 task 调整为 404，但这不是本轮必须项。
- 成功后返回最新 task status。

---

## 错误处理与恢复

### cycle 错误

业务 cycle 抛错时：

- task status 置为 `error`。
- `lastError` 写入截断后的 stack/message。
- `lastFinishedAt` 更新。
- 对手动 `runNow()` 调用，Promise reject，让 API/调用方知道失败。
- 对自动后台 run，错误被捕获并写入状态，不产生 unhandled rejection。

### shutdown

进程收到 `SIGINT` 或 `SIGTERM` 时，`server/runtime.ts` 调用 `server.stop(signal)`，再由 server 调用 `runtimeContext.tasks.stopAll(signal)`。

任务 stop 的目标不是强杀业务逻辑，而是：

- 取消后续 timer。
- abort 当前 cycle 的 signal。
- 等当前 cycle 自己收尾。
- 清空还未开始的 queued run。

这保持了当前轻量模型，也避免为了“强制停止”引入额外复杂度。

---

## 测试策略

### 保留现有行为测试

`scripts/test-runtime-task-registry.ts` 继续作为主要行为测试，覆盖：

- `runNow()` 和状态快照。
- single-flight 与 pending run。
- registry start/stop/run/get/list。
- stop 等待 active cycle 收尾。
- 默认任务包含 holdings/completeness。
- prod/live/env 的 Telegram 嵌入策略。
- runtime snapshot process memory。
- auto-start failure 不泄漏 unhandled rejection。

### 新增或强化测试

实施计划应补强这些断言：

- 模块拆分后 public exports 与旧 import 路径兼容。
- `createDefaultRuntimeTasks()` 的任务顺序稳定，便于 status 展示和测试阅读。
- `resolveDefaultRuntimeTaskOptions()` 对大小写和空白 env 值处理稳定。
- `runTaskNow()` 对未知 key 的错误消息稳定。
- `stopAll()` 在多个任务存在时按注册顺序停止。

### 验证命令

本轮实施完成后至少运行：

```bash
npm test -- --filter=runtime-task-registry
npm run test:runtime-mode
npm run build
```

如果改动触及 runtime docs 或 README，还应运行：

```bash
npm run test:runtime-docs
```

如果 full suite 有既有失败，最终报告需要区分“新增失败”和“已知既有失败”。

---

## 实施边界

建议按以下顺序实施：

1. 先加/改测试，锁住当前 `server/runtime-tasks.ts` 的 public behavior。
2. 拆出 `types.ts`、`loopTask.ts`、`registry.ts`，保持 `server/runtime-tasks.ts` re-export 兼容。
3. 拆出 `taskOptions.ts` 和 `defaults.ts`。
4. 更新 imports，只在必要处改路径。
5. 跑 focused tests。
6. 最后跑 build 和 runtime mode tests。

每一步都应小而可回滚。不要顺手改业务 worker 的内部算法。

---

## 预期结果

完成后，后续 AI 或用户查看 runtime task 系统时，应能快速回答：

- 任务基础设施在哪里？`server/runtime-tasks/loopTask.ts`。
- 任务注册表在哪里？`server/runtime-tasks/registry.ts`。
- 默认有哪些任务？`server/runtime-tasks/defaults.ts`。
- 为什么 prod 不默认嵌入 Telegram？`server/runtime-tasks/taskOptions.ts` 和本 spec。
- 怎么看状态？`npm run runtime:status` 或 `/api/runtime/status`。
- 怎么手动跑某个任务？`POST /api/runtime/tasks/:key/run`。

整体运行模式仍然保持轻量：一个 production web/API 进程管理少量内嵌维护任务；Telegram 类任务不被 production refresh 默认扰动。

---

## 用户确认点

请重点确认这三个口径：

1. 生产态默认只内嵌 `completeness-maintenance` 和 `holdings-refresh`，不内嵌 Telegram 类任务。
2. 本轮只做 task 系统边界整理，不做 SQLite 持久化任务历史。
3. 本轮不新增 UI，只保留 `/api/runtime/status` 和手动 task run API。

如果这三点没问题，下一步再写实施计划，然后进入代码改动。
