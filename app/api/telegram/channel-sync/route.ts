import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/server/apiGuard';
import { apiError, apiOk } from '@/lib/server/apiResponse';
import { bootstrapTelegramChannelSourcesFromTrackedUsers } from '@/lib/server/telegramChannelSourceRepo';
import { listTelegramChannelSources } from '@/lib/server/telegramChannelSourceRepo';
import { syncAllTelegramChannelSources } from '@/lib/server/telegramChannelSync';
import { createTelegramGramjsClient } from '@/lib/server/telegramGramjsClient';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  try {
    bootstrapTelegramChannelSourcesFromTrackedUsers();
    const sources = listTelegramChannelSources({ enabledOnly: true });

    if (sources.length === 0) {
      return apiOk({ synced: 0, message: 'no enabled channel sources' });
    }

    const client = await createTelegramGramjsClient();
    try {
      const result = await syncAllTelegramChannelSources({ client });

      const summary = result.results.map((item) => ({
        channelRef: item.channelRef,
        ok: item.ok,
        storedCount: item.storedCount,
        projectedCount: item.projectedCount,
        error: item.ok ? undefined : item.error,
      }));

      return apiOk({
        sourceCount: result.sourceCount,
        syncedCount: result.syncedCount,
        errorCount: result.errorCount,
        storedCount: result.storedCount,
        projectedCount: result.projectedCount,
        results: summary,
      });
    } finally {
      await client.disconnect?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(message, { fallback: 'telegram channel sync failed', status: 500 });
  }
}
