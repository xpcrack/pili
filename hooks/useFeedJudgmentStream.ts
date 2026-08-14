'use client';

import { useEffect, useRef } from 'react';

const STREAM_ENDPOINT = '/api/debug/tx-judgment/stream';

export function useFeedJudgmentStream(onUpdate: () => Promise<unknown> | void) {
  const versionRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  const streamRef = useRef<EventSource | null>(null);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const stream = new EventSource(STREAM_ENDPOINT);
    streamRef.current = stream;

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; version?: number };
        if (!payload || typeof payload.version !== 'number') {
          return;
        }
        if (payload.type === 'hello') {
          versionRef.current = payload.version;
          return;
        }
        if (payload.type !== 'updated') {
          return;
        }
        if (payload.version === versionRef.current) {
          return;
        }
        versionRef.current = payload.version;
        if (inFlightRef.current) {
          return;
        }
        inFlightRef.current = true;
        try {
          const result = onUpdateRef.current();
          if (result && typeof (result as Promise<unknown>).finally === 'function') {
            (result as Promise<unknown>).finally(() => {
              inFlightRef.current = false;
            });
          } else {
            inFlightRef.current = false;
          }
        } catch {
          // 同步抛异常也要复位，否则 inFlightRef 永久置位、流停摆
          inFlightRef.current = false;
        }
      } catch {
        // ignore malformed events
      }
    };

    stream.onerror = () => {
      // browser EventSource auto-reconnects
    };

    return () => {
      stream.close();
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
    };
  }, []);
}
