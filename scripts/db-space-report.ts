/**
 * db-space-report.ts — pili web3-feed.sqlite 空间周报（只读）
 *
 * 用法:
 *   cd ~/vibecoding/pilipili
 *   npx tsx scripts/db-space-report.ts
 *   PILIPILI_DB_PATH=... npx tsx scripts/db-space-report.ts
 */
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function resolveDbPath(): string {
  const custom = (process.env.PILIPILI_DB_PATH || "").trim();
  if (custom) return path.resolve(custom);
  const dataDir = (process.env.PILIPILI_DATA_DIR || "").trim();
  if (dataDir) return path.join(path.resolve(dataDir), "web3-feed.sqlite");
  return path.join(process.cwd(), ".data", "web3-feed.sqlite");
}

function openReadonly(dbPath: string) {
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (
        f: string,
        o?: { readonly?: boolean },
      ) => {
        prepare(s: string): { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
        close(): void;
      };
    };
    return new Database(dbPath, { readonly: true });
  } catch {
    const Better = require("better-sqlite3") as new (
      f: string,
      o?: { readonly?: boolean },
    ) => {
      prepare(s: string): { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
      close(): void;
    };
    return new Better(dbPath, { readonly: true });
  }
}

function mb(n: number) {
  return (n / 1024 / 1024).toFixed(1);
}

function main() {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.error("DB not found:", dbPath);
    process.exit(1);
  }
  const st = statSync(dbPath);
  const db = openReadonly(dbPath);

  const page = db.prepare("PRAGMA page_count").get() as { page_count?: number } | number;
  const pageSize = db.prepare("PRAGMA page_size").get() as { page_size?: number } | number;
  const free = db.prepare("PRAGMA freelist_count").get() as
    | { freelist_count?: number }
    | number;
  const pc = typeof page === "number" ? page : Number((page as any)?.page_count ?? 0);
  const ps = typeof pageSize === "number" ? pageSize : Number((pageSize as any)?.page_size ?? 4096);
  const fl = typeof free === "number" ? free : Number((free as any)?.freelist_count ?? 0);
  const logicalMb = (pc * ps) / 1024 / 1024;

  console.log("=== pili DB space report ===");
  console.log("path:", dbPath);
  console.log("file_mb:", mb(st.size));
  console.log("logical_mb:", logicalMb.toFixed(1));
  console.log("page_count:", pc, "page_size:", ps, "freelist_pages:", fl);
  console.log("freelist_mb:", mb(fl * ps));
  console.log("");

  console.log("--- top objects (dbstat) ---");
  try {
    const rows = db
      .prepare(
        `SELECT name, SUM(pgsize) AS bytes
         FROM dbstat
         WHERE name NOT LIKE 'sqlite_%'
         GROUP BY name
         ORDER BY bytes DESC
         LIMIT 15`,
      )
      .all() as Array<{ name: string; bytes: number }>;
    for (const r of rows) {
      console.log(`${mb(Number(r.bytes)).padStart(8)} MB  ${r.name}`);
    }
  } catch (e: any) {
    console.log("dbstat unavailable:", e?.message || e);
  }

  console.log("");
  console.log("--- key table rows ---");
  const tables = [
    "events",
    "activity_feed",
    "twitter_tweets",
    "telegram_monitor_events",
    "telegram_monitor_tx_states",
    "holder_snapshot_runs",
    "holder_snapshot_holders",
    "sync_runs",
    "sync_logs",
    "raw_transactions",
    "completeness_runs",
  ];
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number };
      console.log(`${String(row.c).padStart(8)}  ${t}`);
    } catch {
      console.log(`${"n/a".padStart(8)}  ${t}`);
    }
  }

  try {
    const merges = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name LIKE 'merge_ansem_backup_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    console.log("");
    console.log("--- merge backup tables ---");
    if (!merges.length) console.log("(none)");
    else for (const m of merges) console.log(" ", m.name);
  } catch {
    /* ignore */
  }

  const warnGb = 5;
  if (st.size > warnGb * 1024 * 1024 * 1024) {
    console.log("");
    console.log(`WARN: file > ${warnGb}GB`);
  }

  db.close();
}

main();
