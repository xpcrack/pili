# Pili TG 频道监控扩展需求

## 背景

当前 Pili 的 TG 监控硬编码了 2 个频道（`telegramTradeMonitorSourceChatId` + `telegramTwitterMonitorSourceChatId`）。需要扩展为支持 N 个频道，并区分两种频道类型。

## 频道类型

| channelType | 用途 | 频率 | 示例 |
|---|---|---|---|
| `news` | 新闻/快讯频道 | 极高（每天几十~上百条） | 方程式新闻、BWE、PANews、BlockBeats |
| `social` | KOL 个人频道 | 低（每天几条） | 个人加密博主的 TG 频道 |

两种类型在存储和查询上需要区分，方便后续分析时按类型过滤。

## 改动点

### 1. SystemConfigSnapshot（`lib/server/systemConfigRepo.ts`）

新增字段，保留旧字段做兼容迁移：

```typescript
export interface SystemConfigSnapshot {
  // 旧字段保留，读取时自动迁移到新格式
  telegramTradeMonitorSourceChatId: string | null;
  telegramTwitterMonitorSourceChatId: string | null;

  // 新字段
  telegramMonitoredChannels: TelegramMonitoredChannel[];
  // ...其他现有字段不变
}

export interface TelegramMonitoredChannel {
  chatId: string;
  channelType: 'news' | 'social';
  mode: 'telegram-monitor' | 'twitter-relay';
  label: string;           // 人类可读名称，如 "方程式新闻"
  enabled?: boolean;       // 默认 true，可临时禁用
}
```

**迁移逻辑**：`readSystemConfig()` 时，如果 `telegramMonitoredChannels` 为空但旧字段有值，自动转换为新格式填入。写入时只写新字段。

### 2. Backfill（`lib/server/telegramBridgeMtprotoBackfill.ts`）

当前 `targets` 硬编码 2 个。改为从 `config.telegramMonitoredChannels` 读取：

```typescript
const targets = (config.telegramMonitoredChannels || [])
  .filter(ch => ch.enabled !== false)
  .map(ch => ({
    chatId: ch.chatId,
    mode: ch.mode,
    channelType: ch.channelType,
  }));
```

### 3. Ingest（`lib/server/telegramMonitorIngest.ts`）

ingest 函数需要接收 `channelType` 参数，并在存储时写入 `channel_type` 字段。签名大致：

```typescript
export async function ingestTelegramMonitorUpdate(
  update: TelegramUpdateLike,
  channelType?: 'news' | 'social',  // 新增可选参数
)
```

### 4. DB Schema（`telegram_channel_posts` 表）

加一列：

```sql
ALTER TABLE telegram_channel_posts ADD COLUMN channel_type TEXT DEFAULT 'news';
```

已有数据默认为 `'news'`（因为现有的 trade monitor 频道属于新闻源）。

### 5. System Config API（`app/api/system-config/route.ts`）

API 需要支持读写 `telegramMonitoredChannels` 数组。PATCH 时如果传了新字段，写入新字段；如果只传旧字段，保持兼容。

### 6. Agent Read Service（`lib/server/telegramAgentReadService.ts`）

查询接口支持按 `channelType` 过滤：

```typescript
// 查询参数新增
channelType?: 'news' | 'social'
```

这样 Hermes Agent 查催化剂时可以 `WHERE channel_type = 'news'`，查 KOL 动态时 `WHERE channel_type = 'social'`。

## 不需要改的

- `telegram_channel_posts` 表的其他字段不变
- MTProto 客户端逻辑不变（只是多订阅几个频道）
- 前端 UI 暂不改（频道配置通过 API 或直接改 DB）

## 验证

1. 迁移：旧 config 读取后自动转为新格式，不丢数据
2. 新增频道：通过 API 添加一个 news 频道和一个 social 频道
3. Backfill：对新增频道执行 backfill，数据正确入库且 `channel_type` 正确
4. 查询：按 `channelType` 过滤返回正确结果
