'use client';

import { useEffect, useState } from 'react';

/**
 * 值防抖：值连续变化时只在静止 delayMs 后才透出新值。
 * 用于搜索框 → 远程查询的节流（打字风暴会让 bun:sqlite 单线程服务端串行排队）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
