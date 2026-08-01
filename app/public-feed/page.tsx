'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Activity, User } from '@/types';
import { ActivityCard } from '@/components/ActivityCard';
import { prepareGlobalFeed } from '@/lib/feedOrdering';

type SourceFilter = 'blockchain' | 'twitter' | 'telegram';

const SOURCE_LABELS: Record<SourceFilter, string> = {
  blockchain: '交易',
  twitter: '推特',
  telegram: 'TG',
};

const SOURCE_ORDER: SourceFilter[] = ['blockchain', 'twitter', 'telegram'];

interface FeedItem {
  activity: Activity;
  user: User;
}

interface FeedResponse {
  ok: boolean;
  feed: FeedItem[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

function SourceToggle({
  source,
  enabled,
  onChange,
}: {
  source: SourceFilter;
  enabled: boolean;
  onChange: (source: SourceFilter, enabled: boolean) => void;
}) {
  const colors: Record<SourceFilter, string> = {
    blockchain: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
    twitter: 'bg-sky-500/20 text-sky-400 border-sky-500/40',
    telegram: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  };
  const colorsActive: Record<SourceFilter, string> = {
    blockchain: 'bg-amber-500 text-white border-amber-500',
    twitter: 'bg-sky-500 text-white border-sky-500',
    telegram: 'bg-blue-500 text-white border-blue-500',
  };

  return (
    <button
      onClick={() => onChange(source, !enabled)}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
        enabled ? colorsActive[source] : colors[source]
      }`}
    >
      {SOURCE_LABELS[source]}
    </button>
  );
}

export default function PublicFeedPage() {
  const [enabledSources, setEnabledSources] = useState<Set<SourceFilter>>(
    new Set(['blockchain', 'twitter', 'telegram'])
  );
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleSource = useCallback((source: SourceFilter, enabled: boolean) => {
    setEnabledSources((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);

  const fetchFeed = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pageSize: '200' });
      const res = await fetch(`/api/feed?${params}`);
      const data: FeedResponse = await res.json();
      if (data.ok) {
        setFeed(data.feed || []);
        setError(null);
      } else {
        setError('获取 Feed 失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed();
    intervalRef.current = setInterval(fetchFeed, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchFeed]);

  // 与主页一致：先对全量 feed 跑合并/去重/仓位推算，再按源过滤。
  // 合并只作用于交易腿（推特/TG 透传），所以即便用户关掉交易源也不受影响。
  const orderedFeed = useMemo(() => prepareGlobalFeed(feed), [feed]);
  const filteredFeed = orderedFeed.filter((item) => enabledSources.has(item.activity.source));
  const displayedFeed = showAll ? filteredFeed : filteredFeed.slice(0, 50);

  const allDisabled = enabledSources.size === 0;

  return (
    <div className="public-feed min-h-screen bg-zinc-950 text-zinc-100">
      <style>{`
        .public-feed [data-feed-card] { border:0 !important; }
        .public-feed [data-feed-card] > div { padding:0 !important; }
        .public-feed [data-feed-card] [data-slot="avatar"] { display:none !important; }
        .public-feed [data-trade-row] .feed-trade-row { padding:4px 8px !important; gap:0 !important; font-size:11px !important; grid-template-columns:40px 76px 76px 36px 38px minmax(52px,1fr) !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(7) { order:1 !important; text-align:left !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(2) { order:2 !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(3) { order:3 !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(4) { order:4 !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(5) { order:5 !important; }
        .public-feed [data-trade-row] .feed-trade-row > :nth-child(6) { order:6 !important; }
        .public-feed [data-trade-row] [data-feed-card] { min-height:0 !important; }
        .public-feed [data-social-row] > div > div { display:grid !important; grid-template-columns:40px 76px minmax(0,1fr) !important; gap:0 !important; padding:4px 8px !important; align-items:start !important; }
        .public-feed [data-social-row] .w-\\[108px\\] { width:76px !important; }
        .public-feed [data-social-row] .w-\\[108px\\] > :nth-child(2) { margin-top:2px !important; }
        .public-feed [data-social-row] .w-\\[108px\\] > :nth-child(2) > :first-child { display:inline !important; padding:0 !important; border:0 !important; background:transparent !important; color:#71717a !important; font-size:10.5px !important; line-height:1 !important; font-weight:400 !important; height:auto !important; min-width:0 !important; }
        .public-feed [data-social-row] .w-\\[108px\\] > :nth-child(2) > :nth-child(2) { color:#71717a !important; font-size:10px !important; }
        .public-feed [data-social-row] .w-20 { width:40px !important; }
        .public-feed [data-social-row] > div > div > :last-child { order:-1 !important; align-items:flex-start !important; }
        .public-feed [data-social-row] > div > div > :last-child button,
        .public-feed [data-social-row] > div > div > :last-child span { text-align:left !important; padding-left:0 !important; }
        .public-feed [data-social-row] > div > div > :nth-child(3) { padding-left:6px !important; min-width:0 !important; }
        .public-feed [data-social-row] p { font-size:11px !important; line-height:1.35 !important; }
        .public-feed [data-social-row] .line-clamp-2 { display:block !important; overflow:visible !important; }
        .public-feed [data-transfer-row] > div > div { padding:4px 8px !important; gap:4px !important; font-size:11px !important; }
        .public-feed [data-transfer-row] .h-\\[22px\\] { height:18px !important; min-width:36px !important; font-size:10px !important; }
        .public-feed [data-transfer-row] > div > div > :nth-child(7) { order:-1 !important; text-align:left !important; }
        .public-feed [data-transfer-row] > div > div { grid-template-columns:36px 76px 60px 60px 40px 60px 40px !important; }
      `}</style>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-zinc-800/50 bg-zinc-950/95 backdrop-blur-md">
        <div className="mx-auto flex h-9 max-w-3xl items-center justify-between px-3">
          <h1 className="text-sm font-semibold">PiliPili Feed</h1>
          <span className="text-[11px] text-zinc-500">
            {filteredFeed.length} 条动态
          </span>
        </div>
      </header>

      {/* Source Toggles */}
      <div className="mx-auto max-w-3xl px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          {SOURCE_ORDER.map((source) => (
            <SourceToggle
              key={source}
              source={source}
              enabled={enabledSources.has(source)}
              onChange={toggleSource}
            />
          ))}
          <button
            onClick={() => fetchFeed()}
            className="ml-auto rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            刷新
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="mx-auto max-w-3xl">
        {loading ? (
          <div className="py-20 text-center text-sm text-zinc-500">加载中...</div>
        ) : error ? (
          <div className="py-20 text-center text-sm text-red-400">{error}</div>
        ) : allDisabled ? (
          <div className="py-20 text-center text-sm text-zinc-500">
            请至少开启一个数据源
          </div>
        ) : filteredFeed.length === 0 ? (
          <div className="py-20 text-center text-sm text-zinc-500">
            暂无动态
          </div>
        ) : (
          <div>
            {displayedFeed.map((item) => (
              <ActivityCard
                key={item.activity.id}
                activity={item.activity}
                user={item.user}
              />
            ))}
            {!showAll && filteredFeed.length > 50 && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full border-b border-white/[0.035] py-2.5 text-sm text-zinc-400 transition-colors hover:bg-white/[0.035] hover:text-zinc-200"
              >
                查看全部 {filteredFeed.length} 条动态
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}