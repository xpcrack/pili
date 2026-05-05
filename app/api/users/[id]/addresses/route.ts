import { NextRequest, NextResponse } from 'next/server';

import {
  addTrackedAddresses,
  removeTrackedAddress,
  TrackedAddressOwnershipConflictError,
} from '@/lib/server/trackedUsersRepo';
import { triggerBid2MirrorSync } from '@/lib/server/bidSyncNotifier';
import { InvalidTrackedAddressError } from '@/lib/trackedAddressValidation';
import { sanitizeUsersPayload } from '@/lib/server/userPayload';
import { type ChainType } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseChain(value: unknown): ChainType | undefined {
  if (value === 'bsc' || value === 'solana' || value === 'ethereum' || value === 'base') {
    return value;
  }
  return undefined;
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const addressesPayload = Array.isArray(body?.addresses) ? body.addresses : [];

    const [sanitized] = sanitizeUsersPayload([
      {
        id,
        name: 'tmp',
        handle: 'tmp',
        avatar: 'tmp',
        tags: [],
        addresses: addressesPayload,
      },
    ]);

    const addresses = sanitized?.addresses || [];
    if (addresses.length === 0) {
      return NextResponse.json({ ok: false, error: '地址参数无效' }, { status: 400 });
    }

    const updated = addTrackedAddresses(id, addresses);
    if (!updated) {
      return NextResponse.json({ ok: false, error: '用户不存在' }, { status: 404 });
    }
    triggerBid2MirrorSync({
      entity: 'address',
      action: 'created',
      userId: id,
      address: addresses[0]?.address || null,
    });

    return NextResponse.json({ ok: true, user: updated });
  } catch (error) {
    if (error instanceof TrackedAddressOwnershipConflictError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidTrackedAddressError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : '新增地址失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const address = typeof body?.address === 'string' ? body.address : '';
    const chain = parseChain(body?.chain);

    if (!address.trim()) {
      return NextResponse.json({ ok: false, error: '地址参数无效' }, { status: 400 });
    }

    const removed = removeTrackedAddress(id, address, chain);
    if (!removed) {
      return NextResponse.json({ ok: false, error: '地址不存在' }, { status: 404 });
    }
    triggerBid2MirrorSync({
      entity: 'address',
      action: 'deleted',
      userId: id,
      address,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '删除地址失败';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
