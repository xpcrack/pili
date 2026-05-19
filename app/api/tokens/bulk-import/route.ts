import { NextRequest, NextResponse } from 'next/server';
import { bulkImportTokens, type TokenChain } from '@/lib/server/tokensRepo';

export const dynamic = 'force-dynamic';

const VALID_CHAINS: TokenChain[] = ['solana', 'ethereum', 'bsc', 'base', 'hyperevm', 'hypercore'];

/** POST /api/tokens/bulk-import - Bulk import tokens from text */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, chain } = body;

    if (!text || !chain) {
      return NextResponse.json({ error: 'text and chain required' }, { status: 400 });
    }

    if (!VALID_CHAINS.includes(chain)) {
      return NextResponse.json({ error: `Invalid chain. Must be one of: ${VALID_CHAINS.join(', ')}` }, { status: 400 });
    }

    const lines = text.split('\n').filter((l: string) => l.trim());
    const result = bulkImportTokens(lines, chain);

    return NextResponse.json(result);
  } catch (err) {
    console.error('POST /api/tokens/bulk-import error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
