import 'server-only';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown> | null, ...keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function collectMediaFromEntities(entities: unknown, into: Set<string>) {
  const mediaItems = asArray(asRecord(entities)?.media);
  for (const item of mediaItems) {
    const record = asRecord(item);
    if (!record) continue;
    const type = (readString(record, 'type') || '').toLowerCase();
    if (type && type !== 'photo' && type !== 'animated_gif') {
      continue;
    }
    const url =
      readString(record, 'media_url_https', 'media_url', 'mediaUrl', 'url') ||
      readString(asRecord(record.media_info), 'media_url_https', 'media_url');
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    // Skip obvious video file extensions; still allow gif/jpg/png/webp
    if (/\.(mp4|m3u8|mov)(\?|$)/i.test(url)) continue;
    into.add(url);
  }
}

function walkForMedia(node: unknown, into: Set<string>, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkForMedia(item, into, depth + 1);
    }
    return;
  }
  const record = asRecord(node);
  if (!record) return;

  if (record.entities || record.extended_entities) {
    collectMediaFromEntities(record.entities, into);
    collectMediaFromEntities(record.extended_entities, into);
  }
  if (record.legacy) {
    walkForMedia(record.legacy, into, depth + 1);
  }
  if (record.raw) {
    walkForMedia(record.raw, into, depth + 1);
  }
  // Shallow scan common provider payload containers without deep-walking entire trees
  for (const key of ['tweet', 'quoted_tweet', 'quotedTweet', 'result', 'legacy']) {
    if (record[key]) {
      walkForMedia(record[key], into, depth + 1);
    }
  }
}

/**
 * Extract temporary image URLs from a stored tweet's source_json.
 * URLs are returned for one-shot vision calls only — never persist them.
 */
export function listImageUrlsFromSourceJson(sourceJson: string | null | undefined): string[] {
  if (!sourceJson || !sourceJson.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch {
    return [];
  }

  const record = asRecord(parsed);
  if (!record) {
    return [];
  }

  // bot2bot relay rarely carries raw media entities
  const provider = readString(record, 'provider');
  if (provider === 'bot2bot') {
    // Still try quoted/source fragments in case they include media later
  }

  const urls = new Set<string>();
  walkForMedia(record, urls);
  if (record.raw) {
    walkForMedia(record.raw, urls);
  }

  return Array.from(urls).slice(0, 4);
}
