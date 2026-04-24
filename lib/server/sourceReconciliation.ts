import { type Activity } from '@/types';

export type ConflictDomain = 'onchain' | 'twitter';
export type ConflictWinner = 'api' | 'opencli';

export interface ConflictFieldDiff {
  field: string;
  left: string;
  right: string;
}

function normalizeConflictValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  const serialized = JSON.stringify(value);
  return serialized === undefined ? '' : serialized;
}

function tryNormalizeNumericString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;

  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return trimmed;
  return numeric.toString();
}

const ADDRESS_FIELDS = new Set<keyof Activity['metadata']>([
  'tokenAddress',
  'displayTokenAvatarTokenAddress',
]);

const CASE_INSENSITIVE_FIELDS = new Set<keyof Activity['metadata']>([
  'token',
  'quoteToken',
  'displayTokenSymbol',
  'txAction',
  'txActionVariant',
]);

const NUMERIC_STRING_FIELDS = new Set<keyof Activity['metadata']>(['value', 'quoteAmount']);

function normalizeConflictValueByField(field: keyof Activity['metadata'], value: unknown): string {
  const normalized = normalizeConflictValue(value);
  if (!normalized) return '';

  if (ADDRESS_FIELDS.has(field)) {
    return normalized.toLowerCase();
  }
  if (CASE_INSENSITIVE_FIELDS.has(field)) {
    return normalized.toLowerCase();
  }
  if (NUMERIC_STRING_FIELDS.has(field)) {
    return tryNormalizeNumericString(normalized);
  }
  return normalized;
}

const CONFLICT_FIELDS: Array<keyof Activity['metadata']> = [
  'token',
  'tokenAddress',
  'value',
  'quoteToken',
  'quoteAmount',
  'txAction',
  'txActionVariant',
  'displayWalletLabel',
  'displayTradeAmountText',
  'displayTokenSymbol',
  'displayMarketCapText',
  'displayActionVariantLabel',
  'displayTokenAvatarTokenAddress',
];

export function diffActivityForConflict(left: Activity, right: Activity): ConflictFieldDiff[] {
  const diffs: ConflictFieldDiff[] = [];

  for (const field of CONFLICT_FIELDS) {
    const leftValue = normalizeConflictValueByField(field, left.metadata[field]);
    const rightValue = normalizeConflictValueByField(field, right.metadata[field]);
    if (leftValue !== rightValue) {
      diffs.push({
        field,
        left: leftValue,
        right: rightValue,
      });
    }
  }

  return diffs;
}

export function chooseConflictWinner(domain: ConflictDomain): ConflictWinner {
  if (domain === 'twitter') return 'opencli';
  return 'api';
}

export function detectConflictDomain(activity: Activity): ConflictDomain {
  if (activity.source === 'twitter') return 'twitter';
  return 'onchain';
}
