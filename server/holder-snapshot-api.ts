import type { Hono } from 'hono';

import {
  getHolderSnapshotRunById,
  listHolderSnapshotHolders,
  listHolderSnapshotRuns,
} from '@/lib/server/holderSnapshotRepo';
import { verifyInternalBidToken } from '@/lib/server/internalBidAuth';

function parseBearer(value: string | undefined) {
  const raw = (value || '').trim();
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
}

function hasReadScope(authorization: string | undefined) {
  const token = parseBearer(authorization);
  if (!token) return false;
  const verified = verifyInternalBidToken(token);
  if (!verified.ok) return false;
  const scopes = new Set(String(verified.payload.scope || '').split(/[\s,]+/).filter(Boolean));
  return ['internal:bid:read', 'internal:bid:readwrite', 'internal:bid:write'].some((scope) => scopes.has(scope));
}

function normalizeTokenAddress(value: string, chain: string) {
  const trimmed = value.trim();
  return chain === 'solana' ? trimmed : trimmed.toLowerCase();
}

export function registerHolderSnapshotApiRoutes(api: Hono) {
  api.get('/internal/bid/holder-snapshots/latest', (c) => {
    if (!hasReadScope(c.req.header('authorization'))) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }

    const chain = (c.req.query('chain') || 'solana').trim().toLowerCase();
    const tokenAddress = (c.req.query('tokenAddress') || '').trim();
    if (!tokenAddress) {
      return c.json({ ok: false, error: 'tokenAddress is required' }, 400);
    }
    const tokenAddressLower = normalizeTokenAddress(tokenAddress, chain);
    const topNRaw = Number(c.req.query('topN') || 70);
    const topN = Math.max(1, Math.min(100, Number.isFinite(topNRaw) ? Math.floor(topNRaw) : 70));

    const run = listHolderSnapshotRuns()
      .filter((item) => item.status === 'completed')
      .filter((item) => item.chain === chain && item.tokenAddressLower === tokenAddressLower)
      .sort((a, b) => (b.completedAt || b.requestedAt) - (a.completedAt || a.requestedAt))[0] || null;

    if (!run) {
      return c.json({ ok: false, error: 'snapshot_not_found' }, 404);
    }

    const holders = listHolderSnapshotHolders(run.id).slice(0, topN);
    const withValidCost = holders.filter((row) => (
      typeof row.avgCost === 'number'
      && Number.isFinite(row.avgCost)
      && row.avgCost > 0
      && typeof row.balance === 'number'
      && Number.isFinite(row.balance)
      && row.balance > 0
    ));
    const coverage = holders.length > 0 ? withValidCost.length / holders.length : 0;
    const pricedBalance = withValidCost.reduce((sum, row) => sum + (row.balance || 0), 0);
    const weightedAvgCost = pricedBalance > 0
      ? withValidCost.reduce((sum, row) => sum + (row.avgCost || 0) * (row.balance || 0), 0) / pricedBalance
      : null;

    c.header('Cache-Control', 'no-store');
    return c.json({
      ok: true,
      run,
      topN,
      holders,
      audit: {
        considered: holders.length,
        withValidCost: withValidCost.length,
        coverage,
        weightedAvgCost,
        available: holders.length > 0 && coverage >= 0.7 && weightedAvgCost !== null,
        minCoverage: 0.7,
      },
    });
  });

  api.get('/internal/bid/holder-snapshots/:runId', (c) => {
    if (!hasReadScope(c.req.header('authorization'))) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    const runId = Number(c.req.param('runId'));
    if (!Number.isInteger(runId) || runId <= 0) {
      return c.json({ ok: false, error: 'invalid_run_id' }, 400);
    }
    const run = getHolderSnapshotRunById(runId);
    if (!run) return c.json({ ok: false, error: 'snapshot_not_found' }, 404);
    const holders = listHolderSnapshotHolders(runId);
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, run, holders });
  });
}
