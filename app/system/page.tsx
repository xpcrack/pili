'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, RefreshCw, Save, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TopNav } from '@/components/TopNav';

const ADMIN_TOKEN_STORAGE_KEY = 'pilipili_admin_api_token';

type StatusType = 'idle' | 'saving' | 'saved' | 'error';

type EventStatsPayload = {
  total: number;
  bySource: Array<{ source: string; count: number }>;
  earliestTimestamp: number | null;
  latestTimestamp: number | null;
};

interface SyncLogItem {
  id: number;
  runKind: 'sync' | 'twitter';
  runId: number | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  phase: string | null;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

interface TwitterSyncRunItem {
  id?: number;
  status?: string;
  started_at_ms?: number;
  finished_at_ms?: number | null;
  fetched_count?: number;
  stored_count?: number;
  projected_count?: number;
  error_code?: string | null;
  error_message?: string | null;
}

interface TwitterStatusPayload {
  running?: boolean;
  stale?: boolean;
  lockOwner?: string | null;
  leaseExpiresAtMs?: number | null;
  heartbeatAtMs?: number | null;
  latestRun?: TwitterSyncRunItem | null;
  runs?: TwitterSyncRunItem[];
  latestTweet?: {
    tweetId: string;
    authorHandle: string;
    createdAtMs: number;
    lastSeenAtMs: number;
  } | null;
  latestVisibleEvent?: {
    eventId: string;
    timestamp: number;
    userName: string | null;
  } | null;
  latestRelay?: {
    tweetId: string;
    authorHandle: string;
    createdAtMs: number;
    lastSeenAtMs: number;
    sourceChatId: string | null;
    messageId: number | null;
  } | null;
}

function formatDateTime(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '暂无数据';
  }
  return new Date(value).toLocaleString('zh-CN');
}

export default function SystemPage() {
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return (window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
  });
  const [alertChatId, setAlertChatId] = useState('');
  const [tradeMonitorChatId, setTradeMonitorChatId] = useState('');
  const [twitterMonitorChatId, setTwitterMonitorChatId] = useState('');
  const [conflictAlertChatId, setConflictAlertChatId] = useState('');
  const [relayCoveredPollingIntervalMinutes, setRelayCoveredPollingIntervalMinutes] = useState('360');
  const [uncoveredPollingIntervalMinutes, setUncoveredPollingIntervalMinutes] = useState('30');
  const [status, setStatus] = useState<StatusType>('idle');
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [eventStats, setEventStats] = useState<EventStatsPayload | null>(null);
  const [syncingGlobalTwitter, setSyncingGlobalTwitter] = useState(false);
  const [syncingUserTwitter, setSyncingUserTwitter] = useState(false);
  const [twitterStatus, setTwitterStatus] = useState<TwitterStatusPayload | null>(null);
  const [twitterLogs, setTwitterLogs] = useState<SyncLogItem[]>([]);
  const [lastTwitterLogId, setLastTwitterLogId] = useState(0);
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [targetUserId, setTargetUserId] = useState('');

  const buildAdminHeaders = (extra?: Record<string, string>) => {
    const headers: Record<string, string> = {
      ...(extra || {}),
    };

    const token = adminToken.trim();
    if (token) {
      headers['x-admin-token'] = token;
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
  };

  const mapAdminError = (payload: unknown, fallback: string) => {
    const body = payload && typeof payload === 'object' ? (payload as { error?: unknown; retryAfterSeconds?: unknown }) : null;
    const errorText = typeof body?.error === 'string' ? body.error : '';
    if (errorText === 'unauthorized') {
      return '管理令牌无效，请检查后重试。';
    }
    if (errorText === 'rate_limited') {
      const retryAfterSeconds =
        typeof body?.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)
          ? Math.max(1, Math.floor(body.retryAfterSeconds))
          : null;
      return retryAfterSeconds ? `请求过于频繁，请 ${retryAfterSeconds} 秒后重试。` : '请求过于频繁，请稍后重试。';
    }
    return errorText || fallback;
  };

  useEffect(() => {
    void fetch('/api/system-config', { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload?.ok) return;
        setAlertChatId(payload.config?.telegramUnknownPersonAlertChatId || '');
        setTradeMonitorChatId(payload.config?.telegramTradeMonitorSourceChatId || '');
        setTwitterMonitorChatId(payload.config?.telegramTwitterMonitorSourceChatId || '');
        setConflictAlertChatId(payload.config?.conflictNotificationTelegramChatId || '');
        setRelayCoveredPollingIntervalMinutes(String(payload.config?.twitterRelayCoveredPollingIntervalMinutes ?? 360));
        setUncoveredPollingIntervalMinutes(String(payload.config?.twitterUncoveredPollingIntervalMinutes ?? 30));
      })
      .catch(() => undefined);

    void fetch('/api/events/stats', { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload?.ok) return;
        setEventStats(payload.stats as EventStatsPayload);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const normalized = adminToken.trim();
    if (normalized) {
      window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized);
    } else {
      window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  }, [adminToken]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const [syncRes, logsRes] = await Promise.all([
        fetch('/api/twitter/sync', { cache: 'no-store' }).catch(() => null),
        fetch(`/api/sync/logs?runKind=twitter&limit=200&afterId=${lastTwitterLogId}`, { cache: 'no-store' }).catch(() => null),
      ]);

      if (!cancelled && syncRes) {
        const syncPayload = await syncRes.json().catch(() => null);
        if (syncPayload?.ok) {
          setTwitterStatus((syncPayload.status as TwitterStatusPayload) || null);
        }
      }

      if (!cancelled && logsRes) {
        const logsPayload = await logsRes.json().catch(() => null);
        if (logsPayload?.ok && Array.isArray(logsPayload.logs)) {
          setTwitterLogs((prev) => {
            const merged = [...prev, ...(logsPayload.logs as SyncLogItem[])];
            if (merged.length <= 500) return merged;
            return merged.slice(merged.length - 500);
          });
          if (typeof logsPayload.lastId === 'number' && Number.isFinite(logsPayload.lastId)) {
            setLastTwitterLogId(logsPayload.lastId);
          }
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lastTwitterLogId]);

  useEffect(() => {
    if (!logAutoScroll) return;
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [twitterLogs, logAutoScroll]);

  const timeRangeLabel = useMemo(() => {
    if (!eventStats?.earliestTimestamp || !eventStats?.latestTimestamp) {
      return '暂无数据';
    }
    return `${new Date(eventStats.earliestTimestamp).toLocaleString('zh-CN')} ~ ${new Date(
      eventStats.latestTimestamp
    ).toLocaleString('zh-CN')}`;
  }, [eventStats]);

  const twitterFallbackStatusLabel = useMemo(() => {
    if (twitterStatus?.stale) {
      return '陈旧租约';
    }
    if (twitterStatus?.running) {
      return '运行中';
    }
    return '空闲';
  }, [twitterStatus]);

  const saveConfig = async () => {
    setStatus('saving');
    setError(null);

    const response = await fetch('/api/system-config', {
      method: 'PATCH',
      headers: buildAdminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        telegramUnknownPersonAlertChatId: alertChatId.trim() || null,
        telegramTradeMonitorSourceChatId: tradeMonitorChatId.trim() || null,
        telegramTwitterMonitorSourceChatId: twitterMonitorChatId.trim() || null,
        conflictNotificationTelegramChatId: conflictAlertChatId.trim() || null,
        twitterRelayCoveredPollingIntervalMinutes: relayCoveredPollingIntervalMinutes.trim(),
        twitterUncoveredPollingIntervalMinutes: uncoveredPollingIntervalMinutes.trim(),
      }),
    }).catch(() => null);

    if (!response) {
      setStatus('error');
      setError('网络异常，保存失败');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      setStatus('error');
      setError(mapAdminError(payload, '保存失败'));
      return;
    }

    setAlertChatId(payload.config?.telegramUnknownPersonAlertChatId || '');
    setTradeMonitorChatId(payload.config?.telegramTradeMonitorSourceChatId || '');
    setTwitterMonitorChatId(payload.config?.telegramTwitterMonitorSourceChatId || '');
    setConflictAlertChatId(payload.config?.conflictNotificationTelegramChatId || '');
    setRelayCoveredPollingIntervalMinutes(String(payload.config?.twitterRelayCoveredPollingIntervalMinutes ?? 360));
    setUncoveredPollingIntervalMinutes(String(payload.config?.twitterUncoveredPollingIntervalMinutes ?? 30));
    setStatus('saved');
    setTimeout(() => setStatus((current) => (current === 'saved' ? 'idle' : current)), 1500);
  };

  const testNotify = async () => {
    setTestStatus('sending');
    setTestError(null);

    const response = await fetch('/api/system-config/test-notify', {
      method: 'POST',
      headers: buildAdminHeaders(),
      cache: 'no-store',
    }).catch(() => null);

    if (!response) {
      setTestStatus('error');
      setTestError('网络异常，发送失败');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      setTestStatus('error');
      setTestError(mapAdminError(payload, '发送失败'));
      return;
    }

    setTestStatus('sent');
    setTimeout(() => setTestStatus((current) => (current === 'sent' ? 'idle' : current)), 1500);
  };

  const runGlobalTwitterSync = async () => {
    setSyncingGlobalTwitter(true);
    await fetch('/api/twitter/sync', {
      method: 'POST',
      headers: buildAdminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'sync', windowDays }),
    }).catch(() => null);
    setSyncingGlobalTwitter(false);
  };

  const runUserTwitterSync = async () => {
    if (!targetUserId.trim()) return;
    setSyncingUserTwitter(true);
    await fetch('/api/twitter/sync', {
      method: 'POST',
      headers: buildAdminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'sync', userId: targetUserId.trim(), windowDays }),
    }).catch(() => null);
    setSyncingUserTwitter(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <TopNav active="system" />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <h2 className="mb-3 text-sm font-medium">管理访问令牌</h2>
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <Label className="text-zinc-400">ADMIN_API_TOKEN（仅保存在当前浏览器会话）</Label>
              <Input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="输入后才可执行配置保存/测试通知/手动同步"
                className="border-zinc-800 bg-zinc-950"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-zinc-700"
              onClick={() => setAdminToken('')}
            >
              清空令牌
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <div className="mb-3 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-medium">数据状态看板</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="text-xs text-zinc-500">总事件数</div>
              <div className="mt-1 text-xl font-semibold">{eventStats?.total ?? 0}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 sm:col-span-2">
              <div className="text-xs text-zinc-500">时间范围</div>
              <div className="mt-1 text-sm">{timeRangeLabel}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="text-xs text-zinc-500">按来源</div>
              <div className="mt-1 space-y-1 text-xs text-zinc-300">
                {(eventStats?.bySource || []).map((item) => (
                  <div key={item.source}>
                    {item.source}: {item.count}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <h2 className="mb-3 text-sm font-medium">推特中转状态与日志</h2>
          <div className="mb-3 grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">Fallback Sync</div>
              <div className="mt-1 text-sm text-zinc-100">{twitterFallbackStatusLabel}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                Lease 到期: {formatDateTime(twitterStatus?.leaseExpiresAtMs ?? null)}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">最近 Relay 入库</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(twitterStatus?.latestRelay?.lastSeenAtMs ?? null)}</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                @{twitterStatus?.latestRelay?.authorHandle || '-'} / {twitterStatus?.latestRelay?.tweetId || '-'}
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">最新可见推文</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(twitterStatus?.latestVisibleEvent?.timestamp ?? null)}</div>
              <div className="mt-1 text-[11px] text-zinc-500">{twitterStatus?.latestVisibleEvent?.userName || '暂无人物映射'}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">最新抓到推文</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(twitterStatus?.latestTweet?.createdAtMs ?? null)}</div>
              <div className="mt-1 text-[11px] text-zinc-500">@{twitterStatus?.latestTweet?.authorHandle || '-'}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs md:col-span-3">
              <div className="text-zinc-500">最近一次 Sync Run</div>
              <div className="mt-1 text-sm text-zinc-100">
                #{twitterStatus?.latestRun?.id ?? '-'} / {twitterStatus?.stale ? 'stale' : twitterStatus?.latestRun?.status || '暂无'}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                抓取 {twitterStatus?.latestRun?.fetched_count ?? 0} / 入库 {twitterStatus?.latestRun?.stored_count ?? 0} / 投影{' '}
                {twitterStatus?.latestRun?.projected_count ?? 0}
              </div>
              {twitterStatus?.latestRun?.error_message && (
                <div className="mt-1 text-[11px] text-red-400">{twitterStatus.latestRun.error_message}</div>
              )}
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">自动滚动</div>
              <button
                type="button"
                onClick={() => setLogAutoScroll((value) => !value)}
                className="mt-1 rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
              >
                {logAutoScroll ? '开启' : '关闭'}
              </button>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">Twitter 日志条数</div>
              <div className="mt-1 text-sm text-zinc-100">{twitterLogs.length}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">最新心跳</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(twitterStatus?.heartbeatAtMs ?? null)}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">Lease Owner</div>
              <div className="mt-1 truncate text-sm text-zinc-100">{twitterStatus?.lockOwner || '暂无'}</div>
            </div>
          </div>
          <div ref={logContainerRef} className="h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
            {twitterLogs.length === 0 ? (
              <div className="text-zinc-600">暂无日志</div>
            ) : (
              twitterLogs.map((log) => (
                <div key={log.id} className="mb-1 break-words">
                  <span className="text-zinc-500">[{new Date(log.createdAt).toLocaleTimeString('zh-CN')}]</span>{' '}
                  <span className="text-zinc-400">{log.runKind}</span>
                  <span className="text-zinc-500">#{log.runId ?? '-'}</span>{' '}
                  <span
                    className={
                      log.level === 'error'
                        ? 'text-red-400'
                        : log.level === 'warn'
                          ? 'text-amber-300'
                          : log.level === 'debug'
                            ? 'text-cyan-300'
                            : 'text-emerald-300'
                    }
                  >
                    {log.level}
                  </span>{' '}
                  <span className="text-zinc-500">{log.phase || '-'}</span>{' '}
                  <span>{log.message}</span>
                  {log.payload && (
                    <span className="ml-2 text-zinc-500">{JSON.stringify(log.payload)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <h2 className="mb-3 text-sm font-medium">推特历史补录（手动）</h2>
          <div className="grid gap-3 md:grid-cols-[140px_1fr_auto_auto] md:items-end">
            <div>
              <Label className="text-zinc-400">窗口天数</Label>
              <Input
                value={String(windowDays)}
                onChange={(e) => setWindowDays(Math.max(1, Math.min(30, Number.parseInt(e.target.value || '7', 10) || 7)))}
                className="border-zinc-800 bg-zinc-950"
              />
            </div>
            <div>
              <Label className="text-zinc-400">单人 userId（可选）</Label>
              <Input
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                placeholder="留空则只用全局补录"
                className="border-zinc-800 bg-zinc-950"
              />
            </div>
            <Button onClick={runGlobalTwitterSync} disabled={syncingGlobalTwitter} className="bg-blue-600 hover:bg-blue-700">
              <RefreshCw className="mr-1 h-4 w-4" />
              {syncingGlobalTwitter ? '补录中...' : '全局补历史'}
            </Button>
            <Button
              onClick={runUserTwitterSync}
              disabled={syncingUserTwitter || !targetUserId.trim()}
              variant="outline"
              className="border-zinc-700"
            >
              {syncingUserTwitter ? '补录中...' : '单人补历史'}
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <h2 className="mb-3 text-sm font-medium">Bot-to-Bot 群配置</h2>
          <div className="mb-5 grid gap-3 md:grid-cols-2">
            <div>
              <Label className="text-zinc-400">Relay 覆盖账号自动同步间隔（分钟）</Label>
              <Input
                inputMode="numeric"
                value={relayCoveredPollingIntervalMinutes}
                onChange={(e) => setRelayCoveredPollingIntervalMinutes(e.target.value)}
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">仅影响自动 Twitter sync；手动同步不受限制。</p>
            </div>
            <div>
              <Label className="text-zinc-400">未 Relay 账号自动同步间隔（分钟）</Label>
              <Input
                inputMode="numeric"
                value={uncoveredPollingIntervalMinutes}
                onChange={(e) => setUncoveredPollingIntervalMinutes(e.target.value)}
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">保存时会限制在 1 分钟到 7 天之间。</p>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <div>
              <Label className="text-zinc-400">交易监听群 Chat ID</Label>
              <Input
                value={tradeMonitorChatId}
                onChange={(e) => setTradeMonitorChatId(e.target.value)}
                placeholder="例如: -5108676923"
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">用于 `/api/telegram/monitor`，仅接收该群消息。</p>
            </div>
            <div>
              <Label className="text-zinc-400">推特监听群 Chat ID</Label>
              <Input
                value={twitterMonitorChatId}
                onChange={(e) => setTwitterMonitorChatId(e.target.value)}
                placeholder="例如: -5299035575"
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">用于 `/api/twitter/relay`，仅接收该群消息。</p>
            </div>
            <div>
              <Label className="text-zinc-400">告警通知群 Chat ID</Label>
              <Input
                value={alertChatId}
                onChange={(e) => {
                  setAlertChatId(e.target.value);
                  setTestStatus('idle');
                  setTestError(null);
                }}
                placeholder="例如: -1001234567890"
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">用于未知人物与格式异常告警。</p>
              {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
              {testError && <div className="mt-2 text-xs text-red-400">{testError}</div>}
            </div>
            <div>
              <Label className="text-zinc-400">冲突通知群 Chat ID</Label>
              <Input
                value={conflictAlertChatId}
                onChange={(e) => setConflictAlertChatId(e.target.value)}
                placeholder="-1001234567890"
                className="border-zinc-800 bg-zinc-950"
              />
              <p className="mt-2 text-xs text-zinc-500">用于多源冲突实时逐条通知</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={testNotify} disabled={testStatus === 'sending'} className="border-zinc-700">
              <Send className="mr-1 h-4 w-4" />
              {testStatus === 'sending' ? '发送中...' : testStatus === 'sent' ? '已发送' : '测试通知'}
            </Button>
            <Button onClick={saveConfig} disabled={status === 'saving'} className="bg-blue-600 hover:bg-blue-700">
              <Save className="mr-1 h-4 w-4" />
              {status === 'saving' ? '保存中...' : status === 'saved' ? '已保存' : '保存配置'}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
