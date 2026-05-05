import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    config: readSystemConfig(),
  });
}

export async function PATCH(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | {
          telegramUnknownPersonAlertChatId?: string | null;
          telegramTradeMonitorSourceChatId?: string | null;
          telegramTwitterMonitorSourceChatId?: string | null;
          conflictNotificationTelegramChatId?: string | null;
          completenessStartMs?: number | string | null;
          twitterRelayCoveredPollingIntervalMinutes?: number | string | null;
          twitterUncoveredPollingIntervalMinutes?: number | string | null;
        }
      | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ ok: false, error: '请求体必须是 JSON 对象' }, { status: 400 });
    }

    const config = saveSystemConfig({
      telegramUnknownPersonAlertChatId:
        body.telegramUnknownPersonAlertChatId === null
          ? null
          : typeof body.telegramUnknownPersonAlertChatId === 'string'
            ? body.telegramUnknownPersonAlertChatId
            : undefined,
      telegramTradeMonitorSourceChatId:
        body.telegramTradeMonitorSourceChatId === null
          ? null
          : typeof body.telegramTradeMonitorSourceChatId === 'string'
            ? body.telegramTradeMonitorSourceChatId
            : undefined,
      telegramTwitterMonitorSourceChatId:
        body.telegramTwitterMonitorSourceChatId === null
          ? null
          : typeof body.telegramTwitterMonitorSourceChatId === 'string'
            ? body.telegramTwitterMonitorSourceChatId
            : undefined,
      conflictNotificationTelegramChatId:
        body.conflictNotificationTelegramChatId === null
          ? null
          : typeof body.conflictNotificationTelegramChatId === 'string'
            ? body.conflictNotificationTelegramChatId
            : undefined,
      completenessStartMs:
        body.completenessStartMs === null
          ? null
          : typeof body.completenessStartMs === 'number' || typeof body.completenessStartMs === 'string'
            ? body.completenessStartMs
            : undefined,
      twitterRelayCoveredPollingIntervalMinutes:
        body.twitterRelayCoveredPollingIntervalMinutes === null
          ? ''
          : typeof body.twitterRelayCoveredPollingIntervalMinutes === 'number' ||
              typeof body.twitterRelayCoveredPollingIntervalMinutes === 'string'
            ? body.twitterRelayCoveredPollingIntervalMinutes
            : undefined,
      twitterUncoveredPollingIntervalMinutes:
        body.twitterUncoveredPollingIntervalMinutes === null
          ? ''
          : typeof body.twitterUncoveredPollingIntervalMinutes === 'number' ||
              typeof body.twitterUncoveredPollingIntervalMinutes === 'string'
            ? body.twitterUncoveredPollingIntervalMinutes
            : undefined,
    });

    return NextResponse.json({ ok: true, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存系统配置失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
