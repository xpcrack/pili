# 人物与地址分开管理设计

日期：2026-05-04

## 背景

当前 [`/Users/xp/vibecoding/pilipili/app/manage/page.tsx`](/Users/xp/vibecoding/pilipili/app/manage/page.tsx) 同时承担了两类职责：

- 人物管理：批量导入人物、手动新建人物、查看人物级汇总、删除人物
- 地址管理：在人物行内展开地址、复制地址、通过人物导出地址

这带来两个问题：

- “人物”与“地址”是两种不同的管理对象，但目前只暴露了一个混合入口
- 地址视角缺少像 BID2 那样的平铺列表，用户很难快速扫一遍全部地址

另一方面，当前项目的底层存储其实已经具备“人物表 + 地址表”的分离基础：

- `tracked_users` 保存人物主信息
- `tracked_addresses` 保存地址明细
- [`/Users/xp/vibecoding/pilipili/app/api/internal/bid/users/route.ts`](/Users/xp/vibecoding/pilipili/app/api/internal/bid/users/route.ts) 已经在把同一套数据以“人物 + 地址列表”的方式提供给 BID2

所以这次不需要先做数据模型重写，重点是把管理入口拆开，让 UI 结构更接近 BID2 当前可接受的地址平铺模式。

## 目标

- 将“人物管理”和“地址管理”拆成两个独立页面
- 保留当前 `tracked_users + tracked_addresses` 存储，不做大迁移
- 新增独立地址页，提供 BID2 风格的平铺地址表
- 地址页只承担轻量地址管理：
  - 浏览
  - 浏览器原生搜索
  - 复制
  - 导出
  - 删除地址
- 人物页继续承担人物导入、新建、概览、删除等人物级操作
- 删除地址后，若该人物没有剩余地址，人物记录仍然保留

## 非目标

- 不把地址升级成“可脱离人物独立存在”的资源
- 不支持在地址页调整地址归属人物
- 不支持在地址页修改地址别名
- 不新增项目内“查看该地址持仓详情”的弹窗或独立视图
- 不将当前数据模型迁移成完全独立的 canonical people / addresses API 套件
- 不重做人物页的导入/新建主流程

## 用户决策记录

- 采用“先拆管理入口、底层继续兼容旧模型”的折中路线
- 每个地址仍然必须归属某个人物
- 地址页不提供“调人”能力
- 人物管理和地址管理拆成两个独立页面，而不是同页 Tab
- 地址页不支持改别名，只做查看、导出、删除
- 删除某人物最后一个地址时，人物记录保留
- 地址页接受 BID2 当前的平铺结构
- 地址页优先展示：
  - 名字
  - 上次交易时间
  - 总资产
  - GMGN 链接
- 地址页暂时不做项目内持仓详情
- 地址页可直接依赖浏览器自带搜索，不额外做页面内搜索框

## 设计概览

本次改动采用“页面分离，存储不动，服务端新增平铺视图”的方案：

1. 保留 [`/Users/xp/vibecoding/pilipili/app/manage/page.tsx`](/Users/xp/vibecoding/pilipili/app/manage/page.tsx) 作为人物管理页
2. 新增独立地址页，例如 [`/Users/xp/vibecoding/pilipili/app/addresses/page.tsx`](/Users/xp/vibecoding/pilipili/app/addresses/page.tsx)
3. 新增专用地址列表接口，例如 [`/Users/xp/vibecoding/pilipili/app/api/addresses/route.ts`](/Users/xp/vibecoding/pilipili/app/api/addresses/route.ts)
4. 地址页只消费服务端已经整理好的“平铺地址行”，不在前端从人物数组自行拆解
5. 删除地址继续复用现有 `DELETE /api/users/[id]/addresses` 能力，不新增第二套删除语义

这样做的重点是把职责边界收清楚：

- 人物页负责“人物”
- 地址页负责“地址视角”
- 归属关系仍然只在人物一侧维护

## 当前状态与改动方向

### 1. 当前人物页

当前人物页具备：

- 批量导入人物
- 手动新建人物
- 人物卡片式表格
- 行内地址展开
- 导出全部地址
- 导出全部推特

本次之后，人物页保留：

- 批量导入人物
- 手动新建人物
- 人物级资产与活跃度概览
- 删除人物

本次之后，人物页移除：

- 行内展开地址列表

建议做法：

- 人物页保留“地址数量”列
- 人物页不再直接渲染地址明细
- 需要看地址细节时，引导到独立地址页

### 2. 当前底层结构

当前底层已经分开保存：

- `tracked_users`
- `tracked_addresses`

且 `0x` 地址会自动展开为：

- `bsc`
- `ethereum`
- `base`

这意味着 UI 上虽然展示的是“一个 EVM 地址”，底层实际上已经有多条链级跟踪记录。

本次设计不改变这套机制，只是在地址页上继续沿用现有聚合口径，把同一个 EVM 地址聚合成一行。

## 页面结构

### 1. 人物页

人物页继续使用当前路由：

- `/manage`

页面职责：

- 批量导入人物
- 手动新建人物
- 显示人物列表
- 删除人物

展示重点：

- 名称
- Twitter / Telegram
- 标签
- 地址数量
- 历史最高资产
- 当前总资产
- 近 7 天社交动态
- 近 7 天链上动态

不再承担：

- 地址平铺管理
- 地址主列表浏览

### 2. 地址页

新增独立路由：

- `/addresses`

页面职责：

- 平铺展示全部逻辑地址
- 提供复制地址
- 提供导出全部地址
- 提供跳转 GMGN
- 提供删除地址

页面不提供：

- 页面内搜索框
- 地址别名编辑
- 地址归属人物编辑
- 持仓详情弹窗

地址页交互尽量收敛为 BID2 当前能接受的简单模式。

## 顶部导航

[`/Users/xp/vibecoding/pilipili/components/TopNav.tsx`](/Users/xp/vibecoding/pilipili/components/TopNav.tsx) 当前包含：

- `Feed`
- `人物`
- `系统`

本次新增：

- `地址`

导航结果变为：

- `Feed`
- `人物`
- `地址`
- `系统`

其中：

- `人物` 继续指向 `/manage`
- `地址` 指向 `/addresses`

本次不重命名 `人物` 标签，因为它已经足够明确，新增 `地址` 后用户能够清楚区分两个入口。

## 地址页数据视图设计

### 1. 视图模型

新增地址页专用行结构，建议由服务端直接返回：

```ts
interface AddressManagementRow {
  userId: string;
  userName: string;
  addressName: string;
  displayName: string;
  address: string;
  primaryChain: 'bsc' | 'solana' | 'ethereum' | 'base';
  chains: Array<'bsc' | 'solana' | 'ethereum' | 'base'>;
  networkLabel: 'EVM地址' | 'SOL地址';
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
  latestActivityAt: number | null;
  gmgnUrl: string | null;
}
```

字段说明：

- `userId`
  - 复用现有删地址接口所需的人物 id
- `userName`
  - 人物名
- `addressName`
  - 地址别名，例如 `#7`
- `displayName`
  - 展示名，固定为 `人物名 + 地址别名`，例如 `alice#1`
- `address`
  - 原始地址文本
- `primaryChain`
  - 该逻辑地址对外展示时采用的主链
- `chains`
  - 聚合后所包含的链集合
- `networkLabel`
  - `EVM地址` 或 `SOL地址`
- `totalAssetUsd`
  - 聚合后的总资产
- `assetUpdatedAt`
  - 资产快照更新时间
- `latestActivityAt`
  - 最新链上活动时间
- `gmgnUrl`
  - 当前展示行对应的 GMGN 地址链接

### 2. EVM 聚合规则

地址页沿用当前 [`/Users/xp/vibecoding/pilipili/lib/addressBook.ts`](/Users/xp/vibecoding/pilipili/lib/addressBook.ts) 的逻辑地址聚合语义：

- 同一个 `0x` 地址在 `bsc / ethereum / base` 上的跟踪记录聚合成一行
- `totalAssetUsd` 取三链和
- `assetUpdatedAt` 取三链最大值
- `latestActivityAt` 取三链最大值

这意味着地址页不会把同一个 EVM 地址拆成三行。

### 3. EVM 主链口径

由于 GMGN 地址页必须落到具体链，本次明确规定：

- 对聚合后的 EVM 地址行，`primaryChain` 固定采用 `bsc`

原因：

- 当前 `0x` 地址默认推断链就是 `bsc`
- 当前系统的 EVM 地址输入、导入和聚合逻辑都默认以 `bsc` 为首选链
- 这样可以避免地址页对同一行出现不稳定的 GMGN 跳转目标

因此：

- EVM 行的 `gmgnUrl` 使用 `buildGmgnAddressUrl('bsc', address)`
- Solana 行的 `gmgnUrl` 使用 `buildGmgnAddressUrl('solana', address)`

本次不引入 GMGN 链选择器。

## 地址页展示设计

地址页表格展示列收敛为：

- 名字
- 地址
- 上次交易时间
- 总资产
- GMGN
- 删除

具体说明：

### 1. 名字

直接显示 `displayName`，即：

- `人物名 + 地址别名`

例如：

- `testuser#7`
- `蓝月#2`

这样用户用浏览器原生搜索时，可以直接搜人物名，也可以直接搜 `#7`。

### 2. 地址

- 默认单行截断显示
- 支持点击复制
- 复制时始终使用完整原始地址

### 3. 上次交易时间

- 使用 `latestActivityAt`
- 为空时显示 `-`

### 4. 总资产

- 使用 `totalAssetUsd`
- 展示风格与人物页当前 USD 格式保持一致

### 5. GMGN

- 每行一个外链按钮
- 新标签页打开

### 6. 删除

- 删除按钮放在行尾
- 确认文案必须明确写出：
  - 删除的是地址
  - 不会删除人物

## 服务端接口设计

### 1. 新增地址列表接口

新增：

- `GET /api/addresses`

接口返回：

```ts
{
  ok: true;
  rows: AddressManagementRow[];
}
```

该接口职责：

- 读取全部 tracked users / tracked addresses
- 以逻辑地址视角聚合行
- 直接返回地址页所需字段

前端不再自行完成：

- `EVM` 聚合
- `displayName` 拼接
- `latestActivityAt` 推导
- `gmgnUrl` 生成

### 2. 删除接口

删除动作继续复用现有：

- `DELETE /api/users/[id]/addresses`

地址页调用时：

- `id` 使用 `row.userId`
- body 只传 `address`
- 不传 `chain`

这样会自然复用现有 `removeTrackedAddress(userId, address)` 逻辑：

- 对 Solana 地址删除单条
- 对 EVM 地址一次性删除该地址对应的全部展开链记录

本次不新增第二套地址删除接口，避免语义分叉。

## 最新交易时间口径

`latestActivityAt` 本次统一从 `events` 表推导，口径固定为：

- 仅统计 `source = 'blockchain'`
- 使用 `MAX(timestamp)` 作为最新地址活动时间

匹配规则：

- Solana 地址：按 `chain = 'solana'` 且 `address = 原地址`
- EVM 逻辑地址：按 `chain IN ('bsc', 'ethereum', 'base')` 且 `LOWER(address) = addressLower`

这样可以带来两个好处：

- 直接复用现有 `events` 索引与时间语义
- “上次交易时间”与用户在主 feed 中看到的链上动态时间更一致

如果某地址没有链上事件：

- `latestActivityAt = null`

本次不为“上次交易时间”新增额外回填或修复任务。

## 资产口径

地址页的总资产沿用现有聚合规则：

- Solana 行：使用该地址自己的 `total_asset_usd`
- EVM 行：对 `bsc / ethereum / base` 三条地址记录求和

更新时间口径：

- `assetUpdatedAt` 取参与聚合地址记录中的最大值

这样可以和当前人物页的地址聚合显示保持一致。

## 导出行为

地址页提供“导出全部地址”按钮。

导出格式沿用当前项目的既有格式：

```txt
地址:人物名#地址别名
```

例如：

```txt
0xAbCd...:testuser#7
Aqa8H5...:蓝月#2
```

要求：

- 对 EVM 聚合地址只导出一行
- 不追加链后缀

这与当前 [`/Users/xp/vibecoding/pilipili/lib/addressBook.ts`](/Users/xp/vibecoding/pilipili/lib/addressBook.ts) 的导出口径保持一致。

## 人物页兼容策略

人物页本次不做大改，但应进行一项边界收敛：

- 不再把“地址展开列表”作为主要交互面

建议调整为：

- 保留地址数量
- 提供去地址页查看的入口或提示

本次不要求人物页继续承担：

- 浏览完整地址详情
- 作为地址复制 / 删除的首选入口

这样可以减少两个页面都在做地址主列表的重复。

## 客户端状态策略

地址页应直接从服务端获取 `GET /api/addresses` 结果，不依赖当前人物页的本地 `zustand` store。

原因：

- 地址页是服务端派生视图，不适合再从旧的本地人物数组拆一次
- 当前人物页存在本地数据与服务端自动回灌逻辑，地址页直接依赖本地 store 容易放大同步漂移

建议行为：

- 地址页首屏直接 fetch
- 删除成功后直接重新拉取全表，不做局部乐观更新

人物页保持当前 store 方案不动，等后续再决定是否进一步统一。

## 风险与兼容点

### 1. 本地 store 与服务端状态漂移

当前人物页使用 `useUsersDataStore` 并带有“本地数据回灌服务端”的兼容逻辑。新增地址页后，如果地址页再依赖本地 store 计算地址表，很容易出现：

- 新页删除成功，但人物页局部状态未刷新
- 两页同一地址数量显示不一致

所以本次明确：

- 地址页只信服务端平铺视图

### 2. EVM 地址重复展示

如果地址页直接读 `tracked_addresses` 而不做逻辑聚合，会把同一个 `0x` 地址展示成三行。

所以本次必须在服务端聚合后再返回。

### 3. GMGN 跳转不稳定

如果让 EVM 行的 GMGN 链根据“最近活动链”或“最后写入链”动态变化，用户会觉得同一行目标不稳定。

所以本次明确固定为：

- EVM -> `bsc`

### 4. 删除语义分叉

如果新地址页引入新的删除接口，很容易与现有 `removeTrackedAddress` 形成两套规则。

所以本次继续复用现有删除能力。

## 测试范围

本次验证只覆盖与页面拆分直接相关的行为。

### 1. 服务端

- 地址列表接口能返回平铺地址行
- 同一个 EVM 地址只返回一行
- `displayName` 格式为 `人物名 + 地址别名`
- `latestActivityAt` 能正确取最大链上时间
- `gmgnUrl` 对 EVM 行固定走 `bsc`

### 2. 人物页

- 仍能批量导入人物
- 仍能手动新建人物
- 仍能显示人物资产与活跃度
- 仍能删除人物

### 3. 地址页

- 能显示平铺地址列表
- 能复制地址
- 能导出全部地址
- 能打开 GMGN
- 能删除地址
- 删除后若该人物已无地址，人物记录仍存在

## 实施边界

本次 spec 对应的实现只覆盖：

- 顶部导航新增地址入口
- 新增地址页
- 新增地址列表接口
- 人物页与地址页职责边界调整

本次不顺带做：

- 地址页高级筛选
- 地址页排序体系大改
- 人物页彻底改成纯服务端驱动
- 人物与地址资源的彻底 API 重构

## 结论

本次最合适的路线是：

- 保留现有存储
- 拆分页面入口
- 让地址页使用服务端平铺视图承接 BID2 当前可接受的地址管理体验

这样可以在最小改动范围内，先把“人物管理”和“地址管理”的认知边界拆开，同时避免过早把项目拉进一轮高风险的数据模型重构。
