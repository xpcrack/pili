import 'server-only';

import { type StructuredTwitterProvider, type TwitterProviderIntent } from '@/lib/server/twitterProviderTypes';

export type TwitterProviderUnavailableReason =
  | 'cooldown_active'
  | 'missing_api_key';

export interface Twitter6551RouteCandidate {
  provider: '6551';
  credentialId: string;
  apiKey: string;
  dailyLimit: number;
  remainingUnits: number;
  cooldownUntilMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
}

export interface TwitterXreadRouteCandidate {
  provider: 'xread';
  credentialId: string;
  apiKey: string;
}

export type TwitterStructuredRouteCandidate = Twitter6551RouteCandidate | TwitterXreadRouteCandidate;

export interface TwitterStructuredProviderRouteInput {
  intent: TwitterProviderIntent;
  nowMs: number;
  providers: {
    keys6551: Twitter6551RouteCandidate[];
    xread: TwitterXreadRouteCandidate | null;
  };
}

export type TwitterStructuredProviderUnavailable = Twitter6551RouteCandidate & {
  reason: TwitterProviderUnavailableReason;
};

export interface TwitterStructuredProviderRouteResult {
  primaryProvider: TwitterStructuredRouteCandidate | null;
  orderedProviders: TwitterStructuredRouteCandidate[];
  unavailableProviders: TwitterStructuredProviderUnavailable[];
}

function compare6551Candidates(a: Twitter6551RouteCandidate, b: Twitter6551RouteCandidate) {
  const aFailure = a.lastFailureAtMs || 0;
  const bFailure = b.lastFailureAtMs || 0;
  if (aFailure !== bFailure) {
    return aFailure - bFailure;
  }

  const aSuccess = a.lastSuccessAtMs || 0;
  const bSuccess = b.lastSuccessAtMs || 0;
  if (bSuccess !== aSuccess) {
    return bSuccess - aSuccess;
  }

  return a.credentialId.localeCompare(b.credentialId);
}

function markUnavailable(
  candidate: Twitter6551RouteCandidate,
  reason: TwitterProviderUnavailableReason
): TwitterStructuredProviderUnavailable {
  return {
    ...candidate,
    reason,
  };
}

export function chooseTwitterProviderRoute(
  input: TwitterStructuredProviderRouteInput
): TwitterStructuredProviderRouteResult {
  const available6551: Twitter6551RouteCandidate[] = [];
  const unavailableProviders: TwitterStructuredProviderUnavailable[] = [];

  for (const candidate of input.providers.keys6551) {
    if (!candidate.apiKey.trim()) {
      unavailableProviders.push(markUnavailable(candidate, 'missing_api_key'));
      continue;
    }

    if (candidate.cooldownUntilMs && candidate.cooldownUntilMs > input.nowMs) {
      unavailableProviders.push(markUnavailable(candidate, 'cooldown_active'));
      continue;
    }

    available6551.push(candidate);
  }

  available6551.sort(compare6551Candidates);

  const orderedProviders: TwitterStructuredRouteCandidate[] = [];
  if (input.intent === 'backfill') {
    orderedProviders.push(
      ...available6551.map((candidate) => ({
        ...candidate,
      }))
    );
    if (input.providers.xread?.apiKey.trim()) {
      orderedProviders.push(input.providers.xread);
    }
  } else {
    orderedProviders.push(
      ...available6551.map((candidate) => ({
        ...candidate,
      }))
    );
    if (input.providers.xread?.apiKey.trim()) {
      orderedProviders.push(input.providers.xread);
    }
  }

  return {
    primaryProvider: orderedProviders[0] || null,
    orderedProviders,
    unavailableProviders,
  };
}

export function isStructuredProvider(provider: string): provider is StructuredTwitterProvider {
  return provider === '6551' || provider === 'xread';
}
