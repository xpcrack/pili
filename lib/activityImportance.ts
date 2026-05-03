import type { Activity } from '@/types';

export type ActivityImportanceSourceKind = 'social' | 'wallet';
export type ActivityImportanceLevel = 'normal' | 'important' | 'high';

export interface ActivityImportance {
  version: 1;
  score: number;
  sourceKind: ActivityImportanceSourceKind;
  sourceCount7d: number;
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  historicalMaxAssetUsd: number | null;
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
}

export interface ActivityImportanceExplanationRow {
  key: 'sourceRarity' | 'assetWeight' | 'totalFrequencyFactor' | 'dataConfidenceFactor';
  label: string;
  valueText: string;
  description: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function resolveActivityImportanceSourceKind(activity: Pick<Activity, 'source'>): ActivityImportanceSourceKind {
  return activity.source === 'blockchain' ? 'wallet' : 'social';
}

export function computeActivityImportance(input: ActivityImportanceInput): ActivityImportance {
  const socialCount7d = safeCount(input.socialCount7d);
  const walletCount7d = safeCount(input.walletCount7d);
  const totalCount7d = safeCount(input.totalCount7d);
  const sourceCount7d = input.sourceKind === 'social' ? socialCount7d : walletCount7d;
  const hasAsset = Number.isFinite(input.historicalMaxAssetUsd) && (input.historicalMaxAssetUsd as number) > 0;
  const historicalMaxAssetUsd = hasAsset ? (input.historicalMaxAssetUsd as number) : null;

  const sourceRarity = 1 / Math.sqrt(sourceCount7d + 1);
  const assetWeight = hasAsset ? clamp(Math.log10((historicalMaxAssetUsd as number) + 1) / 7, 0, 1) : 0.35;
  const totalFrequencyFactor = clamp(1 - 0.03 * Math.log2(totalCount7d + 1), 0.85, 1);
  const dataConfidenceFactor = hasAsset ? 1 : 0.7;
  const baseScore = 0.7 * sourceRarity + 0.3 * assetWeight;
  const score = Math.round(clamp(baseScore * totalFrequencyFactor * dataConfidenceFactor, 0, 1) * 100);

  return {
    version: 1,
    score,
    sourceKind: input.sourceKind,
    sourceCount7d,
    socialCount7d,
    walletCount7d,
    totalCount7d,
    historicalMaxAssetUsd,
    sourceRarity,
    assetWeight,
    totalFrequencyFactor,
    dataConfidenceFactor,
  };
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
  return [
    {
      key: 'sourceRarity',
      label: '同源稀缺分',
      valueText: importance.sourceRarity.toFixed(4),
      description: '这类消息本身最近有多罕见。推文/TG 看社交频率，链上看钱包频率；越少见越高。',
    },
    {
      key: 'assetWeight',
      label: '资产权重',
      valueText:
        importance.historicalMaxAssetUsd === null
          ? '缺失，按 0.35 处理'
          : `${importance.historicalMaxAssetUsd.toLocaleString('en-US')} USD`,
      description: '这个人的历史最高资产有多大；同样低频时，大户分量更重。',
    },
    {
      key: 'totalFrequencyFactor',
      label: '总频率因子',
      valueText: importance.totalFrequencyFactor.toFixed(4),
      description: '这个人最近 7 天整体有多活跃；越活跃，最终分只做轻微下压，不盖过同源稀缺。',
    },
    {
      key: 'dataConfidenceFactor',
      label: '数据可信度因子',
      valueText: importance.dataConfidenceFactor.toFixed(4),
      description: '输入数据是否完整；关键数据缺失时保守降权，避免误判成高重要。',
    },
  ];
}
