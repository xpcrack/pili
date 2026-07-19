import { NextRequest, NextResponse } from '@/lib/server/httpCompat';

import { requireAgent } from '@/lib/server/apiGuard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Opportunities API - Deprecated
 *
 * This endpoint has been disabled as of Sprint 1.
 * No active callers were found during the audit.
 *
 * The underlying opportunitySelector is not shared with any active service.
 */
export async function GET(request: NextRequest) {
  const auth = requireAgent(request);
  if (auth) {
    return auth;
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'gone',
      message: 'This API has been permanently disabled. No active callers were identified.'
    },
    { status: 410 }
  );
}
