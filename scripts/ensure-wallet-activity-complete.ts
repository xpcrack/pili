/**
 * Ensure pili owns a complete local activity timeline before downstream reads.
 *
 * Input JSON: ["wallet", ...] or [{"address":"wallet"}, ...]
 * Output JSON is always written to --output; stdout remains operational logs.
 */
import './server-only-shim.cjs';

import fs from 'node:fs';

import { backfillWalletTimeline, DEFAULT_TIMELINE_DAYS } from '../lib/server/walletActivityBackfill';
import { inferChainsForAddress } from '../lib/server/gmgnWalletActivity';
import {
  markWalletTimelineFail,
  markWalletTimelineOk,
  readWalletTimelineState,
  WALLET_TIMELINE_COVERAGE_VERSION,
} from '../lib/server/walletTimelineState';
import { listMonitoredUsers, listTrackedUsers } from '../lib/server/trackedUsersRepo';
import type { User } from '../types';

type ResultRow = {
  address: string;
  status: 'fresh' | 'backfilled' | 'failed' | 'untracked';
  mode?: 'full' | 'incremental';
  rawCount?: number;
  upserted?: number;
  error?: string;
};

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

async function writeTimelineState(write: () => void) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      write();
      return;
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const read = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = read('--input');
  const output = read('--output');
  if (!input || !output) throw new Error('usage: --input <json> --output <json>');
  const days = Math.max(8, Number(read('--days') || DEFAULT_TIMELINE_DAYS));
  const freshMs = Math.max(60_000, Number(read('--fresh-ms') || 15 * 60_000));
  return { input, output, days, freshMs };
}

function key(address: string) {
  const value = address.trim();
  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
}

function loadAddresses(inputPath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('input JSON must be an array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const raw = typeof item === 'string' ? item : String((item as { address?: unknown })?.address || '');
    const address = raw.trim();
    const k = key(address);
    if (!address || seen.has(k)) continue;
    seen.add(k);
    out.push(address);
  }
  return out;
}

function usersByAddress() {
  const users = [...listMonitoredUsers(), ...listTrackedUsers()];
  const map = new Map<string, User>();
  for (const user of users) {
    for (const address of user.addresses || []) {
      const k = key(address.address || '');
      if (k && !map.has(k)) map.set(k, user);
    }
  }
  return map;
}

async function main() {
  const opts = parseArgs();
  const addresses = loadAddresses(opts.input);
  const owners = usersByAddress();
  const rows: ResultRow[] = [];

  for (const address of addresses) {
    const now = Date.now();
    const state = readWalletTimelineState(address);
    const requiredStart = now - opts.days * 24 * 60 * 60 * 1000;
    const expectedChains = inferChainsForAddress(address);
    const strictCoverage =
      state != null &&
      state.coverageVersion >= WALLET_TIMELINE_COVERAGE_VERSION &&
      !state.lastError &&
      state.windowStartMs != null &&
      state.windowStartMs <= requiredStart &&
      expectedChains.every((chain) => state.chains.includes(chain));
    const fresh = strictCoverage && state!.lastOkAt != null && now - state!.lastOkAt! <= opts.freshMs;
    if (fresh) {
      rows.push({ address, status: 'fresh' });
      continue;
    }

    const user = owners.get(key(address));
    if (!user) {
      const error = 'address is not registered in pili tracked_addresses';
      rows.push({ address, status: 'untracked', error });
      continue;
    }

    const full = !strictCoverage;
    const overlapMs = 5 * 60_000;
    const sinceMs = full
      ? requiredStart
      : Math.max(requiredStart, Number(state!.lastOkAt || now) - overlapMs);
    let remainingChains = [...expectedChains];
    let rawCount = 0;
    let upserted = 0;
    let finalErrors: Array<{ chain: string; error: string }> = [];
    // A failed request is retried on the next RR key. Since the wrapper skips
    // quarantined egresses, this uses healthy capacity immediately instead of
    // waiting for an unrelated exit's cooldown. Successful chains are not
    // fetched again.
    for (let attempt = 1; attempt <= 4 && remainingChains.length > 0; attempt += 1) {
      const result = await backfillWalletTimeline({
        user,
        address,
        chains: remainingChains,
        days: opts.days,
        sinceMs,
        async: true,
      });
      rawCount += result.rawCount;
      upserted += result.upserted;
      const truncated = new Set(result.chainsTruncated.map((item) => item.chain));
      const proven = new Set(result.chainsOk.filter((chain) => !truncated.has(chain)));
      remainingChains = remainingChains.filter((chain) => !proven.has(chain));
      finalErrors = [
        ...result.chainsFailed,
        ...result.chainsTruncated,
      ];
      if (result.chainsTruncated.length > 0) break;
    }
    const complete = remainingChains.length === 0;
    if (!complete) {
      const error = finalErrors.map((item) => `${item.chain}:${item.error}`).join(';') ||
        `incomplete-chain-coverage:${remainingChains.join(',')}`;
      await writeTimelineState(() => markWalletTimelineFail({ address, error, at: Date.now() }));
      rows.push({ address, status: 'failed', mode: full ? 'full' : 'incremental', error });
      continue;
    }

    await writeTimelineState(() => markWalletTimelineOk({
        address,
        windowDays: opts.days,
        windowStartMs: full ? requiredStart : state!.windowStartMs!,
        chains: expectedChains,
        at: Date.now(),
      }));
    rows.push({
      address,
      status: 'backfilled',
      mode: full ? 'full' : 'incremental',
      rawCount,
      upserted,
    });
  }

  const summary = {
    requested: addresses.length,
    complete: rows.filter((row) => row.status === 'fresh' || row.status === 'backfilled').length,
    failed: rows.filter((row) => row.status === 'failed' || row.status === 'untracked').length,
    rows,
  };
  fs.writeFileSync(opts.output, JSON.stringify(summary, null, 2));
  console.log('[ensure-wallet-activity-complete]', {
    requested: summary.requested,
    complete: summary.complete,
    failed: summary.failed,
  });
  if (summary.failed > 0) process.exitCode = 2;
}

void main().catch((error) => {
  console.error('[ensure-wallet-activity-complete] fatal', error);
  process.exit(1);
});
