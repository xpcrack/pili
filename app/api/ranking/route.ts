import { NextRequest } from '@/lib/server/httpCompat';

import { apiError, apiOk } from '@/lib/server/apiResponse';
import { readUserPnlRanking } from '@/lib/server/walletPnlService';
import { DEFAULT_PNL_WINDOW, isPnlWindowKey, PNL_WINDOWS } from '@/lib/walletPnl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Person leaderboard, read straight from the `user_pnl_stats` table the
 * background worker maintains. No computation happens here — this endpoint must
 * stay a cheap single-table read.
 */
export async function GET(request: NextRequest) {
  try {
    const requested = new URL(request.url).searchParams.get('window');
    const windowKey = isPnlWindowKey(requested) ? requested : DEFAULT_PNL_WINDOW;
    const rows = readUserPnlRanking(windowKey);
    const fallbackRows = rows.length === 0 && windowKey !== 'all' ? readUserPnlRanking('all') : rows;
    return apiOk({
      rows: fallbackRows,
      windowKey: fallbackRows === rows ? windowKey : 'all',
      windows: PNL_WINDOWS,
      computedAt: fallbackRows[0]?.computedAt ?? null,
    });
  } catch (error) {
    return apiError(error, { fallback: '读取盈亏排行榜失败' });
  }
}
