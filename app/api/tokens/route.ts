import { NextRequest, NextResponse } from 'next/server';
import { listTokens, addToken, deleteTokens, bulkImportTokens, type TokenChain } from '@/lib/server/tokensRepo';
import { getBatchTokenPrices } from '@/lib/server/priceService';

export const dynamic = 'force-dynamic';

const VALID_CHAINS: TokenChain[] = ['solana', 'ethereum', 'bsc', 'base', 'hyperevm', 'hypercore'];

/** GET /api/tokens - List tokens with prices */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const chain = searchParams.get('chain') as TokenChain | null;

    const tokens = chain ? listTokens(chain) : listTokens();

    // Fetch prices for all tokens
    const prices = await getBatchTokenPrices(
      tokens.map(t => ({ chain: t.chain, contractAddress: t.contract_address }))
    );

    const tokensWithPrice = tokens.map(t => {
      const key = `${t.chain}:${t.contract_address}`;
      const priceData = prices.get(key);

      return {
        ...t,
        price: priceData?.price ?? null,
        market_cap: priceData?.marketCap ?? null,
        price_change_24h: priceData?.priceChange24h ?? null,
        ticker: priceData?.ticker ?? null,
      };
    });

    return NextResponse.json({ items: tokensWithPrice });
  } catch (err) {
    console.error('GET /api/tokens error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST /api/tokens - Add a token */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chain, contractAddress, tags } = body;

    if (!chain || !contractAddress) {
      return NextResponse.json({ error: 'chain and contractAddress required' }, { status: 400 });
    }

    if (!VALID_CHAINS.includes(chain)) {
      return NextResponse.json({ error: `Invalid chain. Must be one of: ${VALID_CHAINS.join(', ')}` }, { status: 400 });
    }

    const token = addToken(chain, contractAddress, tags);
    return NextResponse.json(token, { status: 201 });
  } catch (err) {
    console.error('POST /api/tokens error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** DELETE /api/tokens - Delete multiple tokens */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { ids } = body;

    if (!ids || !Array.isArray(ids)) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }

    deleteTokens(ids);
    return NextResponse.json({ deleted: ids.length });
  } catch (err) {
    console.error('DELETE /api/tokens error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
