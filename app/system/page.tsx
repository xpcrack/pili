'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Bell, RefreshCw, Save, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TopNav } from '@/components/TopNav';
import { adminHeaders, readAdminTokenFromSession, writeAdminTokenToStorage } from '@/lib/adminClient';

type StatusType = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Trade-signal thresholds, held as strings so partially-typed input doesn't
 * fight the controlled inputs. Blank market-cap bounds mean "no limit".
 */
interface TradeSignalForm {
  enabled: boolean;
  minWinRatePercent: string;
  minRoundTrips: string;
  minFollowabilityPercent: string;
  minTradeUsd: string;
  minMarketCapUsd: string;
  maxMarketCapUsd: string;
  coHitMinUsers: string;
  coHitWindowMinutes: string;
  cooldownMinutes: string;
}

const EMPTY_TRADE_SIGNAL_FORM: TradeSignalForm = {
  enabled: false,
  minWinRatePercent: '45',
  minRoundTrips: '10',
  minFollowabilityPercent: '60',
  minTradeUsd: '500',
  minMarketCapUsd: '200000',
  maxMarketCapUsd: '1000000',
  coHitMinUsers: '2',
  coHitWindowMinutes: '180',
  cooldownMinutes: '60',
};

function toTradeSignalForm(config: Record<string, unknown> | null | undefined): TradeSignalForm {
  const value = config || {};
  const numberOrBlank = (input: unknown, fallback: string) =>
    typeof input === 'number' && Number.isFinite(input) ? String(input) : input === null ? '' : fallback;

  return {
    enabled: value.tradeSignalEnabled === true,
    minWinRatePercent:
      typeof value.tradeSignalMinWinRate === 'number'
        ? String(Math.round(value.tradeSignalMinWinRate * 100))
        : EMPTY_TRADE_SIGNAL_FORM.minWinRatePercent,
    minRoundTrips: numberOrBlank(value.tradeSignalMinRoundTrips, EMPTY_TRADE_SIGNAL_FORM.minRoundTrips),
    minFollowabilityPercent:
      typeof value.tradeSignalMinFollowability === 'number'
        ? String(Math.round(value.tradeSignalMinFollowability * 100))
        : EMPTY_TRADE_SIGNAL_FORM.minFollowabilityPercent,
    minTradeUsd: numberOrBlank(value.tradeSignalMinTradeUsd, EMPTY_TRADE_SIGNAL_FORM.minTradeUsd),
    minMarketCapUsd: numberOrBlank(value.tradeSignalMinMarketCapUsd, EMPTY_TRADE_SIGNAL_FORM.minMarketCapUsd),
    maxMarketCapUsd: numberOrBlank(value.tradeSignalMaxMarketCapUsd, EMPTY_TRADE_SIGNAL_FORM.maxMarketCapUsd),
    coHitMinUsers: numberOrBlank(value.tradeSignalCoHitMinUsers, EMPTY_TRADE_SIGNAL_FORM.coHitMinUsers),
    coHitWindowMinutes: numberOrBlank(
      value.tradeSignalCoHitWindowMinutes,
      EMPTY_TRADE_SIGNAL_FORM.coHitWindowMinutes
    ),
    cooldownMinutes: numberOrBlank(value.tradeSignalCooldownMinutes, EMPTY_TRADE_SIGNAL_FORM.cooldownMinutes),
  };
}

function toTradeSignalPatch(form: TradeSignalForm) {
  return {
    tradeSignalEnabled: form.enabled,
    tradeSignalMinWinRate: (Number(form.minWinRatePercent.trim() || '0') / 100).toString(),
    tradeSignalMinRoundTrips: form.minRoundTrips.trim(),
    tradeSignalMinFollowability: (Number(form.minFollowabilityPercent.trim() || '0') / 100).toString(),
    tradeSignalMinTradeUsd: form.minTradeUsd.trim(),
    // Blank means "no bound on this side", which the API models as null.
    tradeSignalMinMarketCapUsd: form.minMarketCapUsd.trim() || null,
    tradeSignalMaxMarketCapUsd: form.maxMarketCapUsd.trim() || null,
    tradeSignalCoHitMinUsers: form.coHitMinUsers.trim(),
    tradeSignalCoHitWindowMinutes: form.coHitWindowMinutes.trim(),
    tradeSignalCooldownMinutes: form.cooldownMinutes.trim(),
  };
}

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

interface CompletenessGlobalStatePayload {
  configuredStartMs: number | null;
  globalProvenStartMs: number | null;
  status: 'idle' | 'running' | 'complete' | 'partial' | 'retrying' | 'blocked';
  activeRunId: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

interface CompletenessSourceStatePayload {
  source: 'blockchain' | 'twitter' | 'telegram-bridge' | 'telegram-channel';
  requestedStartMs: number | null;
  provenStartMs: number | null;
  provenEndMs: number | null;
  status: 'idle' | 'running' | 'complete' | 'partial' | 'retrying' | 'blocked';
  failureCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  blockedReason: string | null;
  checkpointJson: string | null;
}

interface CompletenessRunItem {
  id: number;
  reason: string | null;
  trigger: string;
  configured_start_ms: number | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  global_proven_start_ms: number | null;
  summary_json: string | null;
}

interface CompletenessRunSourcePayload {
  run_id: number;
  source: string;
  requested_start_ms: number | null;
  proven_start_ms: number | null;
  proven_end_ms: number | null;
  status: string;
  fetched_count: number;
  stored_count: number;
  projected_count: number;
  blocked_reason: string | null;
  checkpoint_json: string | null;
}

interface CompletenessPayload {
  configuredStartMs: number | null;
  globalState: CompletenessGlobalStatePayload;
  sourceStates: CompletenessSourceStatePayload[];
  latestRun: CompletenessRunItem | null;
  latestRunSources: CompletenessRunSourcePayload[];
  runs: CompletenessRunItem[];
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
    return readAdminTokenFromSession();
  });
  const [alertChatId, setAlertChatId] = useState('');
  const [tradeMonitorChatId, setTradeMonitorChatId] = useState('');
  const [twitterMonitorChatId, setTwitterMonitorChatId] = useState('');
  const [conflictAlertChatId, setConflictAlertChatId] = useState('');
  const [completenessStartMs, setCompletenessStartMs] = useState('');
  const [relayCoveredPollingIntervalMinutes, setRelayCoveredPollingIntervalMinutes] = useState('360');
  const [uncoveredPollingIntervalMinutes, setUncoveredPollingIntervalMinutes] = useState('30');
  // One object rather than nine useState calls — these always load and save together.
  const [signalForm, setSignalForm] = useState<TradeSignalForm>(EMPTY_TRADE_SIGNAL_FORM);
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
  const [completeness, setCompleteness] = useState<CompletenessPayload | null>(null);
  const [completenessAction, setCompletenessAction] = useState<string | null>(null);
  const [completenessError, setCompletenessError] = useState<string | null>(null);

  // Pass live form token so headers stay correct before the storage write effect runs.
  const buildAdminHeaders = (extra?: Record<string, string>) =>
    adminHeaders(extra, adminToken);

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
    void fetch('/api/system-config', {
      cache: 'no-store',
      headers: buildAdminHeaders(),
    })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload?.ok) return;
        setAlertChatId(payload.config?.telegramUnknownPersonAlertChatId || '');
        setTradeMonitorChatId(payload.config?.telegramTradeMonitorSourceChatId || '');
        setTwitterMonitorChatId(payload.config?.telegramTwitterMonitorSourceChatId || '');
        setConflictAlertChatId(payload.config?.conflictNotificationTelegramChatId || '');
        setCompletenessStartMs(
          typeof payload.config?.completenessStartMs === 'number' && Number.isFinite(payload.config.completenessStartMs)
            ? String(payload.config.completenessStartMs)
            : ''
        );
        setRelayCoveredPollingIntervalMinutes(String(payload.config?.twitterRelayCoveredPollingIntervalMinutes ?? 360));
        setUncoveredPollingIntervalMinutes(String(payload.config?.twitterUncoveredPollingIntervalMinutes ?? 30));
        setSignalForm(toTradeSignalForm(payload.config));
      })
      .catch(() => undefined);

    void fetch('/api/events/stats', { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        if (!payload?.ok) return;
        setEventStats(payload.stats as EventStatsPayload);
      })
      .catch(() => undefined);
  }, [adminToken]);

  useEffect(() => {
    writeAdminTokenToStorage(adminToken);
  }, [adminToken]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const response = await fetch('/api/completeness', { cache: 'no-store' }).catch(() => null);
      if (!response || cancelled) {
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!cancelled && payload?.ok) {
        setCompleteness((payload.completeness as CompletenessPayload) || null);
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
        completenessStartMs: completenessStartMs.trim() ? completenessStartMs.trim() : null,
        twitterRelayCoveredPollingIntervalMinutes: relayCoveredPollingIntervalMinutes.trim(),
        twitterUncoveredPollingIntervalMinutes: uncoveredPollingIntervalMinutes.trim(),
        ...toTradeSignalPatch(signalForm),
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
    setCompletenessStartMs(
      typeof payload.config?.completenessStartMs === 'number' && Number.isFinite(payload.config.completenessStartMs)
        ? String(payload.config.completenessStartMs)
        : ''
    );
    setRelayCoveredPollingIntervalMinutes(String(payload.config?.twitterRelayCoveredPollingIntervalMinutes ?? 360));
    setUncoveredPollingIntervalMinutes(String(payload.config?.twitterUncoveredPollingIntervalMinutes ?? 30));
    setSignalForm(toTradeSignalForm(payload.config));
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

  const runCompletenessAction = async (action: 'run-now' | 'retry-source' | 'clear-source-checkpoint', source?: string) => {
    setCompletenessAction(source ? `${action}:${source}` : action);
    setCompletenessError(null);

    const response = await fetch('/api/completeness', {
      method: 'POST',
      headers: buildAdminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        action,
        source: source || null,
      }),
    }).catch(() => null);

    setCompletenessAction(null);

    if (!response) {
      setCompletenessError('网络异常，completeness 操作失败');
      return;
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      setCompletenessError(mapAdminError(payload, 'completeness 操作失败'));
      return;
    }

    setCompleteness((payload.completeness as CompletenessPayload) || null);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <TopNav active="system" />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
        <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-5">
          <h2 className="mb-3 text-sm font-medium">管理访问令牌</h2>
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <Label className="text-zinc-400">ADMIN_API_TOKEN（保存在本机浏览器，关闭后仍记住）</Label>
              <Input
                type="password"
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                placeholder="填一次即可；改名单/配置时需要"
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
          <div className="mb-1 flex items-center gap-2">
            <Bell className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-medium">交易信号推送</h2>
          </div>
          <p className="mb-4 text-xs text-zinc-500">
            达标的人建仓/加仓时推 Bark 到手机；多人在同一窗口买入同一个币时优先推送。
            胜率来自「排行」页的统计，样本不足的人不会触发。改完点页面底部的保存。
          </p>

          <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={signalForm.enabled}
              onChange={(event) => setSignalForm((current) => ({ ...current, enabled: event.target.checked }))}
              className="h-4 w-4 accent-emerald-500"
            />
            开启推送
            {!signalForm.enabled ? <span className="text-xs text-zinc-500">（当前关闭，不会发任何通知）</span> : null}
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ['minWinRatePercent', '最低胜率 %', '低于这个胜率的人不推送'],
                ['minRoundTrips', '最少交易次数', '样本不足的人不推送，避免 1 战 1 胜'],
                ['minFollowabilityPercent', '最低跟单分', '见「排行」页；挡掉高频难跟的钱包。填 0 关闭这一道'],
                ['minTradeUsd', '最小成交额 USD', '小于这个金额的买入不推送'],
                ['minMarketCapUsd', '最小市值 USD', '留空表示不限'],
                ['maxMarketCapUsd', '最大市值 USD', '留空表示不限'],
                ['coHitMinUsers', '撞车人数', '几个人买同一个币才算撞车'],
                ['coHitWindowMinutes', '撞车窗口（分钟）', '在这个时间内买入才算同时'],
                ['cooldownMinutes', '冷却（分钟）', '同一个人同一个币多久内不重复推'],
              ] as const
            ).map(([field, label, hint]) => (
              <div key={field}>
                <Label className="text-xs text-zinc-400">{label}</Label>
                <Input
                  value={signalForm[field]}
                  onChange={(event) =>
                    setSignalForm((current) => ({ ...current, [field]: event.target.value }))
                  }
                  inputMode="numeric"
                  className="mt-1 border-zinc-700 bg-zinc-900 text-zinc-100"
                />
                <p className="mt-1 text-[11px] text-zinc-600">{hint}</p>
              </div>
            ))}
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
          <h2 className="mb-3 text-sm font-medium">全局 Completeness Window</h2>
          <div className="mb-4 grid gap-3 md:grid-cols-[220px_repeat(4,minmax(0,1fr))]">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">配置起点</div>
              <div className="mt-1 text-sm text-zinc-100">{completenessStartMs || '未设置'}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">全局状态</div>
              <div className="mt-1 text-sm text-zinc-100">{completeness?.globalState.status || 'idle'}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">全局 Proven Start</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(completeness?.globalState.globalProvenStartMs ?? null)}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">上次成功</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(completeness?.globalState.lastSuccessAt ?? null)}</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
              <div className="text-zinc-500">上次失败</div>
              <div className="mt-1 text-sm text-zinc-100">{formatDateTime(completeness?.globalState.lastFailureAt ?? null)}</div>
            </div>
          </div>
          <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <Label className="text-zinc-400">completenessStartMs</Label>
              <Input
                value={completenessStartMs}
                onChange={(e) => setCompletenessStartMs(e.target.value)}
                placeholder="Unix ms，例如 1711929600000"
                className="border-zinc-800 bg-zinc-950"
              />
            </div>
            <Button
              onClick={() => runCompletenessAction('run-now')}
              disabled={completenessAction === 'run-now'}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {completenessAction === 'run-now' ? '运行中...' : '立即跑一次'}
            </Button>
          </div>
          {completenessError && <div className="mb-3 text-xs text-red-400">{completenessError}</div>}
          <div className="overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Proven Start</th>
                  <th className="px-3 py-2">Proven End</th>
                  <th className="px-3 py-2">Failure Count</th>
                  <th className="px-3 py-2">Blocked Reason</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(completeness?.sourceStates || []).map((item) => (
                  <tr key={item.source} className="border-t border-zinc-800">
                    <td className="px-3 py-2 text-zinc-100">{item.source}</td>
                    <td className="px-3 py-2">{item.status}</td>
                    <td className="px-3 py-2">{formatDateTime(item.provenStartMs)}</td>
                    <td className="px-3 py-2">{formatDateTime(item.provenEndMs)}</td>
                    <td className="px-3 py-2">{item.failureCount}</td>
                    <td className="max-w-xs px-3 py-2 text-zinc-500">{item.blockedReason || '-'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="border-zinc-700 px-2 py-1 text-xs"
                          onClick={() => runCompletenessAction('retry-source', item.source)}
                          disabled={completenessAction === `retry-source:${item.source}`}
                        >
                          重试
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="border-zinc-700 px-2 py-1 text-xs"
                          onClick={() => runCompletenessAction('clear-source-checkpoint', item.source)}
                          disabled={completenessAction === `clear-source-checkpoint:${item.source}`}
                        >
                          清 checkpoint
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
            <div className="text-zinc-500">最近一次 run</div>
            <div className="mt-1">
              #{completeness?.latestRun?.id ?? '-'} / {completeness?.latestRun?.status || '暂无'} /{' '}
              {formatDateTime(completeness?.latestRun?.started_at ?? null)}
            </div>
            <div className="mt-2 space-y-1">
              {(completeness?.latestRunSources || []).map((item) => (
                <div key={item.source}>
                  {item.source}: {item.status} / fetched {item.fetched_count} / stored {item.stored_count} / projected{' '}
                  {item.projected_count}
                </div>
              ))}
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
