'use client';

import { useEffect, useState } from 'react';

/**
 * 一级池官推 handle 集合（lowercase），用于推文正文 @handle 的「项目官推」蓝标。
 * 模块级缓存：一次会话只拉一次（数据 60s 服务端缓存，前端无需轮询——
 * 官推集合变化频率是「天」级，刷新页面即可拿到新集合）。
 */
let cache: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;

async function loadOfficialHandles(): Promise<Set<string>> {
  if (cache) return cache;
  if (!inflight) {
    inflight = fetch('/api/official-twitter-handles')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ok?: boolean; handles?: string[] } | null) => {
        const set = new Set<string>(
          Array.isArray(data?.handles) ? data.handles.map((h) => String(h).toLowerCase()) : []
        );
        cache = set;
        return set;
      })
      .catch(() => {
        inflight = null;
        return new Set<string>();
      });
  }
  return inflight;
}

export function useOfficialHandles(): Set<string> {
  const [handles, setHandles] = useState<Set<string>>(cache ?? EMPTY);

  useEffect(() => {
    if (cache) {
      if (handles !== cache) setHandles(cache);
      return;
    }
    let mounted = true;
    void loadOfficialHandles().then((set) => {
      if (mounted && set.size > 0) setHandles(set);
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handles;
}

const EMPTY = new Set<string>();
