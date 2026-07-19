import './server-only-shim.cjs';

import { queueManualHolderSnapshotRun, runHolderSnapshotCycle } from '@/lib/server/holderSnapshotRuntime';
import { loadWorkerEnv } from './lib/workerLifecycle';

loadWorkerEnv();

function readFlag(name: string) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : '';
}

async function main() {
  const tokenAddress = readFlag('token');
  const tokenSymbol = readFlag('symbol') || null;
  const walletAddress = readFlag('wallet') || undefined;

  if (tokenAddress) {
    const queued = await queueManualHolderSnapshotRun({
      tokenAddress,
      tokenSymbol,
      walletAddress,
    });
    console.log(JSON.stringify({ ok: true, queued }, null, 2));
    return;
  }

  const result = await runHolderSnapshotCycle();
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'error') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
