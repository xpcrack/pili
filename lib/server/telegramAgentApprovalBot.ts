import 'server-only';

import { isTelegramApprovalAdmin } from '@/lib/server/telegramApprovalAdmin';
import {
  cancelPendingTelegramAgentGrantForUser,
  listActiveTelegramAgentGrants,
  readPendingTelegramAgentGrantForUser,
  revokeTelegramAgentGrant,
  savePendingTelegramAgentGrant,
  upsertTelegramAgentGrant,
} from '@/lib/server/telegramAgentGrantRepo';
import { generateTelegramAgentToken, hashTelegramAgentToken } from '@/lib/server/telegramAgentToken';

const TELEGRAM_APPROVAL_CHAT_ID = '-5130530086';
const DEFAULT_AGENT_SCOPE = ['search', 'tail'];

export interface HandleTelegramApprovalBotMessageInput {
  approvalChatId: string;
  text: string;
  fromUserId: string;
  fromUsername?: string | null;
  sendMessage: (input: { chatId: string; text: string }) => Promise<void>;
}

export interface HandleTelegramApprovalBotMessageResult {
  handled: boolean;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

function parseText(text: string) {
  const parts = normalize(text).split(/\s+/).filter(Boolean);
  const commandToken = normalize(parts[0] || '');
  const command = parseCommandToken(commandToken);
  const args = parts.slice(1);
  return { command, args };
}

function parseCommandToken(commandToken: string) {
  if (!commandToken.startsWith('/')) {
    return '';
  }

  if (commandToken.includes('@')) {
    return '';
  }

  return normalize(commandToken.slice(1)).toLowerCase();
}

function isValidTelegramChatId(chatId: string) {
  return /^-?\d+$/.test(normalize(chatId));
}

function isValidAgentName(agentName: string) {
  return /^[A-Za-z0-9_-]{2,40}$/.test(normalize(agentName));
}

async function sendReply(
  sendMessage: HandleTelegramApprovalBotMessageInput['sendMessage'],
  text: string
) {
  await sendMessage({
    chatId: TELEGRAM_APPROVAL_CHAT_ID,
    text: normalize(text),
  });
}

function formatAccessRows() {
  const active = listActiveTelegramAgentGrants();
  if (active.length === 0) {
    return 'active chats: (empty)';
  }

  const lines = ['active chats:'];
  for (const grant of active) {
    lines.push(
      `- ${grant.agentName} @ ${grant.chatId} [${grant.scope.join(', ') || 'none'}] status=${grant.status}`
    );
  }
  return lines.join('\n');
}

export async function handleTelegramApprovalBotMessage(
  input: HandleTelegramApprovalBotMessageInput
): Promise<HandleTelegramApprovalBotMessageResult> {
  const approvalChatId = normalize(input.approvalChatId);
  if (approvalChatId !== TELEGRAM_APPROVAL_CHAT_ID) {
    return { handled: false };
  }

  const { command, args } = parseText(input.text);
  if (!command) {
    return { handled: false };
  }

  const supportedCommand =
    command === 'grant' ||
    command === 'agent' ||
    command === 'access' ||
    command === 'revoke' ||
    command === 'pending' ||
    command === 'cancel';
  if (!supportedCommand) {
    return { handled: false };
  }

  const fromUserId = normalize(input.fromUserId);
  if (!isTelegramApprovalAdmin(fromUserId)) {
    await sendReply(input.sendMessage, 'not allowed: 无权限执行该审批命令');
    return { handled: true };
  }

  if (command === 'grant') {
    const requestedChatId = normalize(args[0]);
    if (!isValidTelegramChatId(requestedChatId)) {
      await sendReply(input.sendMessage, '用法: /grant <chatId>');
      return { handled: true };
    }

    savePendingTelegramAgentGrant({
      approvalChatId: TELEGRAM_APPROVAL_CHAT_ID,
      requestedChatId,
      requestedByTelegramUserId: fromUserId,
      requestedByTelegramUsername: normalize(input.fromUsername) || null,
    });

    await sendReply(
      input.sendMessage,
      `已记录目标群:\n${requestedChatId}\n\n请继续发送:\n/agent <name>\n\n示例:\n/agent researcher-a`
    );
    return { handled: true };
  }

  if (command === 'agent') {
    const agentName = normalize(args[0]);
    if (!isValidAgentName(agentName)) {
      await sendReply(input.sendMessage, '用法: /agent <name>  (2-40, 仅字母/数字/-/_)');
      return { handled: true };
    }

    const pending = readPendingTelegramAgentGrantForUser(fromUserId);
    if (!pending) {
      await sendReply(input.sendMessage, '没有待完成的授权草稿，请先发送: /grant <chatId>');
      return { handled: true };
    }

    const token = generateTelegramAgentToken();
    const grant = upsertTelegramAgentGrant({
      approvalChatId: TELEGRAM_APPROVAL_CHAT_ID,
      agentName,
      chatId: pending.requestedChatId,
      scope: DEFAULT_AGENT_SCOPE,
      tokenHash: hashTelegramAgentToken(token),
      tokenPreview: token.slice(0, 8),
      createdByTelegramUserId: fromUserId,
      createdByTelegramUsername: normalize(input.fromUsername) || null,
    });
    cancelPendingTelegramAgentGrantForUser(fromUserId);

    await sendReply(
      input.sendMessage,
      [
        '授权已创建（若已有同名授权，旧 token 已失效）',
        `agent: ${grant.agentName}`,
        `chat: ${grant.chatId}`,
        `scope: ${grant.scope.join(', ') || 'none'}`,
        `token: ${token}`,
        '',
        'CLI 示例:',
        `npm run telegram:agent:read -- tail --chat-id ${grant.chatId} --token ${token} --limit 50`,
      ].join('\n')
    );
    return { handled: true };
  }

  if (command === 'access') {
    const scope = normalize(args[0]).toLowerCase();
    const value = normalize(args[1]);
    if (!scope) {
      await sendReply(input.sendMessage, formatAccessRows());
      return { handled: true };
    }

    if (scope === 'agent') {
      if (!value) {
        await sendReply(input.sendMessage, '用法: /access agent <agentName>');
        return { handled: true };
      }
      const grants = listActiveTelegramAgentGrants().filter((grant) => grant.agentName === value);
      if (grants.length === 0) {
        await sendReply(input.sendMessage, `active chats for agent ${value}: (empty)`);
        return { handled: true };
      }
      await sendReply(
        input.sendMessage,
        [`active chats for agent ${value}:`, ...grants.map((grant) => `- ${grant.chatId}`)].join('\n')
      );
      return { handled: true };
    }

    if (scope === 'chat') {
      if (!isValidTelegramChatId(value)) {
        await sendReply(input.sendMessage, '用法: /access chat <chatId>');
        return { handled: true };
      }
      const grants = listActiveTelegramAgentGrants().filter((grant) => grant.chatId === value);
      if (grants.length === 0) {
        await sendReply(input.sendMessage, `active chats for chat ${value}: (empty)`);
        return { handled: true };
      }
      await sendReply(
        input.sendMessage,
        [`active chats for chat ${value}:`, ...grants.map((grant) => `- ${grant.agentName}`)].join('\n')
      );
      return { handled: true };
    }

    await sendReply(input.sendMessage, '用法: /access | /access agent <name> | /access chat <chatId>');
    return { handled: true };
  }

  if (command === 'revoke') {
    const agentName = normalize(args[0]);
    const chatId = normalize(args[1]);
    if (!agentName || !isValidTelegramChatId(chatId)) {
      await sendReply(input.sendMessage, '用法: /revoke <agentName> <chatId>');
      return { handled: true };
    }

    const revoked = revokeTelegramAgentGrant({
      agentName,
      chatId,
      revokedByTelegramUserId: fromUserId,
    });
    if (!revoked || revoked.status !== 'revoked') {
      await sendReply(input.sendMessage, `未找到 active grant: ${agentName} @ ${chatId}`);
      return { handled: true };
    }

    await sendReply(input.sendMessage, `已撤销授权: ${agentName} @ ${chatId}`);
    return { handled: true };
  }

  if (command === 'pending') {
    const pending = readPendingTelegramAgentGrantForUser(fromUserId);
    if (!pending) {
      await sendReply(input.sendMessage, '当前没有待完成草稿');
      return { handled: true };
    }

    await sendReply(
      input.sendMessage,
      [`当前草稿:`, `chat: ${pending.requestedChatId}`, `下一步: /agent <name>`].join('\n')
    );
    return { handled: true };
  }

  const cancelled = cancelPendingTelegramAgentGrantForUser(fromUserId);
  await sendReply(input.sendMessage, cancelled ? '已取消当前草稿' : '当前没有待取消草稿');
  return { handled: true };
}
