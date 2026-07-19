import 'server-only';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, ...keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Collect free-text fragments from a tweet source_json for CA/ticker extraction.
 * Does not replace fullText; used as supplemental extraction surface.
 */
export function collectTweetSourceTexts(sourceJson: string | null | undefined): string[] {
  if (!sourceJson?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch {
    return [];
  }

  const texts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const next = (value || '').trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    texts.push(next);
  };

  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 8) return;
    if (typeof node === 'string') {
      // Only keep longer strings that look like tweet body / quote body
      if (node.length >= 20) push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;

    // Prefer known text fields
    push(readString(record, 'full_text', 'fullText', 'text', 'quotedContent', 'quoted_content'));
    const note = asRecord(record.note_tweet) || asRecord(record.noteTweet);
    if (note) {
      push(readString(note, 'text', 'full_text', 'fullText'));
      const noteResult = asRecord(note.note_tweet_results) || asRecord(note.result);
      const noteInner = asRecord(noteResult?.result) || noteResult;
      push(readString(asRecord(noteInner), 'text', 'full_text'));
    }

    // Common provider nests
    for (const key of [
      'legacy',
      'raw',
      'tweet',
      'tweet_results',
      'result',
      'quoted_tweet',
      'quotedTweet',
      'quoted_status',
      'quoted_tweet_results',
      'quoted_status_result',
    ]) {
      if (record[key]) walk(record[key], depth + 1);
    }
  };

  walk(parsed, 0);
  return texts;
}

/**
 * Best-effort quoted body text from source_json when quoteTweetId row is missing
 * or relay quotedContent is empty.
 */
export function extractQuotedTextFromSourceJson(sourceJson: string | null | undefined): string {
  if (!sourceJson?.trim()) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch {
    return '';
  }

  const record = asRecord(parsed);
  if (!record) return '';

  // bot2bot relay
  const relay = readString(record, 'quotedContent', 'quoted_content');
  if (relay) return relay;

  // xread / 6551 nested quote
  const candidates: unknown[] = [
    record.quoted_tweet,
    record.quotedTweet,
    record.quoted_status,
    asRecord(record.tweet_results)?.result,
  ];

  const digQuote = (node: unknown, depth = 0): string => {
    if (!node || depth > 6) return '';
    const r = asRecord(node);
    if (!r) return '';

    const direct = asRecord(r.quoted_tweet_results) || asRecord(r.quoted_status_result) || asRecord(r.quoted_tweet);
    const directResult = asRecord(direct?.result) || direct;
    const legacy = asRecord(directResult?.legacy) || asRecord(directResult);
    const text = readString(legacy, 'full_text', 'fullText', 'text');
    if (text) return text;

    for (const key of ['result', 'tweet_results', 'legacy']) {
      const found = digQuote(r[key], depth + 1);
      if (found) return found;
    }
    return '';
  };

  for (const c of candidates) {
    const found = digQuote(c);
    if (found) return found;
  }

  // Full walk fallback for quoted_tweet_results
  const walk = (node: unknown, depth: number): string => {
    if (!node || depth > 8) return '';
    const r = asRecord(node);
    if (!r) {
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
      }
      return '';
    }
    if (r.quoted_tweet_results || r.quoted_status_result) {
      const q = asRecord(r.quoted_tweet_results) || asRecord(r.quoted_status_result);
      const result = asRecord(q?.result) || q;
      const legacy = asRecord(result?.legacy) || asRecord(result);
      const text = readString(legacy, 'full_text', 'fullText', 'text');
      if (text) return text;
    }
    for (const value of Object.values(r)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return '';
  };

  return walk(parsed, 0);
}
