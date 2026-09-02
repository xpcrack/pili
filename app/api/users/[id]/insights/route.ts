import { NextRequest, NextResponse } from '@/lib/server/httpCompat';

import { getUserInsights } from '@/lib/server/userInsights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface InsightsRouteContext {
  params: Promise<{ id: string }>;
}

export function createGetUserInsightsHandler() {
  return async function GET(_request: NextRequest, context: InsightsRouteContext) {
    try {
      const { id } = await context.params;
      return NextResponse.json(getUserInsights(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取用户洞察失败';
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  };
}

export const GET = createGetUserInsightsHandler();
