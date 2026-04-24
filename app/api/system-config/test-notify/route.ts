import { NextRequest, NextResponse } from 'next/server';

import { enforceAdminRateLimit, requireAdmin } from '@/lib/server/apiGuard';
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
      return NextResponse.json(
        { ok: false, error: '请先填写并保存通知群 Chat ID，再测试通知。' },
        { status: 400 }
      );
    }

    const nowText = new Date().toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });

    const result = await sendTelegramTextMessage({
      chatId,
      text: `[pilipili] 通知测试\n时间: ${nowText}\n状态: 正常`,
    });

    if (!result.ok) {
      if (result.reason === 'missing_bot_token') {
        return NextResponse.json(
          { ok: false, error: '缺少 TELEGRAM_RELAY_BOT_TOKEN 或 TELEGRAM_BRIDGE_BOT_TOKEN，无法发送测试通知。' },
          { status: 500 }
        );
      }

      if (result.reason === 'invalid_payload') {
        return NextResponse.json({ ok: false, error: '通知参数无效，请检查 Chat ID。' }, { status: 400 });
      }

      return NextResponse.json(
        {
          ok: false,
          error:
            typeof result.status === 'number'
              ? `Telegram 请求失败（HTTP ${result.status}）${result.detail ? `: ${result.detail}` : ''}`
              : 'Telegram 请求失败',
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '测试通知发送失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
