/**
 * Latency probe injector.
 *
 * 模拟「信息源发布时间 → pili 已入库」完成的瞬间：向 events 表写入一条
 * 带已知时间戳（= now）的探针事件，然后 bump feed revision，让前端 5s
 * 轮询能感知变化。渲染耗时由浏览器端探测（见 latency-probe-*.mjs 系列）。
 *
 * 用法: NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/latency-probe-inject.ts <tag>
 * 输出: { probeId, marker, ts }  JSON
 */
import { getDb } from '@/lib/server/sqlite';
import { bumpFeedRevision } from '@/lib/server/feedRevision';

const tag = process.argv[2] || String(Date.now());
const db = getDb();
db.pragma('busy_timeout = 10000');

const template = db
  .prepare(
    `SELECT user_json, activity_json
     FROM events
     WHERE source = 'telegram'
       AND user_id IN (SELECT id FROM tracked_users WHERE COALESCE(monitoring_enabled, 1) = 1)
     ORDER BY timestamp DESC
     LIMIT 1`
  )
  .get() as { user_json: string; activity_json: string } | undefined;
if (!template) {
  throw new Error('no template event found');
}

const now = Date.now();
const user = JSON.parse(template.user_json) as Record<string, unknown>;
const activity = JSON.parse(template.activity_json) as Record<string, unknown>;
const probeId = `probe:${tag}:${now}`;
const marker = `⏱PROBE:${tag}`;

activity.id = probeId;
activity.timestamp = now;
activity.content = `${marker} latency probe ${now}`;

const content = `${marker} latency probe ${now}`;

db.prepare(
  `INSERT INTO events
     (event_id, source, kind, timestamp, user_id, user_name, content,
      ingest_source, metadata_json, payload_json, user_json, activity_json,
      indexed_at, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  probeId,
  'telegram',
  'post',
  now,
  String(user.id ?? ''),
  String(user.name ?? ''),
  content,
  'latency-probe',
  '{}',
  '{}',
  JSON.stringify(user),
  JSON.stringify(activity),
  now,
  now,
  now
);
bumpFeedRevision();

console.log(JSON.stringify({ probeId, marker, ts: now }));
