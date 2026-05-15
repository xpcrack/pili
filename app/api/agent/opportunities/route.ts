import { NextRequest, NextResponse } from 'next/server';

import { requireAgent } from '@/lib/server/apiGuard';
import { selectOpportunities } from '@/lib/server/opportunitySelector';
import type { ActivitySource } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MIN_USD = 500;
const DEFAULT_MIN_CO_HIT = 2;
const DEFAULT_MIN_IMPORTANCE = 40;
const DEFAULT_ACTIONS = ['buy', 'open', 'add'];
const DEFAULT_SOURCES: ActivitySource[] = ['blockchain', 'telegram'];
const DEFAULT_WINDOW_HOURS = 24;
const VALID_SOURCES = new Set<ActivitySource>(['twitter', 'telegram', 'blockchain']);

function parseNumberParam(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseListParam(value: string | null, fallback: string[]): string[] {
  if (value === null) {
    return fallback;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseSourcesParam(value: string | null): ActivitySource[] | null {
  if (value === null) {
    return DEFAULT_SOURCES;
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return [];
  }
  for (const entry of entries) {
    if (!VALID_SOURCES.has(entry as ActivitySource)) {
      return null;
    }
  }
  return entries as ActivitySource[];
}

export async function GET(request: NextRequest) {
  const auth = requireAgent(request);
  if (auth) {
    return auth;
  }

  try {
    const params = request.nextUrl.searchParams;

    const since = parseNumberParam(params.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (since === null) {
      return NextResponse.json({ ok: false, error: 'invalid since' }, { status: 400 });
    }

    const limit = parseNumberParam(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) {
      return NextResponse.json({ ok: false, error: 'invalid limit' }, { status: 400 });
    }

    const minUsd = parseNumberParam(params.get('minUsd'), DEFAULT_MIN_USD, 0, Number.MAX_SAFE_INTEGER);
    if (minUsd === null) {
      return NextResponse.json({ ok: false, error: 'invalid minUsd' }, { status: 400 });
    }

    const minCoHit = parseNumberParam(params.get('minCoHit'), DEFAULT_MIN_CO_HIT, 0, 1000);
    if (minCoHit === null) {
      return NextResponse.json({ ok: false, error: 'invalid minCoHit' }, { status: 400 });
    }

    const minImportance = parseNumberParam(params.get('minImportance'), DEFAULT_MIN_IMPORTANCE, 0, 100);
    if (minImportance === null) {
      return NextResponse.json({ ok: false, error: 'invalid minImportance (0-100)' }, { status: 400 });
    }

    const windowHours = parseNumberParam(params.get('windowHours'), DEFAULT_WINDOW_HOURS, 1, 24 * 30);
    if (windowHours === null) {
      return NextResponse.json({ ok: false, error: 'invalid windowHours' }, { status: 400 });
    }

    const sources = parseSourcesParam(params.get('sources'));
    if (sources === null) {
      return NextResponse.json({ ok: false, error: 'invalid sources' }, { status: 400 });
    }

    const actions = parseListParam(params.get('actions'), DEFAULT_ACTIONS);
    const chains = parseListParam(params.get('chains'), []).map((entry) => entry.toLowerCase());

    const result = selectOpportunities({
      since: Math.floor(since),
      limit: Math.floor(limit),
      minUsd,
      minCoHit: Math.floor(minCoHit),
      minImportance: Math.floor(minImportance),
      actions: new Set(actions),
      chains: new Set(chains),
      sources: new Set(sources),
      windowHours,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取候选失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
