import { getDb } from '@/lib/server/sqlite';

export function bumpFeedRevision() {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO feed_content_revision (singleton_key, revision, updated_at)
     VALUES ('main', 1, ?)
     ON CONFLICT(singleton_key) DO UPDATE SET
       revision = revision + 1,
       updated_at = excluded.updated_at`
  ).run(now);
}

export function readFeedRevision(): string {
  const db = getDb();
  const row = db.prepare(
    `SELECT revision FROM feed_content_revision WHERE singleton_key = 'main' LIMIT 1`
  ).get() as { revision: number } | undefined;
  return String(row?.revision ?? 0);
}
