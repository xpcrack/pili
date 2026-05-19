import './server-only-shim.cjs';

async function run() {
  const { backfillActivityImportance } = await import('@/lib/server/activityImportanceBackfill');
  await backfillActivityImportance();
  console.log('activity importance backfill: ok');
}

void run();
