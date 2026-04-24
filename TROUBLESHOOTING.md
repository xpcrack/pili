# Web3动态看板数据不显示问题排查和修复

## 问题描述

用户报告前端显示库里有4518条合格动态，但前端一条都没刷出来。

## 问题根因分析

经过深入代码分析，发现问题的根源在于**过于严格的双重投毒过滤机制**：

### 1. 服务端过滤 (`lib/server/feedSnapshotRepo.ts`)

在数据从SQLite返回给API之前，会执行"Sender Fan-out"检测：

```typescript
const suspiciousSenderKeys = new Set(
  Array.from(senderFanOutStats.entries())
    .filter(([, value]) =>
      value.transferCount >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS &&  // >= 3
      value.recipientAddresses.size >= SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS  // >= 3
    )
    .map(([key]) => key)
);
```

**触发条件**：
- 交易类型为 `receive`（接收）
- 标记为 `uncertainFrom: true`（来源不确定）
- 同一发送方发送给 >= 3 个不同接收方
- 每个接收方收到 >= 3 次交易

### 2. 前端过滤 (`hooks/useActivityPolling.ts`)

前端在接收到API数据后，会再次执行类似的过滤逻辑。

### 3. 问题场景

如果用户的4518条动态都来自同一个DEX聚合器地址（如PancakeSwap路由器），这个地址发送给>=3个不同用户，且每个用户接收>=3次，**所有数据都会被过滤掉**。

## 修复方案

### 已实施的修复

#### 1. 添加调试日志

**服务端** (`lib/server/feedSnapshotRepo.ts`):
```typescript
console.log('[readFeedSnapshot] Poison filtering stats:', {
  feedBeforeFilter: feed.length,
  suspiciousSendersCount: suspiciousSenderKeys.size,
  feedAfterFilter: filteredFeed.length,
  filteredCount: feed.length - filteredFeed.length,
  sampleSuspiciousSenders: Array.from(suspiciousSenderKeys).slice(0, 3),
});
```

**前端** (`hooks/useActivityPolling.ts`):
```typescript
const poisonFilteredFeed = filterPoisonFromFeed(mergedFeed);
if (poisonFilteredFeed.length !== mergedFeed.length) {
  console.warn('[fetchActivities] 客户端投毒过滤统计:', {
    feedBeforeFilter: mergedFeed.length,
    feedAfterFilter: poisonFilteredFeed.length,
    filteredCount: mergedFeed.length - poisonFilteredFeed.length,
  });
}
```

#### 2. 创建诊断API端点

新建 `app/api/diagnostics/route.ts`，提供详细的过滤统计信息：

```bash
GET /api/diagnostics
```

返回数据包括：
- 数据库总记录数
- API返回的过滤前后数据量
- 可疑发送方数量和示例
- 被过滤的交易样本
- 数据库统计信息（按交易类型分布）

#### 3. 添加环境变量控制过滤

**服务端和前端都支持**:
```bash
DISABLE_POISON_FILTER=true
```

设置此环境变量后，会跳过所有投毒过滤逻辑，用于验证是否是过滤导致的问题。

#### 4. 创建前端调试面板

新建 `components/FeedDebugPanel.tsx`，集成到 `app/page.tsx` 中，提供：
- 数据库记录数 vs API返回数
- 服务端过滤统计
- 可疑发送方列表
- 被过滤的交易示例
- 调试建议

### 验证步骤

1. **检查控制台日志**:
   - 查看服务端日志中的 `[readFeedSnapshot]` 统计信息
   - 查看浏览器控制台中的 `[fetchActivities]` 和客户端过滤统计

2. **访问诊断API**:
   ```bash
   curl http://localhost:3000/api/diagnostics
   ```

3. **临时禁用过滤验证**:
   ```bash
   DISABLE_POISON_FILTER=true npm run dev
   ```
   重启后查看数据是否正常显示

4. **使用前端调试面板**:
   - 点击页面右下角的 "🔍 调试信息" 按钮
   - 查看详细的过滤统计和建议

## 后续优化建议

### 1. 调整过滤阈值

当前阈值可能过于严格，建议：
- 将 `SNAPSHOT_POISON_SENDER_FANOUT_MIN_RECIPIENTS` 从 3 调高到 5 或更高
- 将 `SNAPSHOT_POISON_SENDER_FANOUT_MIN_TRANSFERS` 从 3 调高到 5 或更高

### 2. 添加白名单机制

为已知的合法地址（如DEX聚合器）添加白名单：
```typescript
const KNOWN_DEX_ADDRESSES = new Set([
  'bsc|0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap Router
  // ... 其他DEX地址
]);
```

### 3. 改进过滤逻辑

不只看发送数量，还要考虑：
- 交易金额（过滤小额垃圾交易）
- 时间间隔（短时间内大量相似交易）
- 代币类型（可疑代币标记）
- 合约交互（DEX交易的gas模式）

### 4. 添加用户反馈机制

允许用户：
- 标记"这不是垃圾交易"
- 查看被过滤的交易并决定是否显示
- 为特定地址添加白名单

### 5. 智能DEX识别

通过以下特征识别DEX交易：
- 合约调用模式
- Gas使用模式
- Token交换特征
- 多跳路由特征

## 修改的文件

1. `lib/server/feedSnapshotRepo.ts` - 添加调试日志和环境变量控制
2. `hooks/useActivityPolling.ts` - 添加客户端过滤统计日志
3. `app/api/diagnostics/route.ts` - 新建诊断API端点
4. `components/FeedDebugPanel.tsx` - 新建前端调试面板
5. `app/page.tsx` - 集成调试面板

## 预期效果

完成修复后：
- 用户可以清楚看到数据被过滤的原因
- 可以通过环境变量临时禁用过滤来验证问题
- 调试面板提供直观的过滤统计和修复建议
- 为后续优化过滤逻辑提供数据支持

## 立即行动

用户现在可以：

1. **重启开发服务器**并查看控制台日志
2. **访问** `http://localhost:3000/api/diagnostics` 查看详细统计
3. **点击页面右下角**的调试按钮查看前端面板
4. **设置** `DISABLE_POISON_FILTER=true` 验证数据是否显示
5. 根据诊断结果调整过滤逻辑或添加白名单