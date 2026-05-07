import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { queueCompletenessPoke } from '@/lib/server/completenessRepo';
import { readSystemConfig, saveSystemConfig } from '@/lib/server/systemConfigRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SystemConfigPatchBody {
  telegramUnknownPersonAlertChatId?: string | null;
  telegramTradeMonitorSourceChatId?: string | null;
  telegramTwitterMonitorSourceChatId?: string | null;
  conflictNotificationTelegramChatId?: string | null;
  completenessStartMs?: number | string | null;
  twitterRelayCoveredPollingIntervalMinutes?: number | string | null;
  twitterUncoveredPollingIntervalMinutes?: number | string | null;
}

/** null → null (clear), string → string (set), undefined / wrong type → undefined (no-op). */
function pickStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** null → null (clear), number/string → as-is (set), undefined / wrong type → undefined (no-op). */
function pickNumericOrNull(value: unknown): number | string | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/** null → '' (clear via empty string), number/string → as-is, undefined / wrong type → undefined. */
function pickNumericOrEmpty(value: unknown): number | string | undefined {
  if (value === null) return '';
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

export async function GET() {
  return apiOk({ config: readSystemConfig() });
}

export async function PATCH(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    const previousConfig = readSystemConfig();
    const body = (await request.json().catch(() => null)) as SystemConfigPatchBody | null;

    if (!body || typeof body !== 'object') {
      return apiError('请求体必须是 JSON 对象', { status: 400 });
    }

    const config = saveSystemConfig({
      telegramUnknownPersonAlertChatId: pickStringOrNull(body.telegramUnknownPersonAlertChatId),
      telegramTradeMonitorSourceChatId: pickStringOrNull(body.telegramTradeMonitorSourceChatId),
      telegramTwitterMonitorSourceChatId: pickStringOrNull(body.telegramTwitterMonitorSourceChatId),
      conflictNotificationTelegramChatId: pickStringOrNull(body.conflictNotificationTelegramChatId),
      completenessStartMs: pickNumericOrNull(body.completenessStartMs),
      twitterRelayCoveredPollingIntervalMinutes: pickNumericOrEmpty(body.twitterRelayCoveredPollingIntervalMinutes),
      twitterUncoveredPollingIntervalMinutes: pickNumericOrEmpty(body.twitterUncoveredPollingIntervalMinutes),
    });

    if (previousConfig.completenessStartMs !== config.completenessStartMs) {
      queueCompletenessPoke({
        trigger: 'config-change',
        sourceHint: null,
        reason: 'completenessStartMs updated',
      });
    }

    return apiOk({ config });
  } catch (error) {
    return apiError(error, { fallback: '保存系统配置失败' });
  }
}
