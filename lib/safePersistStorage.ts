'use client';

import type { PersistStorage, StorageValue } from 'zustand/middleware';

export function createSafePersistStorage<T>(keyPrefix?: string): PersistStorage<T> {
  return {
    getItem: (name) => {
      if (typeof window === 'undefined') {
        return null;
      }

      const storageKey = keyPrefix ? `${keyPrefix}:${name}` : name;
      const rawValue = window.localStorage.getItem(storageKey);

      if (!rawValue) {
        return null;
      }

      try {
        return JSON.parse(rawValue) as StorageValue<T>;
      } catch (error) {
        console.warn(`Failed to parse persisted state for ${storageKey}, clearing it.`, error);
        window.localStorage.removeItem(storageKey);
        return null;
      }
    },
    setItem: (name, value) => {
      if (typeof window === 'undefined') {
        return;
      }

      const storageKey = keyPrefix ? `${keyPrefix}:${name}` : name;
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    },
    removeItem: (name) => {
      if (typeof window === 'undefined') {
        return;
      }

      const storageKey = keyPrefix ? `${keyPrefix}:${name}` : name;
      window.localStorage.removeItem(storageKey);
    },
  };
}
