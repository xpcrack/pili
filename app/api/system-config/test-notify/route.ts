import { NextRequest } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { readSystemConfig } from '@/lib/server/systemConfigRepo';
import { sendTelegramTextMessage } from '@/lib/server/telegramNotify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const rateLimitResponse = enforceAdminRateLimit(request, {
    endpoint: 'system-config-test-notify',
    max: 6,
    windowMs: 60_000,
  });
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    const config = readSystemConfig();
    const chatId = config.telegramUnknownPersonAlertChatId?.trim() || '';

    if (!chatId) {
      return apiError('请先填写并保存通知群 Chat ID，再测试通知。', { status: 400 });
    }

    const nowText = new Date().toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });

    const result = await sendTelegramTextMessage({
      chatId,
      text: `[pilipili] 通知测试\n时间: ${nowText}\n状态: 正常`,
    });

    if (result.ok) {
      return apiOk();
    }

    if (result.reason === 'missing_bot_token') {
      return apiError(
        '缺少 TELEGRAM_RELAY_BOT_TOKEN 或 TELEGRAM_BRIDGE_BOT_TOKEN，无法发送测试通知。',
        { status: 500 }
      );
    }

    if (result.reason === 'invalid_payload') {
      return apiError('通知参数无效，请检查 Chat ID。', { status: 400 });
    }

    const detailSuffix = result.detail ? `: ${result.detail}` : '';
    const message =
      typeof result.status === 'number'
        ? `Telegram 请求失败（HTTP ${result.status}）${detailSuffix}`
        : 'Telegram 请求失败';
    return apiError(message, { status: 502 });
  } catch (error) {
    return apiError(error, { fallback: '测试通知发送失败' });
  }
}
