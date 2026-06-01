import './server-only-shim.cjs';
import { fetchOkxAddressAssetDetails } from '@/lib/okx';
import { loadRuntimeEnv } from '@/server/env';

async function run() {
  loadRuntimeEnv(process.cwd());

  const entries = [
    { chain: 'solana', address: 'CJ5fHkNPf3yd7fKnjv5VtBJTNDAWFiRfLCutpuTAnpis' },
    { chain: 'bsc', address: '0xa9a4ae9ee3888085574aed126ea6d6d3887e9c9d' },
    { chain: 'ethereum', address: '0xa9a4ae9ee3888085574aed126ea6d6d3887e9c9d' },
    { chain: 'base', address: '0xa9a4ae9ee3888085574aed126ea6d6d3887e9c9d' },
  ] as const;

  for (const item of entries) {
    const result = await fetchOkxAddressAssetDetails(item.address, item.chain as any);
    const total = Array.isArray(result.assets)
      ? result.assets.reduce((sum, asset) => sum + (Number.isFinite(asset.valueUsd) ? asset.valueUsd : 0), 0)
      : null;
    console.log(JSON.stringify({
      chain: item.chain,
      address: item.address,
      ok: result.ok,
      configured: result.configured,
      error: result.error,
      assetCount: result.assets?.length ?? null,
      total,
      top: (result.assets || []).slice(0, 5).map((a) => ({ symbol: a.symbol, valueUsd: a.valueUsd })),
    }));
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
