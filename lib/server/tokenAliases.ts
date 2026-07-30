import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Token alias registry — lets the mention extractor recognize a token by its
 * full name / alternate spellings (e.g. $Z whose project name is "gen z" / "Z世代"),
 * not just by its `$TICKER` cashtag or contract address.
 *
 * Matching here only PRODUCES candidates; the final "is this tweet really about
 * the token (vs the generic phrase)" judgment is done by the Chinese-capable LLM
 * in nvidiaEnrichmentModel.confirmAliasReferences, and only for monitored KOLs.
 *
 * Config file: .data/token-aliases.json (hot-reloaded on mtime change).
 */

export interface TokenAliasEntry {
  chain: string;
  /** canonical, lowercased contract address */
  address: string;
  /** uppercase ticker, e.g. "Z" */
  symbol: string;
  /** full project name, e.g. "gen z" (may be null) */
  name: string | null;
  /** match phrases with original casing, for the LLM prompt */
  rawAliases: string[];
}

interface RawConfig {
  tokens?: Array<{
    chain?: string;
    address?: string;
    symbol?: string;
    name?: string | null;
    aliases?: string[];
  }>;
}

const CONFIG_PATH = path.join(process.cwd(), '.data', 'token-aliases.json');

/** Aliases shorter than this are too generic to substring-match (1-char flood). */
const MIN_ALIAS_LEN = 2;

let cachedMtimeMs = -1;
let cachedEntries: TokenAliasEntry[] = [];

function parseConfigFile(): TokenAliasEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return [];
  }
  let cfg: RawConfig;
  try {
    cfg = JSON.parse(raw) as RawConfig;
  } catch {
    console.warn('[token-aliases] failed to parse', CONFIG_PATH);
    return [];
  }
  const entries: TokenAliasEntry[] = [];
  for (const t of cfg.tokens || []) {
    const address = (t.address || '').trim().toLowerCase();
    const symbol = (t.symbol || '').trim().toUpperCase();
    if (!address || !symbol) continue;
    const rawAliases = Array.from(
      new Set(
        [t.name, ...(t.aliases || [])]
          .map((a) => (a || '').trim())
          .filter((a) => a.length >= MIN_ALIAS_LEN),
      ),
    );
    if (rawAliases.length === 0) continue;
    entries.push({
      chain: (t.chain || '').trim().toLowerCase(),
      address,
      symbol,
      name: (t.name || '').trim() || null,
      rawAliases,
    });
  }
  return entries;
}

function readConfig(): TokenAliasEntry[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(CONFIG_PATH);
  } catch {
    if (cachedMtimeMs !== -1) {
      cachedEntries = [];
      cachedMtimeMs = -1;
    }
    return cachedEntries;
  }
  if (stat.mtimeMs === cachedMtimeMs) return cachedEntries;
  cachedEntries = parseConfigFile();
  cachedMtimeMs = stat.mtimeMs;
  return cachedEntries;
}

/** All configured alias entries (mainly for tests / inspection). */
export function getTokenAliasEntries(): TokenAliasEntry[] {
  return readConfig();
}

export interface AliasHit {
  entry: TokenAliasEntry;
  /** the alias phrase that matched, original casing */
  matchedAlias: string;
}

/**
 * Scan text for any configured alias. One hit per token (first alias wins).
 * Case-insensitive; CJK unaffected by lowercasing.
 */
export function findAliasHits(text: string): AliasHit[] {
  if (!text) return [];
  const entries = readConfig();
  if (entries.length === 0) return [];
  const lower = text.toLowerCase();
  const hits: AliasHit[] = [];
  const seenAddr = new Set<string>();
  for (const entry of entries) {
    if (seenAddr.has(entry.address)) continue;
    for (const rawAlias of entry.rawAliases) {
      if (lower.includes(rawAlias.toLowerCase())) {
        hits.push({ entry, matchedAlias: rawAlias });
        seenAddr.add(entry.address);
        break;
      }
    }
  }
  return hits;
}
