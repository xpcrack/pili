import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-telegram-channel-migration-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = dbPath;

  try {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
CREATE TABLE telegram_channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  channel_username TEXT,
  channel_title TEXT,
  message_id INTEGER NOT NULL,
  grouped_id TEXT,
  posted_at_ms INTEGER NOT NULL,
  edit_date_ms INTEGER,
  text TEXT NOT NULL DEFAULT '',
  text_entities_json TEXT NOT NULL DEFAULT '[]',
  media_json TEXT NOT NULL DEFAULT '[]',
  link_urls_json TEXT NOT NULL DEFAULT '[]',
  forward_info_json TEXT,
  views INTEGER,
  forwards INTEGER,
  replies INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
    `);
    const now = Date.now();
    legacyDb
      .prepare(
        `INSERT INTO telegram_channel_posts (
          source_id, user_id, channel_chat_id, channel_username, channel_title, message_id, grouped_id,
          posted_at_ms, edit_date_ms, text, text_entities_json, media_json, link_urls_json, forward_info_json,
          views, forwards, replies, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', null, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'source-a',
        'user-a',
        '-100555',
        'legacychannel',
        'Legacy Channel',
        88,
        null,
        now,
        null,
        'older duplicate',
        1,
        1,
        1,
        JSON.stringify({ id: 88, source: 'old' }),
        now,
        now
      );
    legacyDb
      .prepare(
        `INSERT INTO telegram_channel_posts (
          source_id, user_id, channel_chat_id, channel_username, channel_title, message_id, grouped_id,
          posted_at_ms, edit_date_ms, text, text_entities_json, media_json, link_urls_json, forward_info_json,
          views, forwards, replies, raw_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', null, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'source-b',
        'user-b',
        '-100555',
        'legacychannel',
        'Legacy Channel',
        88,
        null,
        now + 1000,
        null,
        'newer duplicate',
        9,
        2,
        3,
        JSON.stringify({ id: 88, source: 'new' }),
        now,
        now + 1000
      );
    legacyDb.close();

    const { getDb } = await import('../lib/server/sqlite');
    const migratedDb = getDb();
    const row = migratedDb
      .prepare(
        `SELECT text, views, raw_json
         FROM telegram_channel_posts
         WHERE channel_chat_id = ?
           AND message_id = ?`
      )
      .get('-100555', 88) as { text: string; views: number; raw_json: string } | undefined;
    assert.ok(row, 'migration should preserve one deduplicated row');
    assert.equal(row?.text, 'newer duplicate');
    assert.equal(row?.views, 9);
    assert.match(row?.raw_json || '', /"source":"new"/);
    const duplicateCountRow = migratedDb
      .prepare(
        `SELECT count(*) AS c
         FROM telegram_channel_posts
         WHERE channel_chat_id = ?
           AND message_id = ?`
      )
      .get('-100555', 88) as { c: number };
    assert.equal(duplicateCountRow.c, 1);

    console.log('PASS telegram channel migration');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
