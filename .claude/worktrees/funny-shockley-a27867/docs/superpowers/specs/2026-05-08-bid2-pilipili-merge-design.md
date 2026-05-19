# BID2 → pilipili 合并:第一刀「代币」工作台

## 背景

`vibecoding/` 下两个兄弟项目长期独立运行,但已经在通过同步契约对接(`BID2/backend/src/services/pilipiliClient.ts`、`pilipiliEventSyncService.ts` 等;反向 `pilipili/lib/server/bidSyncNotifier.ts`、`bidTradeExport.ts`)。两个产品的真实定位:

| | pilipili (web3-dashboard) | BID2 (memecoin-monitor) |
|---|---|---|
| 视角 | "刚刚发生了什么" | "我盯的这一篮子怎么样" |
| 入口实体 | 事件 / 活动 | 代币 |
| 时间维度 | 实时(分钟级) | 历史(小时-天-周) |
| 数据流 | 事件源 | 事件消费方 + 代币聚合层 |
| 用户模型 | 单管理员(telegram approval bot) | 多用户 + Workspace + ApiKey |
| 栈 | Next.js + better-sqlite3 + gramJS + shadcn | Express + Mongoose + grammy + Vite/Chakra |

用户在两个产品间**交叉切换使用**——这是合并的强信号。

## 一句话定位

把 pilipili 升级成「一个 web3 信息追踪工作台,最终从代币 / 事件 / 地址三种入口都能穿透」。BID2 的代币模块逐步内化进来,完成后 BID2 退役。

## 战略

- **渐进 strangler**:沿现有同步契约做边界,把 BID2 的 Workspace/Token/Trade 聚合层逐步内化进 pilipili,跨进程同步换成内部函数调用
- **BID2 冻结**:打 git tag `bid2-frozen-2026-05-08`,停掉 PM2,代码留盘做参考真相,直到对应模块都迁完
- **不迁 Mongo**:历史数据可丢;tag/合约地址等"手输"用 BID 自带的 backup export 一次性喂给 pilipili
- **每一刀独立可发布**:第一刀完成后即可让用户日常代币管理告别 BID

## 产品定位草图

合并后的产品:**单用户、单产品、三入口**。

- **入口**:代币列表(`/tokens`)、活动 feed(已有)、地址簿(已有)
- **桥梁实体**:代币、地址(三视图共享同一份 SQLite 数据)
- **穿透**(终态,不在第一刀内):代币 ↔ feed 事件 ↔ 地址 任意两点直达,无需切换产品

## 第一刀范围:「代币」工作台

**目标**:替代 BID 在"代币组合管理"场景的日常使用。完成后用户管代币不再开 BID。

### Goals

- pilipili 主导航新增 tab「代币」,路由 `/tokens`
- 单页 `TokenTable`(忠实复刻 BID 主交互),每行 = 合约 / 链 / tags / 实时价格 / 24h 涨跌 / 市值 / 7d sparkline
- 顶部:SearchBar、PresetBar(过滤预设)、ImportExport、Refresh
- 行级动作:刷新单代币 / 删除 / 编辑 tags
- 导入导出**直接复用 BID 两套格式**(无新发明):
  - 纯文本:`合约地址-tag1 tag2 tag3` 一行一个(BID `tokens.txt` 形式)
  - JSON backup:`{ version, addresses[], tokens[] }` 整库导入(BID `/backup/export` 形式)
- 价格 / 市值实时拉 DexScreener,内存短 TTL 缓存

### Non-goals(第一刀不做)

- HoldersModal、HoldingsModal、WhaleNetWorthModal、PersonHoldingsModal、TagStats 等所有深度 Modal —— 留给第二刀
- 任何穿透链接(代币 ↔ feed ↔ 地址)—— 留给第三刀
- KOL 分析、wallet 发现、Sherlock、whale net worth —— 留给后续刀
- API key、多用户、Workspace、`WorkspaceMember`、`WorkspaceUserBinding` 等多用户模型 —— **永久放弃**(单用户产品不需要)
- grammy bot —— 永久放弃,pilipili 已有 telegram approval bot
- Mongo 历史数据迁移工具 —— 用 BID `backup export` 一次性导入即可
- CoinGecko、OKX、BigQuery 数据源 —— 第一刀只接入 DexScreener

## 数据模型(SQLite)

对齐 BID"只持久化手输"的设计——价格/市值/holders 全部不入库,实时从 DexScreener 拉:

```sql
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  tags TEXT,                          -- 空格分隔 tag 串,与 BID 一致
  imported_at INTEGER NOT NULL,
  UNIQUE(chain, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_tokens_imported_at ON tokens(imported_at DESC);
```

注意:**tags 是纯字符串**,不升级为独立实体。这是用户决定,匹配 BID 当前形态。如果未来需要 TagStats 类聚合,届时再迁移。

## 模块结构

新增的代码集中在两处:

```
app/tokens/
  page.tsx                          ← TokenTable 主页
  api/
    tokens/
      route.ts                      ← GET 列表 / POST 增 / DELETE 批量
      [id]/route.ts                 ← PATCH tags / DELETE 单个 / POST refresh
      bulk-import/route.ts          ← 复刻 BID `/tokens/bulk-import`
      bulk-export/route.ts          ← 复刻 BID `/tokens/bulk-export`
    backup/
      import/route.ts               ← 复刻 BID `/backup/import`
      export/route.ts               ← 复刻 BID `/backup/export`

components/tokens/
  TokenTable.tsx                    ← 主表格
  ImportExport.tsx                  ← 导入导出弹窗
  PresetBar.tsx                     ← 过滤预设
  TagInput.tsx                      ← tag 编辑

lib/
  tokenList.ts                      ← 客户端调用 + 状态(沿用 pilipili zustand 风格)
  server/
    tokensRepo.ts                   ← SQLite CRUD
    dexscreener.ts                  ← 价格服务,移植 BID priceService 相关 API
    tokenBackup.ts                  ← BID JSON backup 解析与导入
    bulkTextParser.ts               ← `合约地址-tag1 tag2` 文本解析
```

## 价格服务

新建 `lib/server/dexscreener.ts`,从 BID `BID2/backend/src/services/priceService.ts` 移植以下能力:

- `getTokensByAddresses(chain, addresses[])` → 批量查询(`/dex/tokens/{addresses}`)
- `getTokenDetail(chain, address)` → 单代币详情(含价格、24h 变化、流动性)
- `getMarketCap(chain, address)` → 市值聚合(从 dexscreener 主交易对推算)

**缓存策略**:内存 LRU,TTL 30s。第一刀不做持久化缓存表(BID 的 `WhaleNetWorthCache`、`ContractCache`、`TokenTransferCache` 等不迁)。

**429/失败处理**:沿用 BID 的 `withRetry` 风格,但简化为 axios + p-retry 或自实现的指数退避;不引入 BID 的整套队列(`refreshQueueService.ts`)。第二刀如有需要再做。

## 导入导出

复用 BID 现有格式,**不发明新格式**。

### 纯文本(`/tokens/bulk-import`、`/tokens/bulk-export`)

格式来源:`BID2/backend/src/controllers/tokenController.ts:1362` 的 `bulkExport`。

```
0xAAAA...AAAA-bluechip stable
0xBBBB...BBBB-meme highrisk
0xCCCC...CCCC
```

每行 `合约地址-tag1 tag2 tag3`,没 tag 就只有合约地址。**链信息不在文本里**——导入对话框需要显式选目标链(默认 `solana`,记忆用户上次选择,localStorage 持久化)。

### JSON backup(`/backup/import`、`/backup/export`)

格式来源:`BID2/backend/src/controllers/backupController.ts` 的 `BackupData` 接口。

```ts
interface BackupData {
  version: string;            // '1.0'
  createdAt: string;          // ISO timestamp
  data: {
    addresses: Array<{
      address: string;
      name: string;
      chain: string;
      tokenCosts?: Record<string, number>;
      isManuallyInactive?: boolean;
    }>;
    tokens: Array<{
      contractAddress: string;
      chain: string;
      tags: string[];
    }>;
  };
}
```

**导入逻辑**:
- `tokens[]` → 写入 pilipili `tokens` 表(空格 join `tags` 数组)
- `addresses[]` → 写入 pilipili 现有 `tracked_addresses` 表(已存在,需要字段映射:`address` → `address`、`name` → `label`、`chain` → `chain`、`tokenCosts` → 第一刀忽略、`isManuallyInactive` → 第一刀忽略)
- 重复时:`UNIQUE(chain, contract_address)` 触发 `INSERT OR IGNORE`,保留旧数据

**导出逻辑**:对称生成相同 schema,以便与 BID 互导(虽然 BID 不再写入,但格式兼容方便回滚验证)。

## UI 形态(忠实复刻 BID)

参考 `BID2/frontend/src/components/TokenTable.tsx` 与 `App.tsx`,但用 pilipili 的 shadcn + Tailwind + zustand 重写。

**列**:
1. 复选框(批量选择)
2. 合约地址(短显示 `0x12...3456`,点复制)
3. 链 badge(`solana` / `bsc` / `eth` 等)
4. tags(`TagInput` 组件,inline 编辑)
5. 价格(USD,实时)
6. 24h 涨跌(色彩 +/-)
7. 市值
8. 7d sparkline(从 dexscreener `priceChange.h24` + 历史快照,简单 SVG)
9. 行操作(刷新 / 删除)

**过滤**:
- SearchBar 模糊匹配合约 / tag
- PresetBar 保存的 tag 组合(localStorage,与 pilipili 现有 PresetBar 风格对齐)

**不**复刻的 BID UI 元素(留给后续刀):
- ColumnSettings(列定制)—— 第一刀列固定
- HoldersModal、HoldingsModal、WhaleNetWorthModal、PersonHoldingsModal —— 第二刀
- TagStats —— 第二刀,有需要再做
- ApiKeyManager —— 永久不做

## 完成标准(第一刀)

可发布的判定:

1. **数据迁移**:用户从 BID 一键 `backup export` → 在 pilipili `/tokens` 一键导入,看到所有代币 + tag 出现在表格里
2. **增量管理**:粘贴新合约地址(纯文本格式)能正确添加,实时拉 DexScreener 显示价格
3. **过滤与编辑**:能按 tag 过滤,能编辑某代币的 tag 立即生效
4. **价格新鲜度**:列表打开时所有可见代币 ≤30s 内有最新价格
5. **使用替代**:用户连续 7 天**不再为代币管理打开 BID**

## 后续刀方向(不在本设计内)

- **第二刀**:深度 Modal 移植(holders / holdings / whale net worth);需要新建 `WhaleNetWorthCache` 等持久化表
- **第三刀**:穿透链接
  - 代币行点合约地址 → 跳 pilipili 现有 activity feed,过滤为该代币
  - feed 卡片代币站点 → 跳 `/tokens`,过滤为该代币
  - 地址簿点地址 → 跳 feed 过滤;地址持仓页与代币交叉
- **第四刀**:KOL 分析、wallet 发现等高级模块按需迁
- **终点**:确认 BID 全部活跃功能已迁,删除 BID2 仓库 / 移到 archive,撤掉 PM2 配置,删除 pilipili 里的 `bidSyncNotifier` / `bidTradeExport` 等遗留 export 端

## 关键决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 合并方向 | BID 内化进 pilipili | pilipili 是事件源,BID 是消费方;反向不合理 |
| 迁移节奏 | strangler / 渐进 | 一次性重写风险大,且要"保存当前 BID 状态"分批迁更稳 |
| 多用户 | 永久放弃 | 用户明确说"单产品单用户" |
| 数据迁移 | 不迁 Mongo,用 BID backup 文件 | Mongo 数据多为可重新计算的链上缓存 |
| 第一刀 UI | 复刻 BID 表格 + Modal | 用户熟悉 BID 形态;后期可迭代 |
| 数据模型 | 只存手输,价格不入库 | 与 BID 当前一致,简化最大 |
| tag 模型 | 纯字符串 | 用户明确"跟 BID 一样,纯 tag 串" |
| 第一刀穿透 | 不做 | 用户明确"第一刀不做穿透" |
| 价格源 | 仅 DexScreener | 用户确认"不换" |

## 风险

- **DexScreener 速率限制**:第一刀仅有最简内存缓存,大量代币(>200)同时刷新可能 429。**缓解**:批量端点优先(`/dex/tokens/A,B,C,...`),前端按 chain 分组批量请求
- **BID JSON backup 与 pilipili 现有 `tracked_addresses` 字段映射不全**:`tokenCosts`、`isManuallyInactive` 暂时丢弃,可能用户之后发现需要。**缓解**:导入时把原始 JSON 完整副本写入 `tracked_addresses.import_payload_json`(冗余字段),后续刀如要恢复可直接读
- **过渡期重复代码**:第一刀完成后,pilipili 的 `bidSyncNotifier` / `bidTradeExport` 仍在跑(给已停的 BID 推数据),无害但浪费。**缓解**:终点刀统一删除
- **价格服务移植回归**:BID `priceService.ts` 长期演化,有许多边界处理(链识别、稳定币过滤、流动性兜底)。**缓解**:第一刀只移植列表显示需要的部分,边界用例在第二刀按需补
