'use client';

import { useEffect, useState } from 'react';

/**
 * Feed 数据新鲜度。轮询 5s 一次，所以：
 * - 正常：< 60s
 * - 琥珀：> 60s，已经错过十几轮轮询，大概率同步异常
 * - 红色：> 300s，数据明显过期，不要照着它做交易决策
 *
 * 之所以必须显示：拉取失败时会保留上一次成功的数据（避免交易界面白屏），
 * 屏幕上的旧成交和实时成交长得一模一样，没有这个指示器就看不出来。
 */
const STALE_WARN_MS = 60_000;
const STALE_ALERT_MS = 300_000;

function formatAge(ageMs: number) {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function FeedFreshnessIndicator({ lastUpdate }: { lastUpdate: Date | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!lastUpdate) {
    return <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">未同步</span>;
  }

  const ageMs = nowMs - lastUpdate.getTime();
  const tone =
    ageMs > STALE_ALERT_MS
      ? 'text-rose-400'
      : ageMs > STALE_WARN_MS
        ? 'text-amber-400'
        : 'text-zinc-500';

  return (
    <span
      className={`shrink-0 text-[11px] tabular-nums ${tone}`}
      title={`最后同步：${lastUpdate.toLocaleTimeString('zh-CN')}${
        ageMs > STALE_WARN_MS ? '（数据可能已过期，请检查同步状态）' : ''
      }`}
    >
      {formatAge(ageMs)} 前
    </span>
  );
}
