import './server-only-shim.cjs';

import { backfillTelegramMonitorEventByTxHash } from '../lib/server/telegramMonitorBackfill';

function parseArgs(argv: string[]) {
  let txHash = '';
  let apply = false;

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--tx=')) {
      txHash = arg.slice('--tx='.length).trim();
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run telegram:monitor:backfill -- --tx=0x... [--apply]');
      process.exit(0);
    }
  }

  return { txHash, apply };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.txHash) {
    throw new Error('missing --tx=<transaction hash>; dry-run is the default, --apply is required to write');
  }

  const result = await backfillTelegramMonitorEventByTxHash(args.txHash, { dryRun: !args.apply });
  console.log(JSON.stringify({ ...result, applied: args.apply && result.status === 'projected' }, null, 2));

  if (result.status === 'not-found' || result.status === 'unmatched-user' || result.status === 'invalid-event') {
    process.exitCode = 2;
  } else if (result.status === 'projection-failed') {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
