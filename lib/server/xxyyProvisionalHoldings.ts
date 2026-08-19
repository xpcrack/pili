import 'server-only';

import { ensureCurrentHoldingsTable } from '@/lib/server/holdingsRefreshRuntime';
import { enqueueHoldingsRefresh } from '@/lib/server/holdingsRefreshQueue';
import { getDb, type DbHandle } from '@/lib/server/sqlite';

const DELAYED_VERIFY_MS = 30 * 60_000;

export type XxyyProvisionalHoldingInput = {
  eventKey: string;
  address: string;
  userId: string;
  chain: string;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenAmount: number | null;
  priceUsd: number | null;
  action: 'buy' | 'sell' | 'send';
  actionVariant: 'open' | 'add' | 'reduce' | 'close' | 'send' | null;
  eventTimeMs: number;
  db?: DbHandle;
  now?: () => number;
};

export type XxyyProvisionalHoldingResult = {
  duplicate: boolean;
  applied: boolean;
  verification: 'delayed' | 'immediate';
  outcome: string;
};

function normalizeChain(chain: string) {
  const value = chain.trim().toLowerCase();
  if (value === 'sol') return 'solana';
  if (value === 'eth') return 'ethereum';
  return value;
}

function isSupportedChain(chain: string) {
  return chain === 'solana' || chain === 'ethereum' || chain === 'bsc' || chain === 'base' || chain === 'robinhood';
}

function verificationTarget(chain: string) {
  return chain === 'robinhood' ? 'robinhood' : chain;
}

function ensureLedger(db: DbHandle) {
  ensureCurrentHoldingsTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS xxyy_holdings_applications (
      event_key TEXT PRIMARY KEY,
      tracked_address_lower TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address_lower TEXT,
      event_time_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_xxyy_holdings_applications_wallet
      ON xxyy_holdings_applications(tracked_address_lower, chain, event_time_ms);
  `);
}

/**
 * Apply one deduplicated XXYY fill as a provisional balance delta.
 * Any ambiguity is fail-closed: preserve the last value and request an
 * immediate authoritative wallet verification.
 */
export function applyXxyyProvisionalHolding(
  input: XxyyProvisionalHoldingInput,
): XxyyProvisionalHoldingResult {
  const db = input.db ?? getDb();
  const nowMs = input.now ? input.now() : Date.now();
  const address = input.address.trim();
  const addressLower = address.toLowerCase();
  const chain = normalizeChain(input.chain);
  const tokenAddress = String(input.tokenAddress || '').trim();
  const tokenLower = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  const eventTimeMs = Math.floor(Number(input.eventTimeMs));
  const eventKey = input.eventKey.trim();

  ensureLedger(db);

  let result: XxyyProvisionalHoldingResult = {
    duplicate: false,
    applied: false,
    verification: 'immediate',
    outcome: 'invalid',
  };

  const apply = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO xxyy_holdings_applications
       (event_key, tracked_address_lower, chain, token_address_lower,
        event_time_ms, outcome, applied_at_ms)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(eventKey, addressLower, chain, tokenLower || null, eventTimeMs || nowMs, nowMs);
    if (inserted.changes === 0) {
      result = { duplicate: true, applied: false, verification: 'delayed', outcome: 'duplicate' };
      return;
    }

    const finish = (outcome: string, applied: boolean, verification: 'delayed' | 'immediate') => {
      db.prepare(`UPDATE xxyy_holdings_applications SET outcome = ? WHERE event_key = ?`).run(outcome, eventKey);
      result = { duplicate: false, applied, verification, outcome };
    };

    const qty = Number(input.tokenAmount);
    const price = Number(input.priceUsd);
    if (
      !eventKey || !address || !input.userId || !isSupportedChain(chain) || !tokenAddress ||
      !Number.isFinite(eventTimeMs) || eventTimeMs <= 0 || input.action === 'send' ||
      !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0
    ) {
      finish('verify_only_invalid_or_ambiguous', false, 'immediate');
      return;
    }

    const status = db.prepare(
      `SELECT refreshed_at FROM current_holdings_wallet_status
       WHERE tracked_address_lower = ? AND chain = ? AND status = 'success'`
    ).get(addressLower, chain) as { refreshed_at?: number } | undefined;
    const existing = db.prepare(
      `SELECT balance, refreshed_at FROM current_holdings
       WHERE tracked_address_lower = ? AND chain = ? AND token_address_lower = ?`
    ).get(addressLower, chain, tokenLower) as { balance?: number | null; refreshed_at?: number } | undefined;
    const newestKnownAt = Math.max(Number(status?.refreshed_at) || 0, Number(existing?.refreshed_at) || 0);
    if (newestKnownAt > eventTimeMs) {
      finish('verify_only_out_of_order', false, 'immediate');
      return;
    }

    const previous = Math.max(0, Number(existing?.balance) || 0);
    const next = input.actionVariant === 'close'
      ? 0
      : input.action === 'buy'
        ? previous + qty
        : Math.max(0, previous - qty);

    db.prepare(
      `INSERT INTO current_holdings (
         tracked_address, tracked_address_lower, user_id, chain,
         token_address, token_address_lower, symbol, name,
         balance, price_usd, value_usd, liquidity_usd, source,
         provisional_updated_at, authoritative_refreshed_at, refreshed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'xxyy_provisional', ?, NULL, ?)
       ON CONFLICT(tracked_address_lower, chain, token_address_lower) DO UPDATE SET
         tracked_address = excluded.tracked_address,
         user_id = excluded.user_id,
         symbol = COALESCE(excluded.symbol, current_holdings.symbol),
         balance = excluded.balance,
         price_usd = excluded.price_usd,
         value_usd = excluded.value_usd,
         source = 'xxyy_provisional',
         provisional_updated_at = excluded.provisional_updated_at,
         refreshed_at = excluded.refreshed_at`
    ).run(
      address,
      addressLower,
      input.userId,
      chain,
      tokenAddress,
      tokenLower,
      input.tokenSymbol,
      next,
      price,
      next * price,
      eventTimeMs,
      eventTimeMs,
    );
    finish(input.actionVariant === 'close' ? 'applied_close' : 'applied_delta', true, 'delayed');
  });
  apply();

  if (!result.duplicate) {
    enqueueHoldingsRefresh(
      { address, chain: verificationTarget(chain), userId: input.userId },
      { delayMs: result.verification === 'immediate' ? 0 : DELAYED_VERIFY_MS },
    );
  }
  return result;
}
