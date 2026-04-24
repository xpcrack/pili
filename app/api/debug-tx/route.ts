import { NextResponse } from 'next/server';
import { fetchOkxTransactionsByAddress } from '@/lib/okx';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');
  const chain = searchParams.get('chain') || 'bsc';
  const targetTx = searchParams.get('tx');

  if (!address) {
    return NextResponse.json({ error: 'Missing address parameter' }, { status: 400 });
  }

  try {
    const result = await fetchOkxTransactionsByAddress(address, chain);

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        error: result.error,
        configured: result.configured,
      });
    }

    const transactions = result.transactions;

    if (targetTx) {
      const found = transactions.find(tx =>
        tx.txHash?.toLowerCase() === targetTx.toLowerCase()
      );

      if (!found) {
        return NextResponse.json({
          ok: false,
          error: 'Transaction not found',
          totalTransactions: transactions.length,
          recentTxHashes: transactions.slice(0, 5).map(tx => tx.txHash),
        });
      }

      return NextResponse.json({
        ok: true,
        transaction: found,
        analysis: {
          txHash: found.txHash,
          symbol: found.symbol,
          amount: found.amount,
          itype: found.itype || found.iType,
          methodId: found.methodId,
          tag: found.tag,
          fromAddresses: (found.from || []).map(item => ({
            address: item.address,
            amount: item.amount,
          })),
          toAddresses: (found.to || []).map(item => ({
            address: item.address,
            amount: item.amount,
          })),
          userAddress: address.toLowerCase(),
          userInFrom: (found.from || []).some(item =>
            item?.address?.toLowerCase() === address.toLowerCase()
          ),
          userInTo: (found.to || []).some(item =>
            item?.address?.toLowerCase() === address.toLowerCase()
          ),
        },
      });
    }

    return NextResponse.json({
      ok: true,
      totalTransactions: transactions.length,
      transactions: transactions.slice(0, 10),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
