'use client';

import { useEffect } from 'react';

const PREWARM_DELAY_MS = 1500;

export function useFeedPrewarmTrigger(onLabel: (label: string) => void) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/feed/prewarm', { method: 'POST', cache: 'no-store' })
        .then((response) => response.json())
        .then((payload) => {
          if (
            payload?.ok &&
            typeof payload?.prewarm?.label === 'string' &&
            payload.prewarm.label.trim()
          ) {
            onLabel(payload.prewarm.label as string);
          }
        })
        .catch(() => undefined);
    }, PREWARM_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [onLabel]);
}
