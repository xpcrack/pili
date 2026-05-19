'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMainPageSession } from '@/components/MainPageSessionProvider';
import { User, ChainType, CHAIN_OPTIONS } from '@/types';
import { useUsersDataStore } from '@/store/usersDataStore';
import { useIsClient } from '@/hooks/useIsClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TopNav } from '@/components/TopNav';
import { buildUserAvatar, getUserAvatar, normalizeTwitterHandle } from '@/lib/userProfile';
import { formatUsdCompact } from '@/lib/assetFormat';
import {
  expandTrackedAddresses,
  formatUsersForAddressExport,
  getAddressNetworkLabel,
  groupAddressesForDisplay,
  inferChainFromAddress,
} from '@/lib/addressBook';
import {
  buildManageServerSyncKey,
  filterManageUsers,
  getManageAddressDisplayText,
} from '@/lib/manageUsers';
import {
  Plus,
  Copy,
  Trash2,
  Wallet,
  X,
  Save,
  AlertCircle,
  Search,
  ArrowRight,
} from 'lucide-react';

interface AddressEntry {
  address: string;
  name: string;
  chain: ChainType;
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
}

interface UserDraft {
  name: string;
  handle: string;
  avatar: string;
  twitter?: string;
  telegram?: string;
  addresses: AddressEntry[];
  totalAssetUsd: number;
  historicalMaxAssetUsd: number;
  assetUpdatedAt: number | null;
  tags: string[];
}

interface ProfileFormState {
  name: string;
  handle: string;
  twitter: string;
  telegram: string;
  telegrams: string;
  isNewsSource: boolean;
  tags: string;
}

interface UserActivityStats {
  socialCount7d: number;
  walletCount7d: number;
  totalCount7d: number;
  totalCountAll: number;
  avgBuyMarketCap7d: number | null;
}

type ManageSortKey =
  | 'historicalMaxAssetUsd'
  | 'totalAssetUsd'
  | 'socialCount7d'
  | 'walletCount7d'
  | 'totalCount7d'
  | 'avgBuyMarketCap7d';

interface TwitterRelayCoverageView {
  latestTweetId: string;
  latestLastSeenAtMs: number;
  tweetCount: number;
}

interface TrackedUserAddressesMutationPayload {
  ok?: boolean;
  user?: User;
  error?: string;
}

const CHAIN_VALUES = new Set(CHAIN_OPTIONS.map((option) => option.value));

function buildHandle(base: string, usedHandles: Set<string>) {
  const normalizedBase = base
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^-\p{L}\p{N}_]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const fallbackBase = normalizedBase || 'user';
  let candidate = fallbackBase;
  let index = 2;

  while (usedHandles.has(candidate)) {
    candidate = `${fallbackBase}-${index}`;
    index += 1;
  }

  usedHandles.add(candidate);
  return candidate;
}

function parseAddressText(text: string, startIndex = 1): AddressEntry[] {
  const lines = text.trim().split('\n');
  const result: AddressEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(':');
    const address = parts[0]?.trim();

    if (!address) continue;

    const maybeChain = parts[parts.length - 1]?.trim().toLowerCase() as ChainType;
    const hasExplicitChain = parts.length > 2 && CHAIN_VALUES.has(maybeChain);
    const addressName = hasExplicitChain
      ? parts.slice(1, -1).join(':').trim()
      : parts.slice(1).join(':').trim();

    result.push({
      address,
      name: addressName || `#${startIndex + result.length}`,
      chain: hasExplicitChain ? maybeChain : inferChainFromAddress(address),
      totalAssetUsd: null,
      assetUpdatedAt: null,
    });
  }

  return result;
}

function parseBulkImportText(
  text: string,
  existingHandles: string[]
): UserDraft[] {
  const lines = text.trim().split('\n');
  const groupedUsers = new Map<string, UserDraft>();
  const usedHandles = new Set(existingHandles.map((handle) => handle.toLowerCase()));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(':');
    const address = parts[0]?.trim();

    if (!address) continue;

    const maybeChain = parts[parts.length - 1]?.trim().toLowerCase() as ChainType;
    const hasExplicitChain = parts.length > 2 && CHAIN_VALUES.has(maybeChain);
    const descriptor = hasExplicitChain
      ? parts.slice(1, -1).join(':').trim()
      : parts.slice(1).join(':').trim();

    const hashIndex = descriptor.lastIndexOf('#');
    const hasAddressAlias = hashIndex > 0;
    const userName = (hasAddressAlias ? descriptor.slice(0, hashIndex) : descriptor).trim() || '未命名人物';
    const aliasSuffix = hasAddressAlias ? descriptor.slice(hashIndex).trim() : '';
    const userKey = userName.toLowerCase();

    if (!groupedUsers.has(userKey)) {
      const handle = buildHandle(userName, usedHandles);

      groupedUsers.set(userKey, {
        name: userName,
        handle,
        avatar: buildUserAvatar(handle),
        addresses: [],
        totalAssetUsd: 0,
        historicalMaxAssetUsd: 0,
        assetUpdatedAt: null,
        tags: [],
      });
    }

    const currentUser = groupedUsers.get(userKey);

    if (!currentUser) continue;

    currentUser.addresses.push({
      address,
      name: aliasSuffix || `#${currentUser.addresses.length + 1}`,
      chain: hasExplicitChain ? maybeChain : inferChainFromAddress(address),
      totalAssetUsd: null,
      assetUpdatedAt: null,
    });
  }

  return Array.from(groupedUsers.values());
}

function getAddressBadgeMeta(params: {
  address: string;
  chain: ChainType;
  chains?: readonly ChainType[];
}) {
  const label = getAddressNetworkLabel(params);
  return {
    label,
    className:
      label === 'EVM地址'
        ? 'bg-sky-500/15 text-sky-300'
        : 'bg-emerald-500/15 text-emerald-300',
  };
}

function buildTwitterProfileUrl(raw: string | undefined) {
  const handle = normalizeTwitterHandle(raw || '');
  if (!handle) return null;
  return `https://x.com/${handle}`;
}

function buildTelegramProfileUrl(raw: string | undefined) {
  const value = (raw || '').trim();
  if (!value) return null;
  if (value.startsWith('https://') || value.startsWith('http://')) {
    return value;
  }
  const username = value.replace(/^@/, '');
  if (!username) return null;
  return `https://t.me/${username}`;
}

function buildTelegramDisplayText(raw: string | undefined) {
  const value = (raw || '').trim();
  if (!value) return '';
  const withoutProtocol = value.replace(/^https?:\/\//i, '');
  const withoutDomain = withoutProtocol.replace(/^(www\.)?t\.me\//i, '');
  const withoutAt = withoutDomain.replace(/^@/, '');
  const username = withoutAt.split('/')[0]?.split('?')[0]?.trim();
  return username ? `@${username}` : value;
}

function getRecentTotalCount(stats: UserActivityStats) {
  return stats.socialCount7d + stats.walletCount7d;
}

export default function ManagePage() {
  const { users, addUser, addUsers, updateUser, deleteUser, mergeUsersFromServer } = useUsersDataStore();
  const { state, setManageSnapshot, invalidateAddresses } = useMainPageSession();
  const isClient = useIsClient();
  const cachedSnapshot = state.manage;

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState<ProfileFormState>({
    name: '',
    handle: '',
    twitter: '',
    telegram: '',
    telegrams: '',
    isNewsSource: false,
    tags: '',
  });

  const [addressText, setAddressText] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
  const [searchText, setSearchText] = useState('');
  const [deletingUserIds, setDeletingUserIds] = useState<Record<string, boolean>>({});

  const [copiedKind, setCopiedKind] = useState<'all-addresses' | 'all-twitter' | null>(null);
  const [relayCoverageByHandle, setRelayCoverageByHandle] = useState<Record<string, TwitterRelayCoverageView>>(
    () => cachedSnapshot?.relayCoverageByHandle || {}
  );
  const [activityStatsByUserId, setActivityStatsByUserId] = useState<Record<string, UserActivityStats>>(
    () => cachedSnapshot?.activityStatsByUserId || {}
  );
  const [sortState, setSortState] = useState<{ key: ManageSortKey; direction: 'asc' | 'desc' }>({
    key: 'totalCount7d',
    direction: 'desc',
  });
  const [editingAddressUserId, setEditingAddressUserId] = useState<string | null>(null);
  const [editingAddressText, setEditingAddressText] = useState('');
  const [savingAddressUserId, setSavingAddressUserId] = useState<string | null>(null);
  const [addressActionError, setAddressActionError] = useState<string | null>(null);
  const [addressActionNotice, setAddressActionNotice] = useState<string | null>(null);
  const [editingProfileUserId, setEditingProfileUserId] = useState<string | null>(null);
  const [editingProfileData, setEditingProfileData] = useState<ProfileFormState>({
    name: '',
    handle: '',
    twitter: '',
    telegram: '',
    telegrams: '',
    isNewsSource: false,
    tags: '',
  });
  const [savingProfileUserId, setSavingProfileUserId] = useState<string | null>(null);

  const parsedAddresses = useMemo(() => parseAddressText(addressText), [addressText]);

  const parsedBulkUsers = useMemo(
    () => parseBulkImportText(bulkImportText, users.map((user) => user.handle)),
    [bulkImportText, users]
  );
  const filteredUsers = useMemo(() => filterManageUsers(users, searchText), [users, searchText]);
  const filteredUserRows = useMemo(
    () =>
      filteredUsers.map((user) => {
        const stats = activityStatsByUserId[user.id] || {
          socialCount7d: 0,
          walletCount7d: 0,
          totalCount7d: 0,
          totalCountAll: 0,
          avgBuyMarketCap7d: null,
        };
        return {
          user,
          stats,
          displayAddresses: groupAddressesForDisplay(user.addresses),
        };
      }),
    [activityStatsByUserId, filteredUsers]
  );
  const sortedUserRows = useMemo(() => {
    const directionFactor = sortState.direction === 'asc' ? 1 : -1;
    return [...filteredUserRows].sort((left, right) => {
      const valueLeft =
        sortState.key === 'historicalMaxAssetUsd'
          ? left.user.historicalMaxAssetUsd
          : sortState.key === 'totalAssetUsd'
            ? left.user.totalAssetUsd
            : sortState.key === 'socialCount7d'
              ? left.stats.socialCount7d
              : sortState.key === 'walletCount7d'
                ? left.stats.walletCount7d
                : sortState.key === 'avgBuyMarketCap7d'
                  ? (left.stats.avgBuyMarketCap7d ?? -1)
                  : getRecentTotalCount(left.stats);
      const valueRight =
        sortState.key === 'historicalMaxAssetUsd'
          ? right.user.historicalMaxAssetUsd
          : sortState.key === 'totalAssetUsd'
            ? right.user.totalAssetUsd
            : sortState.key === 'socialCount7d'
              ? right.stats.socialCount7d
              : sortState.key === 'walletCount7d'
                ? right.stats.walletCount7d
                : sortState.key === 'avgBuyMarketCap7d'
                  ? (right.stats.avgBuyMarketCap7d ?? -1)
                  : getRecentTotalCount(right.stats);

      if (valueLeft === valueRight) {
        return left.user.name.localeCompare(right.user.name, 'zh-CN') * directionFactor;
      }
      return (valueLeft - valueRight) * directionFactor;
    });
  }, [filteredUserRows, sortState.direction, sortState.key]);

  useEffect(() => {
    setManageSnapshot({
      users,
      relayCoverageByHandle,
      activityStatsByUserId,
      cachedAt: Date.now(),
    });
  }, [activityStatsByUserId, relayCoverageByHandle, setManageSnapshot, users]);

  useEffect(() => {
    if (!isClient || typeof window === 'undefined') {
      return;
    }

    const localAddressCount = users.reduce((sum, user) => sum + user.addresses.length, 0);
    if (localAddressCount === 0) {
      return;
    }

    const syncKey = buildManageServerSyncKey(users);
    if (window.sessionStorage.getItem(syncKey) === 'done') {
      return;
    }

    const usersWithAddresses = users.filter((user) => user.addresses.length > 0);
    if (usersWithAddresses.length === 0) {
      return;
    }

    void fetch('/api/users/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        users: usersWithAddresses,
        replaceExisting: false,
      }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        window.sessionStorage.setItem(syncKey, 'done');
        console.info('[manage] synced local users to server', {
          users: usersWithAddresses.length,
          addresses: localAddressCount,
        });
      })
      .catch((error) => {
        console.warn(
          '[manage] failed to sync local users to server',
          error instanceof Error ? error.message : error
        );
      });
  }, [isClient, users]);

  useEffect(() => {
    if (!isClient) {
      return;
    }

    void fetch('/api/users', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (!payload?.ok || !Array.isArray(payload.users)) {
          return;
        }
        mergeUsersFromServer(payload.users as User[]);
        const next: Record<string, TwitterRelayCoverageView> = {};
        for (const user of payload.users as User[]) {
          const handle = normalizeTwitterHandle(user.twitter || '').toLowerCase();
          if (!handle || !user.relayCoverage) {
            continue;
          }
          next[handle] = user.relayCoverage;
        }
        setRelayCoverageByHandle(next);
      })
      .catch(() => undefined);
  }, [isClient, mergeUsersFromServer, users.length]);

  useEffect(() => {
    if (!isClient) {
      return;
    }

    void fetch('/api/users/activity-stats', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (!payload?.ok || typeof payload.statsByUserId !== 'object' || !payload.statsByUserId) {
          return;
        }
        setActivityStatsByUserId(payload.statsByUserId as Record<string, UserActivityStats>);
      })
      .catch(() => undefined);
  }, [isClient, users.length]);

  const handleDeleteUser = async (userId: string) => {
    if (deletingUserIds[userId]) {
      return;
    }

    setDeletingUserIds((state) => ({ ...state, [userId]: true }));

    try {
      const response = await fetch(`/api/users/${userId}`, {
        method: 'DELETE',
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(
        '[manage] failed to delete user from server',
        error instanceof Error ? error.message : error
      );
    } finally {
      deleteUser(userId);
      invalidateAddresses();
      setDeletingUserIds((state) => {
        const next = { ...state };
        delete next[userId];
        return next;
      });
    }
  };

  const resetForm = () => {
    setFormData({ name: '', handle: '', twitter: '', telegram: '', telegrams: '', isNewsSource: false, tags: '' });
    setAddressText('');
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.handle.trim()) return;

    const normalizedTwitter = normalizeTwitterHandle(formData.twitter);

    await addUser({
      name: formData.name.trim(),
      handle: formData.handle.trim(),
      avatar: buildUserAvatar(formData.handle.trim(), normalizedTwitter),
      twitter: normalizedTwitter || undefined,
      telegram: formData.telegram.trim() || undefined,
      telegrams: formData.telegrams.split(',').map((t) => t.trim()).filter(Boolean),
      addresses: expandTrackedAddresses(parsedAddresses),
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: [
        ...(formData.isNewsSource ? ['news'] : []),
        ...formData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ],
    });

    resetForm();
    setIsCreating(false);
    invalidateAddresses();
  };

  const handleImportUsers = async () => {
    if (parsedBulkUsers.length === 0) return;

    await addUsers(
      parsedBulkUsers.map((user) => ({
        ...user,
        addresses: expandTrackedAddresses(user.addresses),
      }))
    );
    setBulkImportText('');
    invalidateAddresses();
  };

  const flashAddressNotice = (message: string) => {
    setAddressActionNotice(message);
    window.setTimeout(() => {
      setAddressActionNotice((current) => (current === message ? null : current));
    }, 1800);
  };

  const handleAddAddressesToUser = async (user: User) => {
    const logicalAddressCount = groupAddressesForDisplay(user.addresses).length;
    const newAddresses = parseAddressText(editingAddressText, logicalAddressCount + 1);

    if (newAddresses.length === 0) {
      setAddressActionError('请输入至少一个有效地址');
      return;
    }

    setSavingAddressUserId(user.id);
    setAddressActionError(null);

    try {
      const response = await fetch(`/api/users/${user.id}/addresses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          addresses: expandTrackedAddresses(newAddresses),
        }),
      });
      const payload = (await response.json().catch(() => null)) as TrackedUserAddressesMutationPayload | null;

      if (!response.ok || !payload?.ok || !payload.user) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      updateUser(user.id, payload.user);
      invalidateAddresses();
      setEditingAddressUserId(null);
      setEditingAddressText('');
      flashAddressNotice(`已为 ${user.name} 追加 ${newAddresses.length} 个地址`);
    } catch (error) {
      setAddressActionError(error instanceof Error ? error.message : '追加地址失败');
    } finally {
      setSavingAddressUserId(null);
    }
  };

  const handleSaveProfile = async (user: User) => {
    setSavingProfileUserId(user.id);
    try {
      const tags = [
        ...(editingProfileData.isNewsSource ? ['news'] : []),
        ...editingProfileData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      ];
      const response = await fetch(`/api/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingProfileData.name.trim(),
          handle: editingProfileData.handle.trim(),
          twitter: editingProfileData.twitter.trim() || null,
          telegram: editingProfileData.telegram.trim() || null,
          telegrams: editingProfileData.telegrams.split(',').map((t) => t.trim()).filter(Boolean),
          tags,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload.user) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      updateUser(user.id, payload.user);
      invalidateAddresses();
      setEditingProfileUserId(null);
      flashAddressNotice(`已更新 ${editingProfileData.name.trim() || user.name} 的信息`);
    } catch (error) {
      setAddressActionError(error instanceof Error ? error.message : '更新人物信息失败');
    } finally {
      setSavingProfileUserId(null);
    }
  };

  const startEditingProfile = (user: User) => {
    setEditingProfileData({
      name: user.name,
      handle: user.handle,
      twitter: user.twitter || '',
      telegram: user.telegram || '',
      telegrams: (user.telegrams || []).join(', '),
      isNewsSource: user.tags.includes('news'),
      tags: user.tags.filter((t) => t !== 'news').join(', '),
    });
    setEditingProfileUserId(user.id);
    setAddressActionError(null);
  };

  const hasProfileChanges = useCallback((user: User) => {
    if (editingProfileUserId !== user.id) return false;
    const data = editingProfileData;
    return (
      data.name !== user.name ||
      data.handle !== user.handle ||
      (data.twitter || '') !== (user.twitter || '') ||
      (data.telegram || '') !== (user.telegram || '') ||
      data.telegrams !== (user.telegrams || []).join(', ') ||
      data.isNewsSource !== user.tags.includes('news') ||
      data.tags !== user.tags.filter((t) => t !== 'news').join(', ')
    );
  }, [editingProfileUserId, editingProfileData]);

  const collapseProfile = useCallback(async (user: User) => {
    if (hasProfileChanges(user)) {
      await handleSaveProfile(user);
    } else {
      setEditingProfileUserId(null);
    }
  }, [hasProfileChanges, handleSaveProfile]);

  const profileCardRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    if (!editingProfileUserId) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (profileCardRef.current && !profileCardRef.current.contains(event.target as Node)) {
        const user = users.find((u) => u.id === editingProfileUserId);
        if (user) void collapseProfile(user);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [editingProfileUserId, collapseProfile, users]);

  const copyText = async (text: string) => {
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
  };

  const flashCopied = (kind: 'all-addresses' | 'all-twitter') => {
    setCopiedKind(kind);
    window.setTimeout(() => {
      setCopiedKind((current) => (current === kind ? null : current));
    }, 1200);
  };

  const handleExportAllAddresses = async () => {
    const payload = formatUsersForAddressExport(users);
    if (!payload) return;
    await copyText(payload);
    flashCopied('all-addresses');
  };

  const handleExportAllTwitter = async () => {
    const lines = users
      .map((user) => {
        const handle = normalizeTwitterHandle(user.twitter || '');
        if (!handle) return null;
        return `${user.name}\t@${handle}\thttps://x.com/${handle}`;
      })
      .filter((line): line is string => Boolean(line));
    const payload = lines.join('\n');
    if (!payload) return;
    await copyText(payload);
    flashCopied('all-twitter');
  };

  const toggleSort = (key: ManageSortKey) => {
    setSortState((current) => {
      if (current.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return {
        key,
        direction: 'desc',
      };
    });
  };

  if (!isClient && !cachedSnapshot) {
    return (
      <div className="min-h-screen bg-zinc-950">
        <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-4">
          <div className="text-sm text-zinc-500">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <TopNav active="manage" />

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
        <section className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => void handleExportAllAddresses()}
            className="border-zinc-700 bg-zinc-900/80 text-zinc-200 hover:bg-zinc-800"
          >
            <Copy className="mr-1 h-4 w-4" />
            {copiedKind === 'all-addresses' ? '已复制全部地址' : '导出全部地址'}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleExportAllTwitter()}
            className="border-zinc-700 bg-zinc-900/80 text-zinc-200 hover:bg-zinc-800"
          >
            <Copy className="mr-1 h-4 w-4" />
            {copiedKind === 'all-twitter' ? '已复制全部推特' : '导出全部推特'}
          </Button>
          <Button onClick={() => setIsCreating(true)} className="bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="mr-1 h-4 w-4" />
            手动新建
          </Button>
          <Link
            href="/addresses"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
          >
            地址页
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>

        <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/50 p-6">
          <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-lg font-medium text-zinc-100">批量导入人物</h2>
              <p className="text-sm text-zinc-400">
                每行一个地址，系统会按同名人物自动归组；`0x` 地址会自动作为同一个 EVM 地址跟踪 BSC / ETH / BASE 三链动态。
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-2">
              <Label className="text-zinc-300">导入文本</Label>
              <textarea
                value={bulkImportText}
                onChange={(e) => setBulkImportText(e.target.value)}
                rows={8}
                placeholder={`7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:alice#1
DEhYwVxVJwKb3p1LjJqF9DP7iT7GaMBGE7FWxH7Pp7Xz:alice#2
bob_placeholder_solana_addr_1111111111111111:bob#1
0xAbCdEf0123456789AbCdEf0123456789AbCdEf04:bob#2`}
                className="w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-700"
              />
              <p className="text-xs text-zinc-500">
                推荐格式: <code>地址:人物名#地址别名</code>。例如 <code>...:alice#1</code> 会创建人物
                alice，并把这条地址记为 <code>#7</code>。导出时也会保持这个格式，不再额外附带链信息。
              </p>
            </div>

            <div className="space-y-3">
              <Label className="text-zinc-300">
                预览 ({parsedBulkUsers.length} 人 /{' '}
                {parsedBulkUsers.reduce((total, user) => total + user.addresses.length, 0)} 个地址)
              </Label>
              <div className="max-h-[272px] space-y-3 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                {parsedBulkUsers.length === 0 ? (
                  <p className="py-10 text-center text-sm text-zinc-600">粘贴内容后在这里预览</p>
                ) : (
                  parsedBulkUsers.map((user) => (
                    <div key={user.handle} className="rounded-lg border border-zinc-800/70 bg-zinc-900/60 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-zinc-100">{user.name}</p>
                          <p className="text-xs text-zinc-500">@{user.handle}</p>
                        </div>
                        <Badge className="border-0 bg-zinc-800 text-zinc-300">
                          {user.addresses.length} 个地址
                        </Badge>
                      </div>

                      <div className="mt-3 space-y-2">
                        {user.addresses.map((address) => (
                          <div key={`${user.handle}-${address.address}`} className="flex items-center gap-2 text-sm">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getAddressBadgeMeta(address).className}`}
                            >
                              {getAddressBadgeMeta(address).label}
                            </span>
                            <span className="shrink-0 text-zinc-300">{address.name}</span>
                            <span className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-600">
                              {getManageAddressDisplayText(address.address)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <Button
                onClick={handleImportUsers}
                disabled={parsedBulkUsers.length === 0}
                className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Save className="mr-1 h-4 w-4" />
                创建这些人物
              </Button>
            </div>
          </div>
        </section>

        {isCreating && (
          <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/50 p-6">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-medium text-zinc-100">手动新建人物</h2>
              <button
                onClick={() => {
                  setIsCreating(false);
                  resetForm();
                }}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-zinc-300">名称 *</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="例如: Vitalik Buterin"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">Handle *</Label>
                <Input
                  value={formData.handle}
                  onChange={(e) => setFormData({ ...formData, handle: e.target.value })}
                  placeholder="例如: vitalik.eth"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">Twitter</Label>
                <Input
                  value={formData.twitter}
                  onChange={(e) => setFormData({ ...formData, twitter: e.target.value })}
                  placeholder="例如: VitalikButerin"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-zinc-300">Telegram</Label>
                <Input
                  value={formData.telegram}
                  onChange={(e) => setFormData({ ...formData, telegram: e.target.value })}
                  placeholder="例如: vitalik_channel"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              {formData.isNewsSource && (
                <div className="space-y-2">
                  <Label className="text-zinc-300">额外 TG 频道</Label>
                  <Input
                    value={formData.telegrams}
                    onChange={(e) => setFormData({ ...formData, telegrams: e.target.value })}
                    placeholder="多个频道用逗号分隔，例如: channel1, channel2"
                    className="border-zinc-800 bg-zinc-950 text-zinc-100"
                  />
                </div>
              )}
              <div className="flex items-center gap-3 md:col-span-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, isNewsSource: !formData.isNewsSource })}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    formData.isNewsSource ? 'bg-amber-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      formData.isNewsSource ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
                <Label className="text-zinc-300">新闻源</Label>
                <span className="text-xs text-zinc-500">
                  {formData.isNewsSource ? 'Feed 中默认隐藏，手动开启显示' : '开启后此人物标记为新闻源'}
                </span>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label className="text-zinc-300">标签 (逗号分隔)</Label>
                <Input
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="例如: 观察名单, 聪明钱"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
            </div>

            {!formData.isNewsSource && (
            <div className="border-t border-zinc-800 pt-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <Wallet className="h-4 w-4" />
                  录入地址
                </h3>
                <span className="text-xs text-zinc-500">
                  自动识别: `0x...` 为 EVM（三链跟踪），其它为 Solana
                </span>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs text-zinc-400">格式: address:name</Label>
                  <textarea
                    value={addressText}
                    onChange={(e) => setAddressText(e.target.value)}
                    rows={6}
                    placeholder={`0x123...abc:主钱包
0x456...def:小号
9x8y...:Sol钱包
0xabc...:观察地址`}
                    className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-700"
                  />
                  <p className="text-xs text-zinc-500">
                    名称可选；链会按地址自动识别。为兼容旧数据，仍然接受末尾补 `:bsc`、`:ethereum`、`:base` 或 `:solana`。
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-zinc-400">解析预览 ({parsedAddresses.length} 个)</Label>
                  <div className="h-[156px] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    {parsedAddresses.length === 0 ? (
                      <p className="py-8 text-center text-sm text-zinc-600">输入地址后在此预览</p>
                    ) : (
                      <div className="space-y-2">
                        {parsedAddresses.map((address, index) => (
                          <div key={`${address.address}-${index}`} className="flex items-center gap-2 text-sm">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getAddressBadgeMeta(address).className}`}
                            >
                              {getAddressBadgeMeta(address).label}
                            </span>
                            <span className="shrink-0 text-zinc-300">{address.name}</span>
                            <span className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-600">
                              {getManageAddressDisplayText(address.address)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            )}

            <div className="mt-6 flex justify-end gap-3 border-t border-zinc-800 pt-6">
              <Button
                variant="outline"
                onClick={() => {
                  setIsCreating(false);
                  resetForm();
                }}
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </Button>
              <Button
                onClick={handleSave}
                disabled={!formData.name.trim() || !formData.handle.trim()}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                <Save className="mr-1 h-4 w-4" />
                保存人物
              </Button>
            </div>
          </section>
        )}

        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-medium text-zinc-400">
                已关注人物 ({searchText.trim() ? `${filteredUsers.length} / ${users.length}` : users.length})
              </h2>
              <p className="text-xs text-zinc-600">
                地址详情、复制和删除已拆分到{' '}
                <Link href="/addresses" className="text-blue-400 hover:text-blue-300">
                  /addresses
                </Link>
              </p>
            </div>
            <div className="relative w-full md:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
              <Input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="搜索人物、社交账号、标签或完整地址"
                className="border-zinc-800 bg-zinc-950 pl-9 pr-9 text-zinc-100"
              />
              {searchText.trim() ? (
                <button
                  onClick={() => setSearchText('')}
                  className="absolute right-2 top-1/2 rounded p-1 text-zinc-600 transition-colors -translate-y-1/2 hover:text-zinc-300"
                  title="清空搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          {addressActionError ? (
            <section className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {addressActionError}
            </section>
          ) : null}

          {addressActionNotice ? (
            <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              {addressActionNotice}
            </section>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-zinc-800/70 bg-zinc-900/40">
            <table className="w-full table-auto text-sm">
              <thead className="bg-zinc-900/90 text-zinc-300">
                <tr className="border-b border-zinc-800/80">
                  <th className="w-12 px-2 py-2.5 text-left font-medium">头像</th>
                  <th className="w-44 px-2 py-2.5 text-left font-medium">名称</th>
                  <th className="w-28 px-2 py-2.5 text-left font-medium">推特</th>
                  <th className="w-24 px-2 py-2.5 text-left font-medium">TG</th>
                  <th className="w-44 px-2 py-2.5 text-left font-medium">地址</th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('historicalMaxAssetUsd')}
                    >
                      历史最高资产
                      <span className="text-[10px]">
                        {sortState.key === 'historicalMaxAssetUsd'
                          ? sortState.direction === 'asc'
                            ? '▲'
                            : '▼'
                          : '↕'}
                      </span>
                    </button>
                  </th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('totalAssetUsd')}
                    >
                      当前总资产
                      <span className="text-[10px]">
                        {sortState.key === 'totalAssetUsd' ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('socialCount7d')}
                    >
                      近7天社交动态
                      <span className="text-[10px]">
                        {sortState.key === 'socialCount7d' ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('walletCount7d')}
                    >
                      近7天链上动态
                      <span className="text-[10px]">
                        {sortState.key === 'walletCount7d' ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('totalCount7d')}
                      title="近7天社交动态 + 近7天链上动态"
                    >
                      近7天总动态
                      <span className="text-[10px]">
                        {sortState.key === 'totalCount7d' ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                  <th className="px-2 py-2.5 text-right font-medium">
                    <button
                      className="ml-auto inline-flex items-center gap-1 hover:text-zinc-100"
                      onClick={() => toggleSort('avgBuyMarketCap7d')}
                      title="近7天建仓/加仓时平均代币市值"
                    >
                      买入市值
                      <span className="text-[10px]">
                        {sortState.key === 'avgBuyMarketCap7d' ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedUserRows.map(({ user, stats, displayAddresses }) => {
                  const twitterUrl = buildTwitterProfileUrl(user.twitter);
                  const telegramUrl = buildTelegramProfileUrl(user.telegram);
                  const telegramDisplayText = buildTelegramDisplayText(user.telegram);
                  const twitterHandle = normalizeTwitterHandle(user.twitter || '');
                  const relayCoverage = twitterHandle
                    ? relayCoverageByHandle[twitterHandle.toLowerCase()] || null
                    : null;
                  const isEditingAddresses = editingAddressUserId === user.id;
                  const isEditingProfile = editingProfileUserId === user.id;
                  const profileDirty = hasProfileChanges(user);

                  return (
                    <Fragment key={user.id}>
                      <tr
                        className={`border-b border-zinc-800/70 align-top text-zinc-200 ${
                          isEditingProfile ? 'bg-zinc-950/50' : ''
                        }`}
                      >
                        <td
                          className="cursor-pointer px-2 py-2.5"
                          onClick={() => {
                            if (isEditingProfile) return;
                            startEditingProfile(user);
                          }}
                        >
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={getUserAvatar(user)} alt={user.name} />
                            <AvatarFallback className="bg-zinc-800 text-xs text-zinc-400">
                              {user.name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        </td>
                        <td
                          className="cursor-pointer px-2 py-2.5"
                          onClick={() => {
                            if (isEditingProfile) return;
                            startEditingProfile(user);
                          }}
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-zinc-100">{user.name}</div>
                            <div className="truncate text-xs text-zinc-500">@{user.handle}</div>
                            {user.tags.length > 0 ? (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {user.tags.slice(0, 3).map((tag) => (
                                  <Badge key={tag} className={`border-0 text-[10px] ${
                                    tag === 'news' ? 'bg-amber-600/20 text-amber-300' : 'bg-zinc-800 text-zinc-300'
                                  }`}>
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          {twitterUrl ? (
                            <div className="space-y-1">
                              <a
                                href={twitterUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate text-blue-400 hover:text-blue-300 hover:underline"
                              >
                                @{twitterHandle}
                              </a>
                              {relayCoverage ? (
                                <div className="text-[11px] text-emerald-300">
                                  Relay {new Date(relayCoverage.latestLastSeenAtMs).toLocaleDateString('zh-CN')}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-zinc-600">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {telegramUrl ? (
                            <div>
                              <a
                                href={telegramUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate text-blue-400 hover:text-blue-300 hover:underline"
                              >
                                {telegramDisplayText || '-'}
                              </a>
                              {user.telegrams && user.telegrams.length > 0 ? (
                                <div className="text-[11px] text-zinc-500">
                                  +{user.telegrams.length} 频道
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-zinc-600">-</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded border border-zinc-700/70 bg-zinc-950/80 px-1.5 py-0.5 text-[11px] text-zinc-300">
                              {displayAddresses.length} 个地址
                            </span>
                            <button
                              onClick={() => {
                                if (isEditingAddresses) {
                                  setEditingAddressUserId(null);
                                  setEditingAddressText('');
                                  setAddressActionError(null);
                                  return;
                                }
                                setEditingAddressUserId(user.id);
                                setEditingAddressText('');
                                setAddressActionError(null);
                              }}
                              className="text-[11px] text-blue-400 hover:text-blue-300"
                            >
                              追加地址
                            </button>
                            <Link href="/addresses" className="text-[11px] text-blue-400 hover:text-blue-300">
                              地址页
                            </Link>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">
                          {formatUsdCompact(user.historicalMaxAssetUsd)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">
                          {formatUsdCompact(user.totalAssetUsd)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">{stats.socialCount7d}</td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">{stats.walletCount7d}</td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">
                          {getRecentTotalCount(stats)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-zinc-200">
                          {stats.avgBuyMarketCap7d != null ? formatUsdCompact(stats.avgBuyMarketCap7d) : '—'}
                        </td>
                      </tr>
                      {isEditingProfile ? (
                        <tr ref={profileCardRef} className="border-b border-zinc-800/70 bg-zinc-950/70">
                          <td colSpan={11} className="px-4 py-3">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                                <div className="space-y-1">
                                  <Label className="text-xs text-zinc-400">名称</Label>
                                  <Input
                                    value={editingProfileData.name}
                                    onChange={(e) => setEditingProfileData({ ...editingProfileData, name: e.target.value })}
                                    className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-zinc-400">Handle</Label>
                                  <Input
                                    value={editingProfileData.handle}
                                    onChange={(e) => setEditingProfileData({ ...editingProfileData, handle: e.target.value })}
                                    className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-zinc-400">Twitter</Label>
                                  <Input
                                    value={editingProfileData.twitter}
                                    onChange={(e) => setEditingProfileData({ ...editingProfileData, twitter: e.target.value })}
                                    className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <Label className="text-xs text-zinc-400">Telegram</Label>
                                  <Input
                                    value={editingProfileData.telegram}
                                    onChange={(e) => setEditingProfileData({ ...editingProfileData, telegram: e.target.value })}
                                    className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                  />
                                </div>
                                {editingProfileData.isNewsSource && (
                                  <div className="space-y-1">
                                    <Label className="text-xs text-zinc-400">额外 TG 频道 (逗号分隔)</Label>
                                    <Input
                                      value={editingProfileData.telegrams}
                                      onChange={(e) => setEditingProfileData({ ...editingProfileData, telegrams: e.target.value })}
                                      className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                    />
                                  </div>
                                )}
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={() => setEditingProfileData({ ...editingProfileData, isNewsSource: !editingProfileData.isNewsSource })}
                                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                                      editingProfileData.isNewsSource ? 'bg-amber-600' : 'bg-zinc-700'
                                    }`}
                                  >
                                    <span
                                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                        editingProfileData.isNewsSource ? 'left-[22px]' : 'left-0.5'
                                      }`}
                                    />
                                  </button>
                                  <Label className="text-xs text-zinc-400">新闻源</Label>
                                </div>
                                <div className="space-y-1 lg:col-span-2">
                                  <Label className="text-xs text-zinc-400">标签 (逗号分隔)</Label>
                                  <Input
                                    value={editingProfileData.tags}
                                    onChange={(e) => setEditingProfileData({ ...editingProfileData, tags: e.target.value })}
                                    className="h-8 border-zinc-800 bg-zinc-900 text-zinc-100 text-sm"
                                  />
                                </div>
                              </div>
                              <div className="mt-3 flex items-center justify-between">
                                <button
                                  onClick={() => void handleDeleteUser(user.id)}
                                  disabled={Boolean(deletingUserIds[user.id])}
                                  className="rounded p-1.5 text-zinc-600 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                                  title="删除人物"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                                {profileDirty ? (
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setEditingProfileUserId(null);
                                        setAddressActionError(null);
                                      }}
                                      disabled={savingProfileUserId === user.id}
                                      className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                    >
                                      取消
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() => void handleSaveProfile(user)}
                                      disabled={!editingProfileData.name.trim() || !editingProfileData.handle.trim() || savingProfileUserId === user.id}
                                      className="bg-blue-600 text-white hover:bg-blue-700"
                                    >
                                      {savingProfileUserId === user.id ? '保存中...' : '保存'}
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {isEditingAddresses ? (
                        <tr className="border-b border-zinc-800/70 bg-zinc-950/70">
                          <td colSpan={11} className="px-4 py-3">
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                              <div className="space-y-2">
                                <Label className="text-xs text-zinc-400">批量追加地址</Label>
                                <textarea
                                  value={editingAddressText}
                                  onChange={(event) => setEditingAddressText(event.target.value)}
                                  rows={4}
                                  placeholder={`0x123...abc:主钱包
9x8y...:Sol钱包`}
                                  className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-100 outline-none transition-colors focus:border-zinc-700"
                                />
                                <p className="text-[11px] text-zinc-500">
                                  格式: <code>address:name</code>。`0x` 地址会自动按同一逻辑地址补 BSC / ETH /
                                  BASE 三链。
                                </p>
                              </div>
                              <div className="mt-3 flex gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setEditingAddressUserId(null);
                                    setEditingAddressText('');
                                    setAddressActionError(null);
                                  }}
                                  disabled={savingAddressUserId === user.id}
                                  className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                >
                                  取消
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => void handleAddAddressesToUser(user)}
                                  disabled={!editingAddressText.trim() || savingAddressUserId === user.id}
                                  className="bg-blue-600 text-white hover:bg-blue-700"
                                >
                                  {savingAddressUserId === user.id ? '追加中...' : '提交追加'}
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {users.length === 0 && (
            <div className="rounded-xl border-2 border-dashed border-zinc-800 py-16 text-center">
              <AlertCircle className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
              <p className="mb-2 text-zinc-500">暂无关注人物</p>
              <p className="text-sm text-zinc-600">先批量导入，或者点击右上角手动新建</p>
            </div>
          )}

          {users.length > 0 && filteredUsers.length === 0 && (
            <div className="rounded-xl border-2 border-dashed border-zinc-800 py-16 text-center">
              <AlertCircle className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
              <p className="mb-2 text-zinc-500">没有匹配的人物或地址</p>
              <p className="text-sm text-zinc-600">换个名称、社交账号、标签或完整地址再试</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
