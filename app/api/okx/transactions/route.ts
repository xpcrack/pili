import { NextRequest, NextResponse } from '@/lib/server/httpCompat';
import { requireAdmin } from '@/lib/server/apiGuard';
import { fetchOkxTransactionsByAddress, isSupportedOkxChain } from '@/lib/okx';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const unauthorizedResponse = requireAdmin(request);
  if (unauthorizedResponse) {
    return unauthorizedResponse;
  }

  const address = request.nextUrl.searchParams.get('address')?.trim();
  const chain = request.nextUrl.searchParams.get('chain')?.trim();

  if (!address || !chain) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        transactions: [],
        error: '缺少 address 或 chain 参数',
      },
      { status: 400 }
    );
  }

  if (!isSupportedOkxChain(chain)) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        transactions: [],
        error: '仅支持 bsc、ethereum、base 和 solana 地址',
      },
      { status: 400 }
    );
  }

  const result = await fetchOkxTransactionsByAddress(address, chain);

  return NextResponse.json(result, {
    status: result.ok || !result.configured ? 200 : 502,
  });
}
