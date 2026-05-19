import 'server-only';

import { type StructuredTwitterProvider, type TwitterProviderIntent } from '@/lib/server/twitterProviderTypes';

export type TwitterProviderUnavailableReason =
  | 'cooldown_active'
  | 'local_budget_exhausted'
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

    if (candidate.remainingUnits <= 0) {
      unavailableProviders.push(markUnavailable(candidate, 'local_budget_exhausted'));
      continue;
    }

    available6551.push(candidate);
  }

  const orderedProviders: TwitterStructuredRouteCandidate[] = [];
  orderedProviders.push(
    ...available6551.map((candidate) => ({
      ...candidate,
    }))
  );
  if (input.providers.xread?.apiKey.trim()) {
    orderedProviders.push(input.providers.xread);
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
