# Feed 选中人物持仓详情设计

日期：2026-05-05  
状态：已在 brainstorming 过程中确认  
负责人：Feed UI / User details API / OKX asset details

## 1. 背景与问题

当前 Feed 页已经支持通过左侧人物头像切换到“只看这个人”的视图，但选中人物后，顶部摘要区只能看到：

- 总资产
- 历史最高
- 动态拆分
- 完备窗口

还看不到这个人的具体持仓构成。

另一方面，项目已经具备 OKX 资产明细抓取能力：

- [`/Users/xp/vibecoding/pilipili/lib/okx.ts`](/Users/xp/vibecoding/pilipili/lib/okx.ts) 中已有 `fetchOkxAddressAssetDetails()`
- 资产同步与峰值校验链路已经在使用 OKX 明细求和口径

但这份明细目前只在服务端资产流程中短暂存在，没有暴露给 Feed 的人物详情视图，因此用户无法在选中人物后直接看到“这个人当前主要持有哪些币、分布在哪条链上”。

本次工作要补上这一层：在 Feed 中选中人物后，直接在顶部摘要区下方展示该人物聚合后的持仓详情，并过滤掉小于 5 USD 的小额持仓。

## 2. 目标

- 在 Feed 页选中人物后，展示该人物的聚合持仓详情。
- 将持仓详情收敛到用户详情接口，而不是散落到 Feed 主接口或单独新路由。
- 持仓按 `链 + token` 聚合。
- 过滤掉 `valueUsd < 5` 的持仓行。
- 默认按 `valueUsd` 从高到低排序。
- 表格先提供中等信息密度：
  - 链
  - Token
  - 数量
  - 单价
  - 价值
- 保持 Feed 主拉取链路尽量不变，避免把额外复杂度塞进 [`/Users/xp/vibecoding/pilipili/hooks/useActivityPolling.ts`](/Users/xp/vibecoding/pilipili/hooks/useActivityPolling.ts)。

## 3. 非目标

- 不把持仓明细塞进 `/api/feed` 或 `/api/users` 的全量列表响应。
- 不新开独立人物详情页。
- 不新开独立持仓详情弹窗。
- 不把持仓明细持久化到数据库。
- 不调整现有总资产字段的写库逻辑。
- 不改当前 OKX 资产同步主流程的口径。
- 不在本期增加地址来源展开、地址数展示、点击 token 跳转等扩展交互。

## 4. 已确认决策

- 持仓详情作为“用户详情接口”的一部分，而不是单独的新接口。
- 展示位置在 Feed 中“选中人物”的顶部摘要卡下面，不跳页、不弹窗。
- 聚合规则按 `链 + token`，跨链同名币不合并。
- 排序规则按 `valueUsd` 从高到低。
- 展示字段采用中等信息密度：
  - `链`
  - `Token`
  - `数量`
  - `单价`
  - `价值`

## 5. 方案对比

### 5.1 方案 A：扩展 `GET /api/users/[id]`（采用）

- 在现有 [`/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts`](/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts) 上新增 `GET`
- 返回人物基础信息和聚合后的持仓详情

优点：

- 最符合“作为用户详情接口一部分”的需求
- 只有选中某个人物时才按需请求，避免把重数据塞进 Feed 主接口
- 前端职责清晰，Feed 主数据和人物详情数据各走各的链路

缺点：

- 选中人物时会多一次请求

### 5.2 方案 B：把持仓详情塞进 `/api/feed`

优点：

- 选中人物时理论上可能少一次请求

缺点：

- `/api/feed` 每次都会带更多数据
- 全局 Feed 会被迫关心“所有人物的持仓详情”
- 会继续加重 `useActivityPolling` 的职责

### 5.3 方案 C：新增 `/api/users/[id]/holdings`

优点：

- 路由语义单纯

缺点：

- 与“放进用户详情接口”的决策不一致
- 会多一套路由和前端状态管理，收益不大

## 6. 总体设计

本次采用“用户详情接口按需计算 + Feed 顶部内嵌详情区”的方案：

1. 在 [`/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts`](/Users/xp/vibecoding/pilipili/app/api/users/[id]/route.ts) 新增 `GET`
2. 新增服务端聚合模块，例如 [`/Users/xp/vibecoding/pilipili/lib/server/userHoldingsDetails.ts`](/Users/xp/vibecoding/pilipili/lib/server/userHoldingsDetails.ts)
3. 新增轻量客户端请求封装，例如 [`/Users/xp/vibecoding/pilipili/lib/userDetailsApi.ts`](/Users/xp/vibecoding/pilipili/lib/userDetailsApi.ts)
4. 新增选中人物详情 hook，例如 [`/Users/xp/vibecoding/pilipili/hooks/useSelectedUserDetails.ts`](/Users/xp/vibecoding/pilipili/hooks/useSelectedUserDetails.ts)
5. 将 Feed 页现有选中人物摘要区从 [`/Users/xp/vibecoding/pilipili/app/page.tsx`](/Users/xp/vibecoding/pilipili/app/page.tsx) 中抽成独立组件，例如 [`/Users/xp/vibecoding/pilipili/components/SelectedUserDetailsPanel.tsx`](/Users/xp/vibecoding/pilipili/components/SelectedUserDetailsPanel.tsx)

采用这个结构的原因是：

- `app/page.tsx` 当前已经较长，继续直接堆持仓表会让页面更难维护
- `useActivityPolling` 当前已经承担 Feed 主拉取链路，不适合再并入人物详情数据
- 人物详情本身是“选中后才需要”的附加信息，适合独立模块化

## 7. API 设计

### 7.1 路由

在现有路由上新增：

- `GET /api/users/[id]`

保留现有：

- `PATCH /api/users/[id]`
- `DELETE /api/users/[id]`

### 7.2 响应结构

建议响应结构如下：

```ts
interface UserDetailsResponse {
  ok: true;
  user: User;
  holdings: UserHoldingRow[];
  holdingsUpdatedAt: number | null;
  holdingsThresholdUsd: 5;
  holdingsSummary: {
    visibleCount: number;
    partial: boolean;
    successfulAddressCount: number;
    failedAddressCount: number;
  };
}

interface UserHoldingRow {
  chain: ChainType;
  tokenAddress: string;
  symbol: string;
  name: string | null;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}
```

设计原则：

- `user` 继续沿用现有人物结构，避免前端维护第二套人物模型
- `holdings` 已经是服务端聚合、过滤、排序后的最终展示数据
- `holdingsUpdatedAt` 表示本次详情抓取完成时间；若没有成功地址则为 `null`
- `holdingsThresholdUsd` 明确告诉前端过滤阈值，避免魔法数字散落在页面中
- `holdingsSummary.partial` 用于驱动“部分地址失败”的弱提示

### 7.3 状态语义

- 人物存在，且至少一个地址明细成功：
  - 返回 `200`
  - `ok: true`
  - `holdingsSummary.partial` 可能为 `false` 或 `true`
- 人物存在，但没有任何地址：
  - 返回 `200`
  - `holdings: []`
  - `holdingsSummary.partial = false`
- 人物不存在：
  - 返回 `404`
- 人物存在，但全部地址抓取失败：
  - 返回 `502`
  - `ok: false`
  - 附带错误文案

“部分成功”与“全部失败”要明确区分，避免前端把“上游失败”误显示成“无持仓”。

## 8. 服务端聚合规则

### 8.1 数据来源

用户详情服务从人物记录出发：

1. 读取目标人物
2. 遍历该人物全部地址
3. 对每个地址调用现有 `fetchOkxAddressAssetDetails(address, chain)`
4. 收集成功结果并生成持仓行
5. 聚合、过滤、排序后返回

不额外引入数据库持久化层，保持为按需计算型接口。

### 8.2 聚合键

单条持仓的合并条件为：

- `chain` 相同
- `tokenAddress` 相同

这意味着：

- `BSC-USDT` 与 `Ethereum-USDT` 分成两行
- 同链同 token、来自不同地址的结果合并为一行

### 8.3 合并规则

聚合后每一行：

- `balance` 为同组持仓数量求和
- `valueUsd` 为同组持仓价值求和
- `priceUsd` 使用 `valueUsd / balance` 反推
- `symbol` 优先保留已有非空 symbol
- `name` 优先保留已有非空 name

### 8.4 过滤规则

服务端在聚合完成后执行：

- 过滤掉 `valueUsd < 5` 的行

前端不重复计算过滤逻辑，只消费过滤后的结果。

### 8.5 排序规则

最终返回前执行：

- 按 `valueUsd desc` 排序
- 若 `valueUsd` 相同，再按 `chain` 和 `tokenAddress` 做稳定排序

## 9. Feed 前端设计

### 9.1 展示位置

仅当 Feed 已选中人物时显示该详情区。

位置：

- 放在当前人物摘要卡下方
- 与“返回 / 头像 / 总资产 / 历史最高 / 动态拆分”属于同一块上下文

回到“全部动态”时：

- 不显示持仓详情区

### 9.2 组件拆分

建议把当前 `selectedUser` 相关 UI 从 [`/Users/xp/vibecoding/pilipili/app/page.tsx`](/Users/xp/vibecoding/pilipili/app/page.tsx) 中抽出，形成一个独立组件：

- `SelectedUserDetailsPanel`

组件职责：

- 渲染当前人物已有摘要信息
- 请求并展示持仓详情
- 处理 loading / empty / error / partial 状态

这样可以避免把 `app/page.tsx` 继续堆大。

### 9.3 表格内容

持仓区顶部显示：

- 标题：`持仓明细`
- 更新时间
- 小字说明：`已隐藏 < 5 USD 持仓`

表格列为：

- `链`
- `Token`
- `数量`
- `单价`
- `价值`

展示说明：

- `Token` 列展示 `symbol`，若有 `name` 可作为次级灰字
- `数量`、`单价`、`价值` 继续复用现有数值格式化风格
- 默认不增加地址来源展开和更多交互

## 10. 前端状态与缓存

### 10.1 请求触发

- 只有在 `selectedUserId !== null` 时才触发详情请求
- 切换选中人物时，按新的 `userId` 读取详情

### 10.2 缓存策略

前端对 `userId` 做会话级内存缓存：

- 首次点击某人物时：
  - 显示 loading
  - 请求详情
- 再次点击同一人物时：
  - 先展示缓存
  - 再后台刷新

这个缓存只存在当前页面会话中，不落地到持久 store。

### 10.3 与现有 feed hook 的边界

不把人物详情并入 [`/Users/xp/vibecoding/pilipili/hooks/useActivityPolling.ts`](/Users/xp/vibecoding/pilipili/hooks/useActivityPolling.ts)。

原因：

- `useActivityPolling` 负责 Feed 主拉取、补历史、快照同步等主流程
- 持仓详情是选中人物后的附加信息
- 分开后更容易维护和测试

## 11. 异常与降级策略

### 11.1 部分地址失败

若部分地址抓取 OKX 明细失败，但仍有成功地址：

- 接口返回 `200`
- `holdingsSummary.partial = true`
- `failedAddressCount > 0`
- 前端继续显示成功地址聚合出的持仓
- 在持仓区显示轻量提示，例如“部分地址读取失败，结果可能不完整”

### 11.2 全部地址失败

若全部地址都失败：

- 接口返回 `502`
- 前端显示错误态和重试按钮
- 不显示空表，不伪装成“没有持仓”

### 11.3 无持仓

若人物存在且请求成功，但过滤后没有任何 `>= 5 USD` 的持仓：

- 接口返回 `200`
- `holdings` 为空数组
- 前端显示：`暂无 >= 5 USD 的持仓`

## 12. 与现有总资产的关系

Feed 顶部现有“总资产”继续使用人物主数据里的 `totalAssetUsd`。

下方持仓表使用的是：

- 本次请求拿到的 OKX 明细
- 聚合后
- 过滤掉 `< 5 USD`

因此二者不保证严格相等，主要原因有两类：

- 明细表隐藏了小额持仓
- 人物主数据与本次明细请求的时间点可能不同

所以在 UI 中应明确展示：

- 持仓更新时间
- `已隐藏 < 5 USD 持仓`

避免用户误以为表格求和必须精确对齐顶部总资产。

## 13. 测试策略

本轮只写设计，不进入实现；后续实现应先补测试，再改代码。

建议测试分层如下。

### 13.1 服务端聚合测试

- 同链同 token 会合并
- 跨链同 symbol 不合并
- `valueUsd < 5` 会被过滤
- 最终结果按 `valueUsd` 降序排序
- 部分地址失败时仍能返回部分结果
- 全部地址失败时返回错误
- 无地址人物返回空结果而非错误

### 13.2 API 测试

- `GET /api/users/[id]` 成功返回详情
- `GET /api/users/[id]` 对不存在人物返回 `404`
- 部分失败返回 `200 + holdingsSummary.partial`
- 全失败返回 `502`

### 13.3 前端测试

- 选中人物后触发详情请求
- 回到“全部动态”时详情区隐藏
- loading 状态可见
- empty 状态可见
- error 状态可见
- partial 提示可见
- 表格列和值渲染正确
- 切换人物时缓存与刷新行为符合预期

## 14. 验收标准

- Feed 页选中人物后，可以在顶部摘要区下方直接看到该人物持仓详情
- 持仓详情来自用户详情接口，而不是 Feed 主接口
- 持仓按 `链 + token` 聚合
- 小于 `5 USD` 的行不会显示
- 表格默认按价值从高到低
- 前端能正确处理 loading / empty / error / partial 状态
- `app/page.tsx` 不因这次功能继续明显膨胀，选中人物详情逻辑有独立边界

## 15. 实施边界

后续 implementation plan 应只覆盖以下范围：

1. 给 `GET /api/users/[id]` 增加详情返回能力
2. 新增服务端持仓聚合模块
3. 新增轻量详情请求与前端 hook
4. 将 Feed 中选中人物摘要区抽成独立组件并接入持仓表
5. 补齐服务端与前端测试

不延伸到：

- 独立人物详情页
- 地址来源展开
- token 链接跳转
- 总资产口径重构
- 资产明细持久化
