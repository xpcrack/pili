import { Activity, User } from '@/types';

export const SEARCH_FIELDS = ['person', 'address', 'tx', 'ca', 'ticker', 'action'] as const;
export const ACTION_VALUES = ['buy', 'sell', 'send', 'receive'] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];
type ActionValue = (typeof ACTION_VALUES)[number];

export interface SearchToken {
  field: SearchField;
  value: string;
}

export interface ParsedSearchQuery {
  tokens: SearchToken[];
  freeTextTerms: string[];
}

export interface FeedItem {
  user: User;
  activity: Activity;
}

export interface SearchSuggestion {
  label: string;
  insertText: string;
  kind: 'field' | 'value';
}

export interface SearchSuggestionSources {
  personValues: string[];
  addressValues: string[];
  txValues: string[];
  caValues: string[];
  tickerValues: string[];
}

function normalizeText(value: string | undefined | null) {
  return (value || '').trim().toLowerCase();
}

function includesNormalized(value: string, query: string) {
  if (!query) return false;
  return normalizeText(value).includes(query);
}

function isSearchField(value: string): value is SearchField {
  return (SEARCH_FIELDS as readonly string[]).includes(value);
}

function uniqueSorted(values: Iterable<string>) {
  const deduped = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeText(trimmed);
    if (!key || deduped.has(key)) continue;
    deduped.set(key, trimmed);
  }
  return Array.from(deduped.values()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function getTokenValues(item: FeedItem, field: SearchField) {
  const { user, activity } = item;
  if (field === 'person') {
    return [
      user.name,
      user.handle,
      user.twitter,
      user.telegram,
      ...user.tags,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  if (field === 'address') {
    return [
      ...user.addresses.map((address) => address.address),
      activity.metadata.fromAddress,
      activity.metadata.toAddress,
      activity.metadata.trackedAddress,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }

  if (field === 'tx') {
    return activity.metadata.txHash ? [activity.metadata.txHash] : [];
  }

  if (field === 'ca') {
    return activity.metadata.tokenAddress ? [activity.metadata.tokenAddress] : [];
  }

  if (field === 'ticker') {
    return activity.metadata.token ? [activity.metadata.token] : [];
  }

  const txAction = normalizeText(activity.metadata.txAction);
  return txAction ? [txAction] : [];
}

function getFreeTextValues(item: FeedItem) {
  const { user, activity } = item;
  return [
    user.name,
    user.handle,
    user.twitter,
    user.telegram,
    ...user.tags,
    ...user.addresses.map((address) => address.address),
    activity.title,
    activity.content,
    activity.metadata.txHash,
    activity.metadata.token,
    activity.metadata.tokenAddress,
    activity.metadata.fromAddress,
    activity.metadata.toAddress,
    activity.metadata.trackedAddress,
    activity.metadata.txAction,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const segments = input.trim().split(/\s+/).filter(Boolean);
  const tokens: SearchToken[] = [];
  const freeTextTerms: string[] = [];

  for (const segment of segments) {
    const separatorIndex = segment.indexOf(':');
    if (separatorIndex <= 0) {
      freeTextTerms.push(normalizeText(segment));
      continue;
    }

    const field = normalizeText(segment.slice(0, separatorIndex));
    const value = normalizeText(segment.slice(separatorIndex + 1));
    if (!isSearchField(field) || !value) {
      continue;
    }
    tokens.push({ field, value });
  }

  return {
    tokens,
    freeTextTerms: freeTextTerms.filter(Boolean),
  };
}

export function matchesSearchQuery(item: FeedItem, query: ParsedSearchQuery) {
  const freeTextMatched = query.freeTextTerms.every((term) =>
    getFreeTextValues(item).some((value) => includesNormalized(value, term))
  );
  if (!freeTextMatched) return false;

  return query.tokens.every((token) => {
    if (token.field === 'action') {
      const action = normalizeText(item.activity.metadata.txAction);
      return (ACTION_VALUES as readonly string[]).includes(token.value) && action === token.value;
    }

    return getTokenValues(item, token.field).some((value) => includesNormalized(value, token.value));
  });
}

export function buildSearchSuggestionSources(feed: FeedItem[], users: User[]): SearchSuggestionSources {
  const personValues = uniqueSorted(
    users.flatMap((user) => [user.name, user.handle].filter((value) => value.trim().length > 0))
  );
  const addressValues = uniqueSorted([
    ...users.flatMap((user) => user.addresses.map((address) => address.address)),
    ...feed.flatMap((item) =>
      [item.activity.metadata.fromAddress, item.activity.metadata.toAddress]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ),
  ]);
  const txValues = uniqueSorted(
    feed
      .map((item) => item.activity.metadata.txHash)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  );
  const caValues = uniqueSorted(
    feed
      .map((item) => item.activity.metadata.tokenAddress)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  );
  const tickerValues = uniqueSorted(
    feed
      .map((item) => item.activity.metadata.token)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  );

  return {
    personValues,
    addressValues,
    txValues,
    caValues,
    tickerValues,
  };
}

function getFieldCandidates(field: SearchField, sources: SearchSuggestionSources) {
  if (field === 'person') return sources.personValues;
  if (field === 'address') return sources.addressValues;
  if (field === 'tx') return sources.txValues;
  if (field === 'ca') return sources.caValues;
  if (field === 'ticker') return sources.tickerValues;
  return [...ACTION_VALUES];
}

function rankCandidates(candidates: string[], prefix: string) {
  const normalizedPrefix = normalizeText(prefix);
  if (!normalizedPrefix) {
    return candidates;
  }

  const startsWithMatches = candidates.filter((candidate) =>
    normalizeText(candidate).startsWith(normalizedPrefix)
  );
  const includesMatches = candidates.filter((candidate) => {
    const normalized = normalizeText(candidate);
    return normalized.includes(normalizedPrefix) && !normalized.startsWith(normalizedPrefix);
  });
  return [...startsWithMatches, ...includesMatches];
}

export function getSearchSuggestions(
  input: string,
  sources: SearchSuggestionSources,
  limit = 8
): SearchSuggestion[] {
  const hasTrailingSpace = /\s$/.test(input);
  const currentSegment = hasTrailingSpace ? '' : input.split(/\s+/).pop() || '';
  const normalizedCurrent = normalizeText(currentSegment);

  if (!currentSegment) {
    return SEARCH_FIELDS.slice(0, limit).map((field) => ({
      label: `${field}:`,
      insertText: `${field}:`,
      kind: 'field',
    }));
  }

  const separatorIndex = currentSegment.indexOf(':');
  if (separatorIndex <= 0) {
    return SEARCH_FIELDS
      .filter((field) => field.startsWith(normalizedCurrent))
      .slice(0, limit)
      .map((field) => ({
        label: `${field}:`,
        insertText: `${field}:`,
        kind: 'field',
      }));
  }

  const fieldPart = normalizeText(currentSegment.slice(0, separatorIndex));
  const valuePart = currentSegment.slice(separatorIndex + 1);

  if (!isSearchField(fieldPart)) {
    return SEARCH_FIELDS
      .filter((field) => field.startsWith(fieldPart))
      .slice(0, limit)
      .map((field) => ({
        label: `${field}:`,
        insertText: `${field}:`,
        kind: 'field',
      }));
  }

  const ranked = rankCandidates(getFieldCandidates(fieldPart, sources), valuePart).slice(0, limit);
  return ranked.map((candidate) => ({
    label: `${fieldPart}:${candidate}`,
    insertText: `${fieldPart}:${candidate}`,
    kind: 'value',
  }));
}

export function applySuggestionToInput(input: string, suggestion: string) {
  const hasTrailingSpace = /\s$/.test(input);
  if (!input.trim()) {
    return `${suggestion} `;
  }

  if (hasTrailingSpace) {
    return `${input}${suggestion} `;
  }

  const segments = input.split(/\s+/);
  segments[segments.length - 1] = suggestion;
  return `${segments.join(' ')} `;
}

export function hasActiveSearchQuery(query: ParsedSearchQuery) {
  return query.tokens.length > 0 || query.freeTextTerms.length > 0;
}

export function isValidActionValue(value: string): value is ActionValue {
  return (ACTION_VALUES as readonly string[]).includes(normalizeText(value));
}
