/**
 * Prevent long-running maintenance scripts from locking the production SQLite
 * while pili web / telegram workers are online.
 *
 * Override: PILIPILI_ALLOW_PROD_DB_HEAVY=1  or  --force-prod-db
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const DEFAULT_PROD_MARKERS = [
  'server/runtime.ts',
  'scripts/telegram-bridge.ts',
  'scripts/telegram-channel-worker.ts',
  'bun server/runtime.ts',
];

function resolveTargetDbPath(cwd = process.cwd()) {
  const customDbPath = (process.env.PILIPILI_DB_PATH || '').trim();
  if (customDbPath) {
    return path.resolve(customDbPath);
  }
  const customDataDir = (process.env.PILIPILI_DATA_DIR || '').trim();
  if (customDataDir) {
    return path.join(path.resolve(customDataDir), 'web3-feed.sqlite');
  }
  return path.join(cwd, '.data', 'web3-feed.sqlite');
}

function isDefaultProdDb(dbPath: string, cwd = process.cwd()) {
  const prodPath = path.resolve(cwd, '.data', 'web3-feed.sqlite');
  return path.resolve(dbPath) === prodPath;
}

function listMatchingPids(markers: string[]) {
  let psOut = '';
  try {
    psOut = execSync('ps -axo pid=,command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [] as Array<{ pid: string; command: string }>;
  }

  const selfPid = String(process.pid);
  const hits: Array<{ pid: string; command: string }> = [];
  for (const line of psOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const pid = trimmed.slice(0, space).trim();
    const command = trimmed.slice(space + 1).trim();
    if (!pid || pid === selfPid) continue;
    if (markers.some((marker) => command.includes(marker))) {
      hits.push({ pid, command });
    }
  }
  return hits;
}

export type ProdDbGuardResult =
  | { ok: true; skipped: false; dbPath: string }
  | { ok: true; skipped: true; reason: string; dbPath: string }
  | { ok: false; dbPath: string; blockers: Array<{ pid: string; command: string }>; message: string };

/**
 * Call at the start of heavy scripts (backfill, rebuild FTS, vacuum, etc.).
 * Returns ok:false when the default production DB is targeted and live pili
 * processes are holding it.
 */
export function assertProdDbHeavyJobAllowed(opts?: {
  argv?: string[];
  cwd?: string;
  markers?: string[];
  jobName?: string;
}): ProdDbGuardResult {
  const argv = opts?.argv ?? process.argv.slice(2);
  const cwd = opts?.cwd ?? process.cwd();
  const markers = opts?.markers ?? DEFAULT_PROD_MARKERS;
  const jobName = opts?.jobName || 'heavy job';
  const dbPath = resolveTargetDbPath(cwd);

  const force =
    argv.includes('--force-prod-db') ||
    (process.env.PILIPILI_ALLOW_PROD_DB_HEAVY || '').trim() === '1';

  if (!isDefaultProdDb(dbPath, cwd)) {
    return { ok: true, skipped: true, reason: 'non-prod db path', dbPath };
  }

  if (force) {
    return { ok: true, skipped: false, dbPath };
  }

  const blockers = listMatchingPids(markers);
  if (blockers.length === 0) {
    return { ok: true, skipped: false, dbPath };
  }

  const lines = blockers
    .slice(0, 8)
    .map((b) => `  pid=${b.pid}  ${b.command.slice(0, 160)}`)
    .join('\n');
  const message = [
    `[prod-db-guard] refused ${jobName} against production DB:`,
    `  ${dbPath}`,
    `live pili processes still hold the DB:`,
    lines,
    blockers.length > 8 ? `  ...and ${blockers.length - 8} more` : '',
    `Stop them first, or point PILIPILI_DB_PATH at a copy, or pass --force-prod-db / PILIPILI_ALLOW_PROD_DB_HEAVY=1`,
  ]
    .filter(Boolean)
    .join('\n');

  return { ok: false, dbPath, blockers, message };
}

export function exitIfProdDbHeavyJobBlocked(opts?: Parameters<typeof assertProdDbHeavyJobAllowed>[0]) {
  const result = assertProdDbHeavyJobAllowed(opts);
  if (!result.ok) {
    console.error(result.message);
    process.exit(2);
  }
  return result;
}
