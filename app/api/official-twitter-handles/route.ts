import { NextResponse } from '@/lib/server/httpCompat';
import { getPrimaryPoolOfficialTwitterMap } from '@/lib/server/primaryPoolSymbols';

export const dynamic = 'force-dynamic';

/**
 * 一级池官推 handle 集合（lowercase）。前端 feed 渲染时给推文正文里的
 * @handle 高亮「项目官推」用（蓝字区分 trader 与项目方）。
 * 数据源 = newone tokens.twitter_url（primary pool active），60s 进程内缓存。
 */
export async function GET() {
  const map = getPrimaryPoolOfficialTwitterMap();
  return NextResponse.json({
    ok: true,
    handles: [...map.keys()],
  });
}
