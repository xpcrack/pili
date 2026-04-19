import { NextRequest, NextResponse } from 'next/server';

import { projectTwitterTweetsToFeed } from '@/lib/server/twitterFeedMapper';
import { upsertTwitterTweets, type UpsertTwitterTweetInput } from '@/lib/server/twitterRepo';
import { listTrackedUsers } from '@/lib/server/trackedUsersRepo';
import { normalizeTwitterHandle } from '@/lib/userProfile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RelayPayload {
  tweetId?: string;
  action?: 'tweet' | 'quote' | 'reply' | string;
  content?: string;
  url?: string;
  authorHandle?: string;
  createdAtMs?: number;
  sourceChatId?: string | number;
  messageId?: number;
}

function normalize(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function parseTweetId(input: RelayPayload) {
  const fromPayload = (input.tweetId || '').trim();
  if (fromPayload) return fromPayload;
  const text = (input.url || '').trim();
  const m = text.match(/status\/(\d+)/i);
  return m?.[1] || '';
}

function getAuthToken(req: NextRequest) {
  const auth = req.headers.get('authorization')?.trim() || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return req.headers.get('x-telegram-bot-api-secret-token')?.trim() || '';
}

export async function POST(request: NextRequest) {
  const expectedToken = process.env.TWITTER_RELAY_INGEST_TOKEN?.trim() || process.env.TELEGRAM_MONITOR_INGEST_TOKEN?.trim() || '';
  if (!expectedToken) {
    return NextResponse.json({ ok: false, error: 'missing TWITTER_RELAY_INGEST_TOKEN' }, { status: 503 });
  }

  const token = getAuthToken(request);
  if (token !== expectedToken) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const allowedChatId = (process.env.TWITTER_BOT_SOURCE_CHAT_ID || '-2625702466').trim();
  const payload = (await request.json().catch(() => null)) as RelayPayload | null;
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }

  const sourceChatId = String(payload.sourceChatId || '').trim();
  if (allowedChatId && sourceChatId && sourceChatId !== allowedChatId) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'chat-not-allowed' });
  }

  const tweetId = parseTweetId(payload);
  const fullText = (payload.content || '').trim();
  const authorHandle = normalizeTwitterHandle(payload.authorHandle || '');

  if (!tweetId || !fullText) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'missing-tweet-fields' });
  }

  const lane = payload.action === 'reply' ? 'replies' : 'timeline';

  const fallbackAuthor = authorHandle
    ? normalize(authorHandle)
    : (() => {
        const users = listTrackedUsers();
        const first = users.find((user) => normalizeTwitterHandle(user.twitter || ''));
        const handle = normalizeTwitterHandle(first?.twitter || '');
        return handle ? normalize(handle) : '';
      })();

  if (!fallbackAuthor) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'no-author-handle' });
  }

  const createdAtMs = Number.isFinite(payload.createdAtMs) ? Math.floor(payload.createdAtMs as number) : Date.now();
  const input: UpsertTwitterTweetInput = {
    tweetId,
    authorHandle: fallbackAuthor,
    fullText,
    createdAtMs,
    lane,
    source: {
      provider: 'bot2bot',
      sourceChatId: sourceChatId || null,
      messageId: typeof payload.messageId === 'number' ? payload.messageId : null,
      action: payload.action || null,
      url: payload.url || null,
    },
  };

  const stored = upsertTwitterTweets([input]);
  const projected = projectTwitterTweetsToFeed({
    sinceMs: Math.max(0, createdAtMs - 24 * 60 * 60 * 1000),
    tweetIds: [tweetId],
  });

  return NextResponse.json({
    ok: true,
    storedCount: stored.storedCount,
    projectedCount: projected.projectedCount,
    tweetId,
  });
}
