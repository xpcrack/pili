import 'server-only';

import { getDb, type DbHandle } from './sqlite';

// Chain types
export type TokenChain = 'solana' | 'ethereum' | 'bsc' | 'base' | 'hyperevm' | 'hypercore';

export interface Token {
  id: number;
  chain: TokenChain;
  contract_address: string; // For hypercore: token name (e.g. "PURR"), for others: contract address
  tags: string;
  imported_at: number;
}

export interface TokenWithPrice extends Token {
  price: number | null;
  market_cap: number | null;
  price_change_24h: number | null;
  ticker: string | null;
}

const TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  tags TEXT,
  imported_at INTEGER NOT NULL,
  UNIQUE(chain, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_tokens_imported_at ON tokens(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);
`;

let tokensInitialized = false;

function ensureTokensTable(db: DbHandle) {
  if (tokensInitialized) return;
  db.exec(TOKENS_SCHEMA);
  tokensInitialized = true;
}

/** List all tokens, optionally filtered by chain */
export function listTokens(chain?: TokenChain): Token[] {
  const db = getDb();
  ensureTokensTable(db);

  if (chain) {
    return db.prepare('SELECT * FROM tokens WHERE chain = ? ORDER BY imported_at DESC').all(chain) as Token[];
  }
  return db.prepare('SELECT * FROM tokens ORDER BY imported_at DESC').all() as Token[];
}

/** Get a single token by chain + contract_address */
export function getToken(chain: TokenChain, contractAddress: string): Token | null {
  const db = getDb();
  ensureTokensTable(db);
  return db.prepare('SELECT * FROM tokens WHERE chain = ? AND contract_address = ?').get(chain, contractAddress) as Token | null;
}

/** Add a token, ignore if duplicate */
export function addToken(chain: TokenChain, contractAddress: string, tags?: string[]): Token {
  const db = getDb();
  ensureTokensTable(db);

  const tagsStr = tags?.join(' ') ?? '';
  const now = Date.now();

  db.prepare(
    'INSERT OR IGNORE INTO tokens (chain, contract_address, tags, imported_at) VALUES (?, ?, ?, ?)'
  ).run(chain, contractAddress, tagsStr, now);

  return getToken(chain, contractAddress)!;
}

/** Bulk import tokens from text format: "address-tag1 tag2" per line */
export function bulkImportTokens(
  lines: string[],
  defaultChain: TokenChain
): { added: number; skipped: number; errors: string[] } {
  const db = getDb();
  ensureTokensTable(db);

  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO tokens (chain, contract_address, tags, imported_at) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split(/[-\s]+/);
      const address = parts[0]?.trim();
      if (!address) {
        errors.push(`Empty address in line: ${line}`);
        continue;
      }

      const tags = parts.slice(1).join(' ');
      const now = Date.now();

      const result = insertStmt.run(defaultChain, address, tags, now);
      if (result.changes > 0) {
        added++;
      } else {
        skipped++;
      }
    }
  });

  tx();
  return { added, skipped, errors };
}

/** Update tags for a token */
export function updateTokenTags(id: number, tags: string[]): void {
  const db = getDb();
  ensureTokensTable(db);
  db.prepare('UPDATE tokens SET tags = ? WHERE id = ?').run(tags.join(' '), id);
}

/** Delete a token by id */
export function deleteToken(id: number): void {
  const db = getDb();
  ensureTokensTable(db);
  db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
}

/** Delete multiple tokens by ids */
export function deleteTokens(ids: number[]): void {
  const db = getDb();
  ensureTokensTable(db);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM tokens WHERE id IN (${placeholders})`).run(...ids);
}
