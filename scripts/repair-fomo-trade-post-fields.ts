/**
 * 回填 GMGN 交易推送帖（fomoleaderboardfeed）的结构化字段。
 *
 * 背景（2026-10-08）：这类帖子此前从未解析 token/CA/链/成交额/市值，
 * feed 上 ticker 显示 UNKNOWN、MC 列显示 "**$9.03M**"（markdown 星号原文）。
 * projector 已修（lib/server/telegramChannelProjector.ts + fomoTradePostParsing.ts），
 * 本脚本只修存量 events 行。
 *
 * 用法：
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-fomo-trade-post-fields.ts           # dry-run
 *   NODE_OPTIONS='--require ./scripts/server-only-shim.cjs' tsx scripts/repair-fomo-trade-post-fields.ts --apply   # 写库
 */
import './server-only-shim.cjs';

import { getDb } from '../lib/server/sqlite';
import { parseFomoTradePostFields } from '../lib/server/fomoTradePostParsing';

const APPLY = process.argv.includes('--apply');

type Row = {
  rowid: number;
  event_id: string;
  content: string;
  action: string | null;
  token: string | null;
  metadata_json: string;
  activity_json: string;
};

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT rowid, event_id, content, action, token, metadata_json, activity_json
       FROM events
       WHERE content LIKE '%Bought: **%' OR content LIKE '%Proceeds: **%'`
    )
    .all() as Row[];

  console.log(`[repair-fomo-trade-post] candidate rows: ${rows.length} (mode=${APPLY ? 'APPLY' : 'DRY-RUN'})`);

  const update = db.prepare(
    `UPDATE events
     SET token = ?, action = ?, chain = ?, metadata_json = ?, activity_json = ?, updated_at = ?
     WHERE rowid = ?`
  );

  let parsed = 0;
  let skippedAlreadyFilled = 0;
  let unparseable = 0;
  let written = 0;
  const now = Date.now();

  for (const row of rows) {
    const fields = parseFomoTradePostFields(row.content);
    if (!fields || !fields.tokenSymbol || !fields.tradeAmountUsd || fields.marketCapUsd == null) {
      unparseable += 1;
      continue;
    }
    parsed += 1;

    let metadata: Record<string, unknown>;
    let activity: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata_json);
      // activity_json 必须保持完整结构 {id, source, timestamp, ..., metadata:{...}}，
      // 与 metadata_json 绝不是同构 —— 把纯 metadata 写进 activity_json 会压扁事件，
      // 前端搜索 matcher 读 activity.metadata 时 TypeError，CA 搜索全部空结果
      // （2026-10-08 事故，951 行受损，修复脚本 repair-collapsed-fomo-activity-json.ts）。
      activity = JSON.parse(row.activity_json);
      if (!activity || typeof activity !== 'object' || !activity.metadata || typeof activity.metadata !== 'object') {
        // 结构异常的行不动 activity_json，只回填 metadata_json 对应的列
        activity = null as unknown as Record<string, unknown>;
      }
      // 以 metadata_json 为准刷新 metadata 子对象（repair 的字段权威来源）
      activity.metadata = metadata;
    } catch {
      unparseable += 1;
      continue;
    }

    const before = JSON.stringify({
      t: metadata.token ?? null,
      a: metadata.tokenAddress ?? null,
      mc: metadata.marketCapAtTxUsd ?? null,
      usd: metadata.tradeAmountUsdAtTx ?? null,
    });
    const alreadyFilled =
      metadata.token === fields.tokenSymbol &&
      metadata.marketCapAtTxUsd === fields.marketCapUsd &&
      metadata.tradeAmountUsdAtTx === fields.tradeAmountUsd;
    if (alreadyFilled) {
      skippedAlreadyFilled += 1;
      continue;
    }

    metadata.token = fields.tokenSymbol;
    if (fields.tokenAddress) metadata.tokenAddress = fields.tokenAddress;
    if (fields.chain) metadata.chain = fields.chain;
    if (fields.marketCapUsd != null) {
      metadata.marketCapAtTxUsd = fields.marketCapUsd;
      metadata.marketCapAtTxSource = 'gmgn-activity';
    }
    if (fields.tradeAmountUsd != null) {
      metadata.tradeAmountUsdAtTx = fields.tradeAmountUsd;
      metadata.quoteAmount = String(fields.tradeAmountUsd);
      metadata.quoteToken = 'USD';
    }
    // 展示字段：让 MC 列立即显示干净文本
    metadata.displayTokenSymbol = fields.tokenSymbol.toUpperCase();
    metadata.displayMarketCapText = formatCompactMarketCap(fields.marketCapUsd);
    metadata.displayTradeAmountText = formatCompactUsd(fields.tradeAmountUsd);

    const after = JSON.stringify({
      t: metadata.token ?? null,
      a: metadata.tokenAddress ?? null,
      mc: metadata.marketCapAtTxUsd ?? null,
      usd: metadata.tradeAmountUsdAtTx ?? null,
    });
    if (before === after) {
      skippedAlreadyFilled += 1;
      continue;
    }

    if (!activity) {
      unparseable += 1;
      continue;
    }
    const metadataJson = JSON.stringify(metadata);
    const activityJson = JSON.stringify(activity);
    if (!APPLY) {
      written += 1;
      if (written <= 3) {
        console.log(`  [dry] ${row.event_id.slice(-24)} → ${fields.tokenSymbol} mc=${metadata.displayMarketCapText} usd=${metadata.displayTradeAmountText}`);
      }
      continue;
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        update.run(fields.tokenSymbol, fields.tradeAction || row.action, fields.chain, metadataJson, activityJson, now, row.rowid);
        written += 1;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/SQLITE_BUSY|database is locked/i.test(message) || attempt === 9) throw error;
        await sleepMs(300 * (attempt + 1));
      }
    }
  }

  console.log(
    `[repair-fomo-trade-post] parsed=${parsed} written=${written} alreadyFilled=${skippedAlreadyFilled} unparseable=${unparseable}`
  );
  if (!APPLY) console.log('dry-run only — rerun with --apply to write');
}

function formatCompactMarketCap(usd: number): string {
  if (usd >= 1_000_000_000) return `${trimZeros(usd / 1_000_000_000)}B`;
  if (usd >= 1_000_000) return `${trimZeros(usd / 1_000_000)}M`;
  if (usd >= 1_000) return `${trimZeros(usd / 1_000)}K`;
  return String(Math.round(usd));
}

function formatCompactUsd(usd: number): string {
  return `$${formatCompactMarketCap(usd)}`;
}

function trimZeros(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
