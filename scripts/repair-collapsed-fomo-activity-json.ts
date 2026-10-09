/**
 * 修复 repair-fomo-trade-post-fields.ts 造成的 activity_json 压扁事故。
 *
 * 事故：2026-10-08 12:02 的 repair-fomo-trade-post-fields.ts 用
 *   `activity = metadata`（同引用）然后把纯 metadata JSON 写进 activity_json，
 *   覆盖了 951 行 fomo trade 帖的完整 activity 结构（丢 id/source/timestamp/metadata 包裹）。
 *   前端搜索 matcher 读 activity.metadata.token 时 TypeError → 全 CA 搜索空结果。
 *
 * 修复：payload_json.activity 里有压扁前的完整原始结构（upsertEventsFromFeedRows 写入）。
 *   重建 = payload.activity 骨架 + 把当前压扁 flat 的全部字段合并进 metadata
 *   （flat 里都是 repair/enrichment 后加的字段，必须保留）。
 *
 * 用法：npx tsx scripts/repair-collapsed-fomo-activity-json.ts [--apply]
 */
import './server-only-shim.cjs';
import { getDb } from '../lib/server/sqlite';

const APPLY = process.argv.includes('--apply');

interface FlatRow {
  rowid: number;
  event_id: string;
  activity_json: string;
  payload_json: string;
}

function main() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rowid, event_id, activity_json, payload_json
       FROM events
       WHERE json_valid(activity_json)
         AND json_extract(activity_json, '$.id') IS NULL`
    )
    .all() as FlatRow[];

  console.log(`[repair-collapsed-activity] rows to fix: ${rows.length} (mode=${APPLY ? 'APPLY' : 'DRY-RUN'})`);

  const update = db.prepare(
    `UPDATE events SET activity_json = ?, updated_at = ? WHERE rowid = ?`
  );

  let fixed = 0;
  let noPayload = 0;
  const now = Date.now();

  const tx = APPLY ? db.transaction(batchRun) : undefined;

  function batchRun(list: FlatRow[]) {
    for (const row of list) {
      let flat: Record<string, unknown>;
      try {
        flat = JSON.parse(row.activity_json);
      } catch {
        console.warn(`  skip (flat parse fail): ${row.event_id}`);
        continue;
      }
      let payloadActivity: Record<string, unknown> | null = null;
      try {
        const payload = JSON.parse(row.payload_json);
        const candidate = payload?.activity;
        if (candidate && typeof candidate === 'object' && candidate.id) {
          payloadActivity = candidate;
        }
      } catch {
        // payload 不可用
      }
      if (!payloadActivity) {
        noPayload += 1;
        console.warn(`  skip (no payload.activity): ${row.event_id}`);
        continue;
      }

      // payload.activity.metadata 是压扁前的 metadata；
      // flat（当前 activity_json）字段是压扁结构 = repair/enrichment 后的 metadata 平铺。
      // 合并：以 payload metadata 为底，flat 全字段覆盖（flat 更新）。
      const rebuiltMetadata: Record<string, unknown> = {
        ...((payloadActivity.metadata as Record<string, unknown>) ?? {}),
        ...flat,
      };
      // flat 顶层可能残留 payload 里就有的顶层字段以外的破坏性字段（如 userId），
      // 全部放 metadata 不放顶层 —— 顶层只认 payload 骨架。
      const rebuilt = {
        ...payloadActivity,
        metadata: rebuiltMetadata,
      };
      if (APPLY) {
        update.run(JSON.stringify(rebuilt), now, row.rowid);
      }
      fixed += 1;
      if (fixed <= 3) {
        console.log(
          `  [${APPLY ? 'fix' : 'dry'}] ${row.event_id.slice(-30)} id=${(rebuilt as { id?: string }).id}`
        );
      }
    }
  }

  if (APPLY && tx) {
    tx(rows);
  } else {
    batchRun(rows);
  }

  console.log(
    `[repair-collapsed-activity] total=${rows.length} fixed=${fixed} noPayload=${noPayload}`
  );
  if (!APPLY) console.log('dry-run only — rerun with --apply to write');
}

main();
