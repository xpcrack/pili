import 'server-only';

export interface ScheduledBackfillCompanionSyncs {
  twitter: {
    ok: true;
    started: true;
    background: true;
    deferredUntilPrimarySyncIdle: true;
  };
}

export function scheduleBackfillCompanionAfterPrimarySync(params: {
  waitForPrimarySync: () => Promise<unknown>;
  runCompanionSyncs: () => unknown;
  onError?: (error: unknown) => void;
}): ScheduledBackfillCompanionSyncs {
  void params
    .waitForPrimarySync()
    .then(() => {
      params.runCompanionSyncs();
    })
    .catch((error) => {
      params.onError?.(error);
    });

  return {
    twitter: {
      ok: true,
      started: true,
      background: true,
      deferredUntilPrimarySyncIdle: true,
    },
  };
}
