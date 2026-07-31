import './server-only-shim.cjs';
import { exitIfProdDbHeavyJobBlocked } from './lib/prodDbGuard';

async function run() {
  exitIfProdDbHeavyJobBlocked({ jobName: 'importance score backfill' });
  const { backfillActivityImportance } = await import('@/lib/server/activityImportanceBackfill');
  await backfillActivityImportance();
  console.log('activity importance backfill: ok');
}

void run();
