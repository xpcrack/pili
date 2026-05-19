# Telegram Agent Read Authorization Design

## Goal

为 `pilipili` 增加一套“Telegram 审批群授权 + MTProto 只读 CLI”方案，让用户可以只通过 Telegram 群内交互，为某个外部 agent 签发对单个已加入群/频道的只读访问权限，而不需要分发 `TELEGRAM_SESSION_STRING`，也不需要预先在系统里登记长期白名单。

## Problem

当前仓库已经具备两类 Telegram 能力：

- 使用 Bot API 的 bridge / notify 链路。
- 使用 MTProto + GramJS 的 user session 读取频道/聊天消息。

但这两条链路都不适合直接交给别的 agent 使用：

- 直接给 agent `.env.local` 或 session string 风险过大。
- 直接暴露通用 MTProto CLI 没有权限边界，agent 可以改参数读别的群。
- 预登记长期 `chatId` 白名单虽然可行，但用户流程偏长，不适合临时授予某个 agent 访问某个群的权限。

用户希望把交互收敛到 Telegram 内完成：

1. 用户自己的 Telegram 账号先加入目标群。
2. 用户在专门的审批群里发送目标 `chatId`。
3. 机器人引导用户补充一个易记的 `agentName`。
4. 机器人返回 `chatId + token + CLI 用法`。
5. 用户把这组信息交给别的 agent，agent 只能读取被授权的那个群。
6. 用户可以在审批群里查看“当前有哪些 agent 能访问哪些群”，并手动关闭授权。

## Requirements

### Functional

1. 允许用户在固定审批群里通过命令创建授权，不要求预登记长期 `chatId` 白名单。
2. 授权流程采用两步交互：
   - `/grant <chatId>`
   - `/agent <name>`
3. 每条正式授权绑定单个 `agentName + chatId`。
4. 机器人返回一枚只读 token，以及固定格式的 CLI 调用示例。
5. agent 只能通过 token 访问被绑定的单个 `chatId`。
6. 首版 CLI 仅支持 `tail` 和 `search` 两个只读动作。
7. 支持在审批群里查看当前授权：
   - 查看所有 agent -> chats 映射
   - 按 agent 查看
   - 按 chat 查看
8. 支持在审批群里撤销某个 `agentName + chatId` 授权。
9. 同一个 `agentName + chatId` 再次授权时，应轮换 token，并使旧 token 立即失效。
10. 每次 CLI 调用都要记录审计日志。

### Non-Functional

1. 不暴露 `TELEGRAM_SESSION_STRING` 或 `.env.local` 给外部 agent。
2. 不影响现有 `telegram-bridge`、`telegram-channel-sync`、通知发送等链路。
3. 不要求新建前端页面，控制面全部留在 Telegram 审批群。
4. 延续现有 SQLite、worker status、脚本式运行模式。
5. 对外 CLI 必须稳定输出 JSON，便于 agent 程序化消费。

## Fixed Inputs

- 审批群 `chatId`：`-5130530086`
- 审批 bot：使用 `tgbot_out_token` 对应机器人（当前为 `@xpcrack_god_bot`）
- MTProto 读取账号：沿用现有 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`、`TELEGRAM_SESSION_STRING`
- 授权默认 scope：`search,tail`
- 首版不设置 token 过期时间，由用户手动撤销

## Constraints

- Telegram Bot API 无法替代 MTProto 读取已加入群/频道历史，因此 CLI 最终仍需走当前 user session。
- 如果外部 agent 对同一台机器拥有完全文件读取或任意 shell 权限，本方案只能提供“受限 CLI 边界”，不能提供强隔离。
- 审批 bot 必须只在固定审批群中响应授权命令，并限制为特定管理员发送。
- 首版不做评论线程抓取、媒体下载、复杂检索 DSL、自然语言 bot 对话。

## Approaches Considered

### 方案 A：只靠 `chatId + CLI 用法`

优点：

- 实现最轻
- 用户步骤最少

缺点：

- 没有真实权限边界
- agent 改参数即可尝试读取其他群
- 无法回答“哪些 agent 现在能访问哪些群”

### 方案 B：Telegram 审批群签发持久授权 token

优点：

- 无需预登记长期 `chatId`
- 保留可校验的边界
- 支持查看授权、撤销授权、轮换 token、记录审计
- 完整符合用户希望的 Telegram 内交互模型

缺点：

- 需要新增少量状态表和 bot worker

### 方案 C：本地常驻服务 + Telegram 审批 token

优点：

- 运行时隔离更强

缺点：

- 复杂度更高
- 当前需求下属于过度设计

### Recommendation

采用方案 B：Telegram 审批群签发持久授权 token，配合只读 CLI。

## Architecture

整体分成四层：

1. **审批 bot worker**
   - 使用 `tgbot_out_token`
   - 通过 Bot API long polling 监听审批群命令
   - 管理待完成授权与正式授权

2. **授权存储层**
   - 使用 SQLite 保存 pending grant、active/revoked grant、审计日志
   - token 仅保存哈希，不保存明文

3. **agent CLI**
   - 提供 `tail` / `search`
   - 先验 token，再调用 MTProto 读消息
   - 统一输出 JSON

4. **MTProto 读取层**
   - 复用现有 GramJS client 与 Telegram session
   - 补充“按 chat 读取最近消息”和“按 chat 搜索消息”的只读能力

## Command Flow

### 授权创建

1. 用户在审批群发送：

```text
/grant -1001234567890
```

2. bot 校验：
   - 消息来自审批群 `-5130530086`
   - 发送者在管理员白名单
   - `chatId` 为有效数字格式

3. bot 创建一条 pending grant，并回复：

```text
已记录目标群:
-1001234567890

请继续发送:
/agent <name>

示例:
/agent researcher-a
```

4. 用户发送：

```text
/agent researcher-a
```

5. bot 为 `researcher-a + -1001234567890` 创建或轮换正式授权，返回：
   - `agentName`
   - `chatId`
   - `scope`
   - `token`
   - CLI 示例

### 授权查看

- `/access`
- `/access agent researcher-a`
- `/access chat -1001234567890`

### 授权撤销

- `/revoke researcher-a -1001234567890`

### 草稿辅助

- `/pending`
- `/cancel`

## Bot Behavior Details

### `/grant <chatId>`

- 每个审批人同时仅保留一条 `waiting_agent_name` 状态的 pending grant
- 新的 `/grant` 会覆盖该审批人上一条未完成草稿
- 仅记录目标群，不立即签发 token

### `/agent <name>`

- 只消费“当前消息发送者自己最近一条 pending grant”
- 若无 pending grant，则提示先执行 `/grant <chatId>`
- `agentName` 规则：
  - 允许字母、数字、`-`、`_`
  - 长度 2 到 40
- 同一个 `agentName + chatId` 已存在时：
  - 生成新 token
  - 更新 tokenHash / tokenPreview
  - 旧 token 立即失效

### `/access`

- 默认按 `agentName` 分组展示当前 `active` 授权
- `agent` / `chat` 子查询返回精确过滤结果

### `/revoke <agentName> <chatId>`

- 将匹配的正式授权标记为 `revoked`
- 已撤销 token 的后续 CLI 调用全部失败

### 管理边界

- bot 只处理审批群 `-5130530086` 内的命令
- bot 只接受管理员白名单用户发送的授权类命令
- bot 不处理审批群外部的授权命令

## Data Model

### `telegram_agent_pending_grants`

用于保存“先发 chatId、后补 agentName”的草稿状态。

字段：

- `id`
- `approval_chat_id`
- `requested_chat_id`
- `requested_by_telegram_user_id`
- `requested_by_telegram_username`
- `status`
  - `waiting_agent_name`
  - `completed`
  - `cancelled`
- `created_at`
- `updated_at`

约束：

- 每个 `requested_by_telegram_user_id` 同时最多一条 `waiting_agent_name`

### `telegram_agent_grants`

保存正式授权。

字段：

- `id`
- `approval_chat_id`
- `agent_name`
- `chat_id`
- `scope_json`
- `token_hash`
- `token_preview`
- `status`
  - `active`
  - `revoked`
- `created_by_telegram_user_id`
- `created_by_telegram_username`
- `created_at`
- `updated_at`
- `revoked_at`
- `revoked_by_telegram_user_id`
- `last_used_at`
- `use_count`

约束：

- `(agent_name, chat_id)` 逻辑唯一
- 同一组合重复授权时更新记录并轮换 token

### `telegram_agent_grant_reads`

保存 CLI 使用审计。

字段：

- `id`
- `grant_id`
- `agent_name`
- `chat_id`
- `command`
  - `tail`
  - `search`
- `scope`
- `query`
- `limit_value`
- `result_count`
- `success`
- `error_code`
- `used_at`

## Token Strategy

- token 使用高熵随机字符串
- 仅在 bot 回复时明文展示一次
- 数据库只保存 `token_hash`
- CLI 调用时对入参 token 做相同哈希后查找授权记录
- 不设置自动过期时间
- 用户通过 `/revoke` 手动失效

## Admin Identity

需要一个显式管理员白名单来源，用于判断审批群里谁有权签发授权。首版建议使用环境变量：

- `TELEGRAM_APPROVAL_ADMIN_USER_IDS`

格式示例：

```text
TELEGRAM_APPROVAL_ADMIN_USER_IDS=123456789,987654321
```

后续如有需要再迁移到 SQLite 或 system config。

## CLI Design

新增脚本入口：

```text
npm run telegram:agent:read -- <subcommand> ...
```

### `tail`

示例：

```text
npm run telegram:agent:read -- tail --chat-id -1001234567890 --token <token> --limit 100
```

参数：

- `--chat-id` 必填
- `--token` 必填
- `--limit` 可选，默认 50，最大 200

### `search`

示例：

```text
npm run telegram:agent:read -- search --chat-id -1001234567890 --token <token> --query "sol" --limit 50
```

参数：

- `--chat-id` 必填
- `--token` 必填
- `--query` 必填
- `--limit` 可选，默认 20，最大 100

### JSON Response

成功响应示例：

```json
{
  "ok": true,
  "mode": "search",
  "chatId": "-1001234567890",
  "grant": {
    "agentName": "researcher-a",
    "scope": ["search", "tail"]
  },
  "items": []
}
```

失败响应示例：

```json
{
  "ok": false,
  "error": "grant_revoked"
}
```

错误码首版固定为：

- `invalid_token`
- `grant_not_found`
- `grant_revoked`
- `chat_mismatch`
- `scope_denied`
- `query_required`
- `telegram_auth_unavailable`
- `telegram_chat_unavailable`

## MTProto Read Behavior

### `tail`

- 按授权 `chatId` 拉取最近消息
- 返回消息基础字段：
  - `messageId`
  - `date`
  - `text`
  - `sender`

### `search`

- 优先使用 Telegram / GramJS 原生搜索能力
- 若某类 chat 的原生搜索结果不可用或不稳定，可回退为“扫描最近 N 条并本地匹配”
- JSON 响应中应显式标记本次使用的 `searchMode`

## Security and Limits

1. 单个 token 只能访问一个绑定 `chatId`
2. `tail` 最大 `limit = 200`
3. `search` 最大 `limit = 100`
4. 对同一条授权增加轻量节流，避免高频连续请求
5. agent CLI 不提供“列出所有已加入 chat”能力
6. token 泄露时，用户可通过 `/revoke` 立即失效

## Rollout

### Phase 1

- SQLite schema
- grant repo / audit repo
- 审批 bot worker
- `/grant`、`/agent`、`/access`、`/revoke`、`/pending`、`/cancel`
- agent CLI 的 `tail` / `search`
- MTProto 读取扩展

### Phase 2

- 更丰富的访问统计
- 更好的 bot 输出格式
- 可选的 token 过期 / 次数限制
- 更强的本地进程隔离

## Testing

1. repo 测试：
   - pending grant 的创建、覆盖、取消
   - 正式 grant 的创建、轮换、撤销
   - token hash 查找
2. bot 命令测试：
   - `/grant` -> `/agent` 两步流
   - `/access` 查询输出
   - `/revoke` 后旧 token 失效
3. CLI 测试：
   - token 校验
   - `chatId` 不匹配时报错
   - `search` / `tail` 参数边界
4. MTProto 集成测试：
   - 已授权 chat 的最近消息读取
   - 搜索结果映射
5. 审计测试：
   - 成功调用写入日志
   - 失败调用写入错误码

## Out of Scope

- 把 `TELEGRAM_SESSION_STRING` 共享给外部项目
- 前端授权管理页面
- Bot 自然语言理解
- 多 chat 打包授权到同一个 token
- 评论区线程抓取
- 媒体二进制下载
- 强进程隔离或独立本地服务
