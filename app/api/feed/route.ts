import { NextRequest, NextResponse } from 'next/server';
import { buildActivityFeed } from '@/lib/activityFeed';
import { type User } from '@/types';

export const dynamic = 'force-dynamic';

function isAddressArray(value: unknown): value is User['addresses'] {
  return Array.isArray(value);
}

function sanitizeUsers(value: unknown): User[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Partial<User>;
    const currentChainAssetTotal =
      typeof candidate.currentChainAssetTotal === 'number' && Number.isFinite(candidate.currentChainAssetTotal)
        ? candidate.currentChainAssetTotal
        : 0;
    const historicalMaxChainAssetTotal =
      typeof candidate.historicalMaxChainAssetTotal === 'number' &&
      Number.isFinite(candidate.historicalMaxChainAssetTotal)
        ? Math.max(candidate.historicalMaxChainAssetTotal, currentChainAssetTotal)
        : currentChainAssetTotal;

    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.handle !== 'string' ||
      typeof candidate.avatar !== 'string' ||
      !isAddressArray(candidate.addresses)
    ) {
      return [];
    }

    return [
      {
        currentChainAssetTotal,
        historicalMaxChainAssetTotal,
        id: candidate.id,
        name: candidate.name,
        handle: candidate.handle,
        avatar: candidate.avatar,
        twitter: typeof candidate.twitter === 'string' ? candidate.twitter : undefined,
        telegram: typeof candidate.telegram === 'string' ? candidate.telegram : undefined,
        tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        addresses: candidate.addresses.filter(
          (address): address is User['addresses'][number] =>
            !!address &&
            typeof address === 'object' &&
            typeof address.address === 'string' &&
            typeof address.name === 'string' &&
            (address.chain === 'bsc' || address.chain === 'solana')
        ),
      },
    ];
  });
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json().catch(() => null);
    const users = sanitizeUsers(payload?.users);
    const result = await buildActivityFeed(users);

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '服务端拉取动态失败';
    console.error('[api/feed] unexpected error:', error);

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
