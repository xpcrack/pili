/**
 * Backfill positionDeltaRatio (+ open/close upgrades) for recent trades.
 *
 * Thin CLI wrapper over lib/server/positionDeltaService — the same service
 * the runtime task `position-delta-fill` runs every 10 minutes.
 *
 * Usage:
 *   npx tsx scripts/backfill-position-delta.ts --dry
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db --days=14 --lookback-days=60
 *   npx tsx scripts/backfill-position-delta.ts --force-prod-db --force-recompute
 */

import './server-only-shim.cjs';

import { runPositionDeltaFill } from '../lib/server/positionDeltaService';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

function parseArgs(argv: string[]) {
  let days = 14;
  let lookbackDays = 60;
  let dry = false;
  let forceProd = false;
  let forceRecompute = false;
  for (const arg of argv) {
    if (arg.startsWith('--days=')) {
      const n = Number.parseInt(arg.slice('--days='.length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    } else if (arg.startsWith('--lookback-days=')) {
      const n = Number.parseInt(arg.slice('--lookback-days='.length), 10);
      if (Number.isFinite(n) && n > 0) lookbackDays = n;
    } else if (arg === '--dry') {
      dry = true;
    } else if (arg === '--force-prod-db') {
      forceProd = true;
    } else if (arg === '--force-recompute') {
      forceRecompute = true;
    }
  }
  if (lookbackDays < days) lookbackDays = days;
  return { days, lookbackDays, dry, forceProd, forceRecompute };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.forceProd) {
    process.env.PILIPILI_ALLOW_PROD_DB_HEAVY = '1';
  }
  exitIfProdDbHeavyJobBlocked({ jobName: 'backfill-position-delta' });

  console.log(
    `[position-delta] days=${args.days} lookback=${args.lookbackDays} dry=${args.dry} forceRecompute=${args.forceRecompute}`
  );

  const result = runPositionDeltaFill({
    days: args.days,
    lookbackDays: args.lookbackDays,
    dry: args.dry,
    forceRecompute: args.forceRecompute,
  });

  console.log(JSON.stringify({ dry: args.dry, ...result }, null, 2));
}

main();
