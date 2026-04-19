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

export default function SystemPage() {
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return (window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
  });
  const [chatId, setChatId] = useState('');
  const [status, setStatus] = useState<StatusType>('idle');
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [eventStats, setEventStats] = useState<EventStatsPayload | null>(null);
  const [syncingGlobalTwitter, setSyncingGlobalTwitter] = useState(false);
  const [syncingUserTwitter, setSyncingUserTwitter] = useState(false);
  const [syncStatus, setSyncStatus] = useState<unknown>(null);
  const [syncLogs, setSyncLogs] = useState<SyncLogItem[]>([]);
  const [lastLogId, setLastLogId] = useState(0);
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
        setChatId(payload.config?.telegramUnknownPersonAlertChatId || '');
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
        fetch('/api/sync/status', { cache: 'no-store' }).catch(() => null),
        fetch(`/api/sync/logs?limit=200&afterId=${lastLogId}`, { cache: 'no-store' }).catch(() => null),
      ]);

      if (!cancelled && syncRes) {
        const syncPayload = await syncRes.json().catch(() => null);
        if (syncPayload?.ok) {
          setSyncStatus(syncPayload.status || null);
        }
      }

      if (!cancelled && logsRes) {
        const logsPayload = await logsRes.json().catch(() => null);
        if (logsPayload?.ok && Array.isArray(logsPayload.logs)) {
          setSyncLogs((prev) => {
            const merged = [...prev, ...(logsPayload.logs as SyncLogItem[])];
            if (merged.length <= 500) return merged;
            return merged.slice(merged.length - 500);
          });
          if (typeof logsPayload.lastId === 'number' && Number.isFinite(logsPayload.lastId)) {
            setLastLogId(logsPayload.lastId);
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
  }, [lastLogId]);

  useEffect(() => {
    if (!logAutoScroll) return;
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [syncLogs, logAutoScroll]);

  const timeRangeLabel = useMemo(() => {
    if (!eventStats?.earliestTimestamp || !eventStats?.latestTimestamp) {
      return '暂无数据';
    }
    return `${new Date(eventStats.earliestTimestamp).toLocaleString('zh-CN')} ~ ${new Date(
      eventStats.latestTimestamp
    ).toLocaleString('zh-CN')}`;
  }, [eventStats]);

  const saveConfig = async () => {
    setStatus('saving');
    setError(null);

    const response = await fetch('/api/system-config', {
      method: 'PATCH',
      headers: buildAdminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ telegramUnknownPersonAlertChatId: chatId.trim() || null }),
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

    setChatId(payload.config?.telegramUnknownPersonAlertChatId || '');
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
          <h2 className="mb-3 text-sm font-medium">同步进度与实时日志</h2>
          <div className="mb-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">后台同步状态</div>
              <div className="mt-1 text-sm text-zinc-100">{(syncStatus as { running?: boolean } | null)?.running ? '运行中' : '空闲'}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">最近日志条数</div>
              <div className="mt-1 text-sm text-zinc-100">{syncLogs.length}</div>
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
          </div>
          <div ref={logContainerRef} className="h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
            {syncLogs.length === 0 ? (
              <div className="text-zinc-600">暂无日志</div>
            ) : (
              syncLogs.map((log) => (
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
          <h2 className="mb-3 text-sm font-medium">未知人物通知配置</h2>
          <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
            <div>
              <Label className="text-zinc-400">通知群 Chat ID</Label>
              <Input
                value={chatId}
                onChange={(e) => {
                  setChatId(e.target.value);
                  setTestStatus('idle');
                  setTestError(null);
                }}
                placeholder="例如: -1001234567890"
                className="border-zinc-800 bg-zinc-950"
              />
              {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
              {testError && <div className="mt-2 text-xs text-red-400">{testError}</div>}
            </div>
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
