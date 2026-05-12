'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';
import { Activity } from '@/types';
import { type FeedSearchFilters } from '@/lib/smartSearch';

interface ActiveContextRefs {
  selectedUserIdRef: MutableRefObject<string | null>;
  searchQueryRef: MutableRefObject<string>;
  sourceRef: MutableRefObject<Activity['source'] | null>;
  searchFiltersRef: MutableRefObject<FeedSearchFilters | undefined>;
}

export function useActiveContextRefs(params: {
  selectedUserId: string | null | undefined;
  searchQuery: string | undefined;
  source: Activity['source'] | null | undefined;
  searchFilters: FeedSearchFilters | undefined;
}): ActiveContextRefs {
  const selectedUserIdRef = useRef<string | null>(params.selectedUserId ?? null);
  const searchQueryRef = useRef<string>((params.searchQuery || '').trim());
  const sourceRef = useRef<Activity['source'] | null>(params.source ?? null);
  const searchFiltersRef = useRef<FeedSearchFilters | undefined>(params.searchFilters);

  useEffect(() => {
    selectedUserIdRef.current = params.selectedUserId ?? null;
  }, [params.selectedUserId]);

  useEffect(() => {
    searchQueryRef.current = (params.searchQuery || '').trim();
  }, [params.searchQuery]);

  useEffect(() => {
    sourceRef.current = params.source ?? null;
  }, [params.source]);

  useEffect(() => {
    searchFiltersRef.current = params.searchFilters;
  }, [params.searchFilters]);

  return {
    selectedUserIdRef,
    searchQueryRef,
    sourceRef,
    searchFiltersRef,
  };
}
