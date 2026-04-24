import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const txHash = searchParams.get('tx');

  if (!txHash) {
    return NextResponse.json({ error: 'Missing tx parameter' }, { status: 400 });
  }

  // 从前端的 localStorage 获取活动数据
  return NextResponse.json({
    message: 'Please check browser console for transaction details',
    instructions: [
      'Open browser console',
      'Run: localStorage.getItem("activity-feed-cache")',
      'Search for the transaction hash in the output',
      'Copy the full transaction object and share it'
    ]
  });
}
