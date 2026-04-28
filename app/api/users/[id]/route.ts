import { NextRequest, NextResponse } from 'next/server';

import {
  deleteTrackedUser,
  TrackedAddressOwnershipConflictError,
  updateTrackedUser,
} from '@/lib/server/trackedUsersRepo';
import { InvalidTrackedAddressError } from '@/lib/trackedAddressValidation';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';
import { type User } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeOptionalString(value: unknown) {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeUpdatePayload(id: string, body: unknown): Partial<User> {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const candidate = body as Partial<User>;
  const updates: Partial<User> = {};

  if (typeof candidate.name === 'string') {
    updates.name = candidate.name;
  }
  if (typeof candidate.handle === 'string') {
    updates.handle = candidate.handle;
  }
  if (typeof candidate.avatar === 'string') {
    updates.avatar = candidate.avatar;
  }
  if ('twitter' in candidate) {
    updates.twitter = normalizeOptionalString(candidate.twitter);
  }
  if ('telegram' in candidate) {
    updates.telegram = normalizeOptionalString(candidate.telegram);
  }
  if (Array.isArray(candidate.tags)) {
    updates.tags = candidate.tags.filter((tag): tag is string => typeof tag === 'string');
  }

  if (Array.isArray(candidate.addresses)) {
    const [sanitized] = sanitizeUsersPayload([
      {
        id,
        name: candidate.name || 'tmp',
        handle: candidate.handle || 'tmp',
        avatar: candidate.avatar || 'tmp',
        tags: Array.isArray(candidate.tags) ? candidate.tags : [],
        addresses: candidate.addresses,
      },
    ]);

    if (sanitized) {
      updates.addresses = sanitized.addresses;
    }
  }

  return updates;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const updates = sanitizeUpdatePayload(id, body);
    const updated = updateTrackedUser(id, updates);

    if (!updated) {
      return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, user: updated });
  } catch (error) {
    if (error instanceof TrackedAddressOwnershipConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidTrackedAddressError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '更新用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const deleted = deleteTrackedUser(id);
    if (!deleted) {
      return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除用户失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
