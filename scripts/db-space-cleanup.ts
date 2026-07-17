/**
 * db-space-cleanup.ts — 安全瘦身：.bak 文件 + merge_ansem 残表 + 可选 VACUUM
 *
 * 用法:
 *   cd ~/vibecoding/pilipili
 *   npx tsx scripts/db-space-cleanup.ts --dry-run
 *   npx tsx scripts/db-space-cleanup.ts --apply
 *   npx tsx scripts/db-space-cleanup.ts --apply --vacuum
 *
 * 不碰 events / feed / twitter / monitor 业务表。
 */
import { createRequire } from "node:module";
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || !args.includes("--apply");
const doApply = args.includes("--apply");
const doVacuum = args.includes("--vacuum");

function resolveDbPath(): string {
  const custom = (process.env.PILIPILI_DB_PATH || "").trim();
  if (custom) return path.resolve(custom);
  const dataDir = (process.env.PILIPILI_DATA_DIR || "").trim();
  if (dataDir) return path.join(path.resolve(dataDir), "web3-feed.sqlite");
  return path.join(process.cwd(), ".data", "web3-feed.sqlite");
}

function openDb(dbPath: string, readonly = false) {
  try {
    const { Database } = require("bun:sqlite") as {
      Database: new (
        f: string,
        o?: { readonly?: boolean },
      ) => {
        prepare(s: string): {
          get: (...a: unknown[]) => unknown;
          all: (...a: unknown[]) => unknown[];
          run: (...a: unknown[]) => { changes: number };
        };
        exec(s: string): void;
        close(): void;
      };
    };
    return new Database(dbPath, { readonly });
  } catch {
    const Better = require("better-sqlite3") as new (
      f: string,
      o?: { readonly?: boolean },
    ) => {
      prepare(s: string): {
        get: (...a: unknown[]) => unknown;
        all: (...a: unknown[]) => unknown[];
        run: (...a: unknown[]) => { changes: number };
      };
      exec(s: string): void;
      close(): void;
    };
    return new Better(dbPath, { readonly });
  }
}

function mb(n: number) {
  return (n / 1024 / 1024).toFixed(1);
}

function listBakFiles(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((n) => n.startsWith("web3-feed.sqlite.bak"))
    .map((n) => path.join(dataDir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function main() {
  const dbPath = resolveDbPath();
  const dataDir = path.dirname(dbPath);
  console.log("=== pili DB space cleanup ===");
  console.log("mode:", doApply ? (doVacuum ? "apply+vacuum" : "apply") : "dry-run");
  console.log("db:", dbPath);
  console.log("");

  if (!existsSync(dbPath)) {
    console.error("DB not found");
    process.exit(1);
  }

  // --- bak files ---
  const baks = listBakFiles(dataDir);
  let bakBytes = 0;
  console.log("--- disk .bak files ---");
  if (!baks.length) console.log("(none)");
  for (const f of baks) {
    const sz = statSync(f).size;
    bakBytes += sz;
    console.log(`  ${mb(sz).padStart(8)} MB  ${path.basename(f)}`);
  }
  console.log(`  total bak: ${mb(bakBytes)} MB`);

  // --- merge tables ---
  const ro = openDb(dbPath, true);
  const merges = ro
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name LIKE 'merge_ansem_backup_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  let mergeBytes = 0;
  console.log("");
  console.log("--- merge_ansem_backup_* tables ---");
  if (!merges.length) console.log("(none)");
  for (const m of merges) {
    try {
      const row = ro
        .prepare(`SELECT SUM(pgsize) AS b FROM dbstat WHERE name = ?`)
        .get(m.name) as { b: number | null };
      const b = Number(row?.b || 0);
      mergeBytes += b;
      console.log(`  ${mb(b).padStart(8)} MB  ${m.name}`);
    } catch {
      console.log(`  ${"?".padStart(8)}      ${m.name}`);
    }
  }
  console.log(`  total merge: ${mb(mergeBytes)} MB (reclaim after VACUUM)`);
  ro.close();

  console.log("");
  console.log(
    `estimated free: disk ~${mb(bakBytes)} MB + db after vacuum ~${mb(mergeBytes)} MB`,
  );

  if (!doApply) {
    console.log("");
    console.log("dry-run only. Re-run with --apply [--vacuum]");
    return;
  }

  // apply bak
  console.log("");
  console.log("--- apply: remove .bak ---");
  for (const f of baks) {
    unlinkSync(f);
    console.log("  rm", path.basename(f));
  }

  // apply DROP merge
  console.log("--- apply: DROP merge tables ---");
  const rw = openDb(dbPath, false);
  for (const m of merges) {
    // only allow exact merge_ansem_backup_ prefix
    if (!/^merge_ansem_backup_[a-zA-Z0-9_]+$/.test(m.name)) {
      console.warn("  skip unsafe name", m.name);
      continue;
    }
    rw.exec(`DROP TABLE IF EXISTS "${m.name}"`);
    console.log("  DROP", m.name);
  }
  rw.close();

  if (doVacuum) {
    console.log("--- apply: VACUUM INTO ---");
    const out = path.join(dataDir, `web3-feed.vacuumed.${Date.now()}.sqlite`);
    const pre = path.join(
      dataDir,
      `web3-feed.sqlite.pre-cleanup-${new Date().toISOString().slice(0, 10)}`,
    );
    // snapshot name only if not huge free disk concern — skip full pre-copy (2.2G);
    // VACUUM INTO is the safe shrink path
    const vac = openDb(dbPath, false);
    try {
      vac.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
      vac.close();
      const before = statSync(dbPath).size;
      const after = statSync(out).size;
      console.log(`  vacuumed ${mb(before)} MB → ${mb(after)} MB`);
      console.log(`  wrote ${path.basename(out)}`);
      console.log(
        "  manual replace when idle:",
      );
      console.log(`    mv ${path.basename(dbPath)} ${path.basename(pre)}.live`);
      console.log(`    mv ${path.basename(out)} ${path.basename(dbPath)}`);
      console.log("  (not auto-swapped — stop writers first)");
    } catch (e: any) {
      try {
        vac.close();
      } catch {
        /* ignore */
      }
      console.error("  VACUUM failed:", e?.message || e);
      process.exit(1);
    }
  }

  console.log("");
  console.log("done.");
}

main();
