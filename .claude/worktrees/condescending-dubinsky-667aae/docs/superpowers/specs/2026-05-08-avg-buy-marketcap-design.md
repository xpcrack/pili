# 人物表格新增"买入市值"列

管理页 `/manage` 表格新增一列，展示近 7 天该人物建仓/加仓时的平均代币市值。

## 设计决策

- **方案**：复用现有 `/api/users/activity-stats` API，在 SQL 中新增聚合列
- **不采用**：独立 API 端点（方案 B）、入库预计算列（方案 C）

## 数据计算逻辑

- **数据源**：`events` 表 `metadata_json`
- **筛选条件**：
  - `source = 'blockchain'`
  - `txActionVariant IN ('open', 'add')` — 建仓 + 加仓
  - `marketCapAtTxUsd IS NOT NULL AND > 0` — 排除无市值数据的交易
- **计算**：`AVG(marketCapAtTxUsd)`，仅对符合条件的交易求平均
- **时间窗口**：7 天（复用 `sinceMs`）
- **无数据**：返回 `null`，前端显示 `—`

## API 变更

**文件**：`app/api/users/activity-stats/route.ts`

- `ActivityStatsRow` 接口新增 `avg_buy_market_cap_7d: number | null`
- SQL 新增聚合列：
  ```sql
  AVG(
    CASE
      WHEN timestamp >= ?
        AND source = 'blockchain'
        AND json_extract(metadata_json, '$.txActionVariant') IN ('open', 'add')
        AND json_extract(metadata_json, '$.marketCapAtTxUsd') IS NOT NULL
        AND CAST(json_extract(metadata_json, '$.marketCapAtTxUsd') AS REAL) > 0
      THEN CAST(json_extract(metadata_json, '$.marketCapAtTxUsd') AS REAL)
    END
  ) AS avg_buy_market_cap_7d
  ```
- `.all()` 调用新增第 4 个 `sinceMs` 参数
- 输出新增 `avgBuyMarketCap7d: row?.avg_buy_market_cap_7d ?? null`

## 前端变更

**文件**：`app/manage/page.tsx`

- `UserActivityStats` 接口新增 `avgBuyMarketCap7d: number | null`
- `ManageSortKey` 新增 `'avgBuyMarketCap7d'`
- 排序逻辑中 null 用 `?? -1` 参与排序，排在最后
- 表头新增"买入市值"列（位于"近7天总动态"之后），带排序切换
- 数据单元格：`formatUsdCompact(avgBuyMarketCap7d)`，null 显示 `—`
- 地址编辑展开行 `colSpan` 从 10 改为 11

## 涉及文件

| 文件 | 变更类型 |
|------|---------|
| `app/api/users/activity-stats/route.ts` | 修改 |
| `app/manage/page.tsx` | 修改 |

## 不涉及

- 无需数据库迁移
- 无需新建 API 端点
- 无需修改 `events` 表结构或入库逻辑
- 不影响现有字段和排序行为
