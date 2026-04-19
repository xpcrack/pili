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
    });

    return NextResponse.json({ ok: true, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存系统配置失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
