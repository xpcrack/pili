import type { Activity } from '@/types';

export type ActivityImportanceSourceKind = 'social' | 'wallet';
export type ActivityImportanceLevel = 'normal' | 'important' | 'high';

export interface ActivityImportanceFactors {
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
  tradeAmountUsdAtTx: number | null;
  contentLength: number;
}

export interface ActivityImportanceComponents {
  sourceRarity: number;
  assetWeight: number;
  totalFrequencyFactor: number;
  dataConfidenceFactor: number;
}

export interface ActivityImportanceFormula {
  version: string;
  baseScoreWeights: {
    sourceRarity: number;
    assetWeight: number;
  };
  totalFrequencyPenalty: {
    slope: number;
    floor: number;
  };
  fallbacks: {
    missingAssetWeight: number;
    missingAssetConfidenceFactor: number;
  };
}

export interface ActivityImportance {
  version: 1 | 2;
  score: number;
  formulaVersion?: string;
  factors?: ActivityImportanceFactors;
  components?: ActivityImportanceComponents;
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
  tradeAmountUsdAtTx?: number | null;
  contentLength?: number;
  sourceRarity: number;
  assetWeight: number;
  totalFrequencyFactor: number;
  dataConfidenceFactor: number;
}

export interface ActivityImportanceInput {
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
  tradeAmountUsdAtTx?: number | null;
  contentLength?: number | null;
}

export interface ActivityImportanceExplanationRow {
  key: 'sourceRarity' | 'assetWeight' | 'totalFrequencyFactor' | 'dataConfidenceFactor';
  label: string;
  valueText: string;
  description: string;
}

export const DEFAULT_ACTIVITY_IMPORTANCE_FORMULA: ActivityImportanceFormula = {
  version: '2026-05-04',
  baseScoreWeights: {
    sourceRarity: 0.7,
    assetWeight: 0.3,
  },
  totalFrequencyPenalty: {
    slope: 0.03,
    floor: 0.85,
  },
  fallbacks: {
    missingAssetWeight: 0.35,
    missingAssetConfidenceFactor: 0.7,
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeNullablePositiveNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatUsdInK(value: number) {
  const roundedK = Math.round(value / 1_000);
  return `${roundedK.toLocaleString('en-US')}K`;
}

export function resolveActivityImportanceSourceKind(activity: Pick<Activity, 'source'>): ActivityImportanceSourceKind {
  return activity.source === 'blockchain' ? 'wallet' : 'social';
}

export function buildActivityImportanceFactors(input: ActivityImportanceInput): ActivityImportanceFactors {
  const socialCount7d = safeCount(input.socialCount7d);
  const walletCount7d = safeCount(input.walletCount7d);
  const totalCount7d = safeCount(input.totalCount7d);
  const sourceCount7d = input.sourceKind === 'social' ? socialCount7d : walletCount7d;
  const historicalMaxAssetUsd = safeNullablePositiveNumber(input.historicalMaxAssetUsd);
  const tradeAmountUsdAtTx = safeNullablePositiveNumber(input.tradeAmountUsdAtTx);
  const contentLength = safeCount(input.contentLength ?? 0);

  return {
    sourceKind: input.sourceKind,
    sourceCount7d,
    socialCount7d,
    walletCount7d,
    totalCount7d,
    historicalMaxAssetUsd,
    tradeAmountUsdAtTx,
    contentLength,
  };
}

export function hasStoredActivityImportanceFactors(
  importance: Partial<ActivityImportance> | null | undefined
): importance is ActivityImportance & { factors: ActivityImportanceFactors } {
  const factors = importance?.factors;
  if (!importance || importance.version !== 2 || !factors) {
    return false;
  }
  if (factors.sourceKind !== 'social' && factors.sourceKind !== 'wallet') {
    return false;
  }
  if (
    !isFiniteNumber(factors.sourceCount7d) ||
    !isFiniteNumber(factors.socialCount7d) ||
    !isFiniteNumber(factors.walletCount7d) ||
    !isFiniteNumber(factors.totalCount7d)
  ) {
    return false;
  }
  if (factors.historicalMaxAssetUsd !== null && !isFiniteNumber(factors.historicalMaxAssetUsd)) {
    return false;
  }
  if (factors.tradeAmountUsdAtTx !== null && !isFiniteNumber(factors.tradeAmountUsdAtTx)) {
    return false;
  }
  return isFiniteNumber(factors.contentLength);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function recomputeActivityImportanceFromFactors(
  factors: ActivityImportanceFactors,
  formula: ActivityImportanceFormula = DEFAULT_ACTIVITY_IMPORTANCE_FORMULA
): ActivityImportance {
  const historicalMaxAssetUsd = safeNullablePositiveNumber(factors.historicalMaxAssetUsd);
  const hasAsset = historicalMaxAssetUsd !== null;
  const sourceRarity = 1 / Math.sqrt(factors.sourceCount7d + 1);
  const assetWeight = hasAsset
    ? clamp(Math.log10(historicalMaxAssetUsd + 1) / 7, 0, 1)
    : formula.fallbacks.missingAssetWeight;
  const totalFrequencyFactor = clamp(
    1 - formula.totalFrequencyPenalty.slope * Math.log2(factors.totalCount7d + 1),
    formula.totalFrequencyPenalty.floor,
    1
  );
  const dataConfidenceFactor = hasAsset ? 1 : formula.fallbacks.missingAssetConfidenceFactor;
  const totalBaseWeight = Math.max(
    formula.baseScoreWeights.sourceRarity + formula.baseScoreWeights.assetWeight,
    Number.EPSILON
  );
  const baseScore =
    (formula.baseScoreWeights.sourceRarity * sourceRarity + formula.baseScoreWeights.assetWeight * assetWeight) /
    totalBaseWeight;
  const score = Math.round(clamp(baseScore * totalFrequencyFactor * dataConfidenceFactor, 0, 1) * 100);
  const components: ActivityImportanceComponents = {
    sourceRarity,
    assetWeight,
    totalFrequencyFactor,
    dataConfidenceFactor,
  };

  return {
    version: 2,
    score,
    formulaVersion: formula.version,
    factors: {
      ...factors,
      historicalMaxAssetUsd,
      tradeAmountUsdAtTx: safeNullablePositiveNumber(factors.tradeAmountUsdAtTx),
      contentLength: safeCount(factors.contentLength),
    },
    components,
    sourceKind: factors.sourceKind,
    sourceCount7d: factors.sourceCount7d,
    socialCount7d: factors.socialCount7d,
    walletCount7d: factors.walletCount7d,
    totalCount7d: factors.totalCount7d,
    historicalMaxAssetUsd,
    tradeAmountUsdAtTx: safeNullablePositiveNumber(factors.tradeAmountUsdAtTx),
    contentLength: safeCount(factors.contentLength),
    sourceRarity: components.sourceRarity,
    assetWeight: components.assetWeight,
    totalFrequencyFactor: components.totalFrequencyFactor,
    dataConfidenceFactor: components.dataConfidenceFactor,
  };
}

export function computeActivityImportance(
  input: ActivityImportanceInput,
  formula: ActivityImportanceFormula = DEFAULT_ACTIVITY_IMPORTANCE_FORMULA
): ActivityImportance {
  return recomputeActivityImportanceFromFactors(buildActivityImportanceFactors(input), formula);
}

export function getActivityImportanceLevel(score: number): ActivityImportanceLevel {
  if (score >= 70) return 'high';
  if (score >= 50) return 'important';
  return 'normal';
}

export function getActivityImportanceLevelLabel(score: number) {
  const level = getActivityImportanceLevel(score);
  if (level === 'high') return '高重要';
  if (level === 'important') return '重要';
  return '普通';
}

export function buildActivityImportanceExplanationRows(
  importance: ActivityImportance
): ActivityImportanceExplanationRow[] {
  const sourceWindowLabel = importance.sourceKind === 'social' ? '社交动态（推特/TG）' : '链上动态';

  return [
    {
      key: 'sourceRarity',
      label: '同源稀缺分',
      valueText: `近7天${sourceWindowLabel}共 ${importance.sourceCount7d} 条，同源稀缺分：${importance.sourceRarity.toFixed(2)}`,
      description: '越少见，分值越高。',
    },
    {
      key: 'assetWeight',
      label: '资产权重',
      valueText:
        importance.historicalMaxAssetUsd === null
          ? '历史最高资产缺失，资产权重按 0.35'
          : `历史最高资产约 ${formatUsdInK(importance.historicalMaxAssetUsd)} USD，资产权重：${importance.assetWeight.toFixed(2)}`,
      description: '资产体量越大，权重越高。',
    },
    {
      key: 'totalFrequencyFactor',
      label: '总频率因子',
      valueText: `近7天总动态共 ${importance.totalCount7d} 条，总频率因子：${importance.totalFrequencyFactor.toFixed(2)}`,
      description: '越活跃，最终分会轻微下调；该因子当前最低为 0.85。',
    },
    {
      key: 'dataConfidenceFactor',
      label: '数据可信度因子',
      valueText: importance.dataConfidenceFactor.toFixed(2),
      description: '输入数据是否完整；关键数据缺失时保守降权，避免误判成高重要。',
    },
  ];
}
