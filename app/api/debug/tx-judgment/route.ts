import { NextResponse } from 'next/server';

import { readTxJudgment } from '@/lib/txJudgmentStore';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chain = (searchParams.get('chain') || '').trim().toLowerCase();
  const address = (searchParams.get('address') || '').trim().toLowerCase();
  const txHash = (searchParams.get('tx') || searchParams.get('txHash') || '').trim().toLowerCase();

  if (!chain || !address || !txHash) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Missing required query params: chain, address, tx',
      },
      { status: 400 }
    );
  }

  const record = await readTxJudgment(chain, address, txHash);
  return NextResponse.json({
    ok: true,
    found: Boolean(record),
    record,
  });
}

