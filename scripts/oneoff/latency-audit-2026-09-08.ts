/**
 * 一次性诊断脚本：全链路通知延迟画像（只读，不写库）。v3
 *
 * 字段格式事实（实测）：
 *  - pili telegram_monitor_events.created_at/event_time_ms: epoch ms (INTEGER)
 *  - newone events.occurred_at / alerts.event_occurred_at / delivered_at: ISO8601 TEXT (UTC)
 *  - newone events.created_at / alerts.created_at / raw_observations.fetched_at:
 *    "YYYY-MM-DD HH:MM:SS" TEXT（本地时区 CST）
 *  - raw_observations.observed_at: ISO8601 TEXT (UTC)
 *
 * 用法: bun scripts/oneoff/latency-audit-2026-09-08.ts
 */
import { Database } from 'bun:sqlite';

const PILI_DB = `${process.env.HOME}/vibecoding/pilipili/.data/web3-feed.sqlite`;
const NEWONE_DB = `${process.env.HOME}/vibecoding/newone/data/newone.sqlite`;

function openReadonly(file: string) {
  return new Database(file, { readonly: true });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmt(v: number): string {
  if (v >= 3600) return `${(v / 3600).toFixed(2)}h`;
  if (v >= 60) return `${(v / 60).toFixed(1)}m`;
  return `${v.toFixed(0)}s`;
}

function describe(values: number[]): string {
  if (values.length === 0) return '(no rows)';
  const sorted = [...values].sort((a, b) => a - b);
  return `n=${values.length}  p50=${fmt(pct(sorted, 50))}  p90=${fmt(pct(sorted, 90))}  p99=${fmt(pct(sorted, 99))}  max=${fmt(sorted[sorted.length - 1])}`;
}

// 本地时间文本 -> epoch s（实测这些 TEXT 列存的是 UTC，无时区偏移）
const LOCAL_TO_EPOCH_S = `strftime('%s', X)`;

// ---------- A. pilipili ----------
const pili = openReadonly(PILI_DB);
console.log('=== A. pili telegram_monitor_events: event_time_ms -> created_at (入桥延迟) ===');
console.log('-- 近14天按天 --');
for (const r of pili.query(`
  SELECT date(created_at/1000, 'unixepoch', 'localtime') AS d,
         count(*) AS n,
         avg((created_at - event_time_ms)/1000.0) AS avg_lag,
         max((created_at - event_time_ms)/1000.0) AS max_lag
  FROM telegram_monitor_events
  WHERE created_at IS NOT NULL AND event_time_ms IS NOT NULL
  GROUP BY d ORDER BY d DESC LIMIT 14`).all() as any[]) {
  console.log(`  ${r.d}  n=${r.n}  avg=${Number(r.avg_lag).toFixed(1)}s  max=${fmt(Number(r.max_lag))}`);
}

console.log('-- 近14天全体分布 --');
const lags = (pili.query(`
  SELECT (created_at - event_time_ms)/1000.0 AS lag
  FROM telegram_monitor_events
  WHERE created_at > (SELECT max(created_at) FROM telegram_monitor_events) - 14*86400*1000
    AND event_time_ms IS NOT NULL`).all() as any[]).map((r) => Number(r.lag));
console.log('  ' + describe(lags));

console.log('-- 最近24h按小时 --');
for (const r of pili.query(`
  SELECT datetime((created_at/1000/3600)*3600, 'unixepoch', 'localtime') AS h,
         count(*) AS n,
         avg((created_at - event_time_ms)/1000.0) AS avg_lag,
         max((created_at - event_time_ms)/1000.0) AS max_lag
  FROM telegram_monitor_events
  WHERE created_at/1000 >= strftime('%s','now','localtime') - 24*3600
    AND event_time_ms IS NOT NULL
  GROUP BY created_at/1000/3600 ORDER BY h`).all() as any[]) {
  console.log(`  ${r.h}  n=${r.n}  avg=${Number(r.avg_lag).toFixed(1)}s  max=${fmt(Number(r.max_lag))}`);
}

console.log('-- 最近24h逐10分钟 --');
for (const r of pili.query(`
  SELECT datetime((created_at/1000/600)*600, 'unixepoch', 'localtime') AS t,
         count(*) AS n,
         avg((created_at - event_time_ms)/1000.0) AS avg_lag,
         max((created_at - event_time_ms)/1000.0) AS max_lag
  FROM telegram_monitor_events
  WHERE created_at/1000 >= strftime('%s','now','localtime') - 24*3600
    AND event_time_ms IS NOT NULL
  GROUP BY created_at/1000/600 ORDER BY t`).all() as any[]) {
  console.log(`  ${r.t}  n=${r.n}  avg=${Number(r.avg_lag).toFixed(1)}s  max=${fmt(Number(r.max_lag))}`);
}

// ---------- newone ----------
const n1 = openReadonly(NEWONE_DB);
console.log('');
console.log('=== B. newone alerts: event_occurred_at(UTC ISO) -> created_at(本地文本) -> delivered_at(UTC ISO) ===');
console.log('-- 按天: 入库延迟 (occurred->created) 与 投递延迟 (occurred->delivered) --');
for (const r of n1.query(`
  SELECT date(${LOCAL_TO_EPOCH_S.replace('X', 'a.created_at')}, 'unixepoch', 'localtime') AS d,
         count(*) AS n,
         avg(${LOCAL_TO_EPOCH_S.replace('X', 'a.created_at')} - strftime('%s', a.event_occurred_at)) AS avg_ingest,
         max(${LOCAL_TO_EPOCH_S.replace('X', 'a.created_at')} - strftime('%s', a.event_occurred_at)) AS max_ingest,
         avg(CASE WHEN a.delivered_at IS NOT NULL THEN ${LOCAL_TO_EPOCH_S.replace('X', 'a.delivered_at')} - strftime('%s', a.event_occurred_at) END) AS avg_deliver,
         max(CASE WHEN a.delivered_at IS NOT NULL THEN ${LOCAL_TO_EPOCH_S.replace('X', 'a.delivered_at')} - strftime('%s', a.event_occurred_at) END) AS max_deliver
  FROM alerts a
  WHERE a.event_occurred_at IS NOT NULL AND a.created_at IS NOT NULL
  GROUP BY d ORDER BY d DESC LIMIT 10`).all() as any[]) {
  console.log(`  ${r.d}  n=${r.n}  ingest avg=${Number(r.avg_ingest).toFixed(1)}s max=${fmt(Number(r.max_ingest))}  deliver avg=${Number(r.avg_deliver ?? 0).toFixed(1)}s max=${fmt(Number(r.max_deliver ?? 0))}`);
}

console.log('-- 近14天 ingest 延迟分布 (occurred->created) --');
const ingestLags = (n1.query(`
  SELECT ${LOCAL_TO_EPOCH_S.replace('X', 'a.created_at')} - strftime('%s', a.event_occurred_at) AS lag
  FROM alerts a
  WHERE a.event_occurred_at IS NOT NULL AND a.created_at IS NOT NULL
    AND a.created_at > datetime('now', '-14 days')`).all() as any[]).map((r) => Number(r.lag));
console.log('  ' + describe(ingestLags));

console.log('-- 近14天 deliver 延迟分布 (occurred->delivered) --');
const deliverLags = (n1.query(`
  SELECT ${LOCAL_TO_EPOCH_S.replace('X', 'a.delivered_at')} - strftime('%s', a.event_occurred_at) AS lag
  FROM alerts a
  WHERE a.event_occurred_at IS NOT NULL AND a.delivered_at IS NOT NULL
    AND a.delivered_at > datetime('now', '-14 days')`).all() as any[]).map((r) => Number(r.lag));
console.log('  ' + describe(deliverLags));

console.log('-- alerts 大延迟(>10min) 近3天 top20 --');
for (const r of n1.query(`
  SELECT datetime(strftime('%s', a.event_occurred_at), 'unixepoch', 'localtime') AS occ,
         ${LOCAL_TO_EPOCH_S.replace('X', 'a.delivered_at')} - strftime('%s', a.event_occurred_at) AS lag,
         a.rule_key, a.source
  FROM alerts a
  WHERE a.delivered_at IS NOT NULL
    AND ${LOCAL_TO_EPOCH_S.replace('X', 'a.delivered_at')} - strftime('%s', a.event_occurred_at) > 600
    AND a.delivered_at > datetime('now', '-3 days')
  ORDER BY lag DESC LIMIT 20`).all() as any[]) {
  console.log(`  ${r.occ}  lag=${fmt(Number(r.lag))}  rule=${r.rule_key ?? '-'} src=${r.source ?? '-'}`);
}

console.log('');
console.log('=== D. newone raw_observations: observed_at(UTC ISO) -> fetched_at(本地文本) GMGN 拉取延迟 ===');
console.log('-- 按天 (provider=gmgn) --');
for (const r of n1.query(`
  SELECT date(${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')}, 'unixepoch', 'localtime') AS d,
         count(*) AS n,
         avg(${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at)) AS avg_gap,
         max(${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at)) AS max_gap
  FROM raw_observations
  WHERE provider='gmgn' AND fetched_at IS NOT NULL AND observed_at IS NOT NULL
  GROUP BY d ORDER BY d DESC LIMIT 10`).all() as any[]) {
  console.log(`  ${r.d}  n=${r.n}  avg=${fmt(Number(r.avg_gap))}  max=${fmt(Number(r.max_gap))}`);
}

console.log('-- 近14天 gmgn gap 分布 --');
const gaps = (n1.query(`
  SELECT ${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at) AS gap
  FROM raw_observations
  WHERE provider='gmgn' AND fetched_at IS NOT NULL AND observed_at IS NOT NULL
    AND fetched_at > datetime('now', '-14 days')`).all() as any[]).map((r) => Number(r.gap));
console.log('  ' + describe(gaps));

console.log('-- gmgn 大 gap(>10min) 近3天 top25 --');
for (const r of n1.query(`
  SELECT datetime(strftime('%s', observed_at), 'unixepoch', 'localtime') AS obs,
         ${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at) AS gap,
         data_type
  FROM raw_observations
  WHERE provider='gmgn' AND fetched_at IS NOT NULL AND observed_at IS NOT NULL
    AND ${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at) > 600
    AND fetched_at > datetime('now', '-3 days')
  ORDER BY gap DESC LIMIT 25`).all() as any[]) {
  console.log(`  ${r.obs}  gap=${fmt(Number(r.gap))}  ${r.data_type ?? '-'}`);
}

console.log('-- pili provider gap 分布 (对照) 近14天 --');
const pgaps = (n1.query(`
  SELECT ${LOCAL_TO_EPOCH_S.replace('X', 'fetched_at')} - strftime('%s', observed_at) AS gap
  FROM raw_observations
  WHERE provider='pili' AND fetched_at IS NOT NULL AND observed_at IS NOT NULL
    AND fetched_at > datetime('now', '-14 days')`).all() as any[]).map((r) => Number(r.gap));
console.log('  ' + describe(pgaps));

pili.close();
n1.close();
