# 前端调试组件

这个组件用于显示数据过滤统计信息，帮助诊断为何前端不显示数据。

## 使用方法

在 `app/page.tsx` 中引入并添加到页面：

```typescript
import { FeedDebugPanel } from '@/components/FeedDebugPanel';

// 在组件中添加
<FeedDebugPanel
  totalInDatabase={summary?.transactionCount || 0}
  apiFeedLength={feed.length}
  lastUpdate={lastUpdate}
/>
```

## 功能

1. 显示数据库中的总记录数
2. 显示API返回的feed数量
3. 显示最后更新时间
4. 点击可查看详细的过滤信息
5. 可访问诊断API `/api/diagnostics` 获取详细信息
6. 提供临时禁用过滤的功能（通过环境变量 `DISABLE_POISON_FILTER=true`）