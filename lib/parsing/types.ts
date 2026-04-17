import type { OkxTransaction } from '@/lib/okx';
import type { Activity } from '@/types';

export type NormalizedTxAction = NonNullable<Activity['metadata']['txAction']>;

export interface GroupedTransaction {
  txHash: string;
  entries: OkxTransaction[];
}

export interface TokenFlow {
  direction: 'in' | 'out';
  symbol: string;
  tokenAddress: string;
  amount: number;
  fromAddress: string;
  toAddress: string;
  rawType: string;
  native: boolean;
}

export interface FlowSummary {
  outgoingNonNative: TokenFlow[];
  incomingNonNative: TokenFlow[];
  outgoingNativeTotal: number;
  incomingNativeTotal: number;
  dominantOutgoingNonNative: TokenFlow | null;
  dominantIncomingNonNative: TokenFlow | null;
}

export interface InferTxActionParams {
  rawType: string;
  symbol: string;
  userInFrom: boolean;
  userInTo: boolean;
  tx: OkxTransaction;
}

export interface ProbeOkxDetailParams {
  txHash: string;
  chain: string;
  fallbackAction: NormalizedTxAction;
  symbol: string;
  tokenAddress: string;
  summary: FlowSummary;
}

export interface AddressMatchState {
  initiatorMatchedFrom: boolean;
  targetMatchedTo: boolean;
  initiatorMatchedSigner: boolean;
  initiatedByTracked: boolean;
  uncertainFrom: boolean;
}

export interface ParsedAssetLeg {
  symbol: string;
  amount: string;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
}

export interface ParsedQuoteLeg {
  token: string;
  amount: string;
}

export interface ParsedTransactionCore {
  txHash: string;
  representative: OkxTransaction;
  timestamp: number;
  rawType: string;
  txStatus?: string;
  addressMatch: AddressMatchState;
  fallbackAction: NormalizedTxAction;
  txAction: NormalizedTxAction;
  primaryAsset: ParsedAssetLeg;
  quoteAsset?: ParsedQuoteLeg;
  flows: TokenFlow[];
  flowSummary: FlowSummary;
  usedDetailProbe: boolean;
}

export interface ParseGroupedTransactionParams {
  group: GroupedTransaction;
  chain: string;
  trackedAddress: string;
  requireTrackedInitiator?: boolean;
}
