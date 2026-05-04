'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
  Edit2,
  RefreshCw,
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
  tags: string;
}

interface TwitterRelayCoverageView {
  latestTweetId: string;
  latestLastSeenAtMs: number;
  tweetCount: number;
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

export default function ManagePage() {
  const { users, addUser, addUsers, updateUser, deleteUser } = useUsersDataStore();
  const isClient = useIsClient();

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState<ProfileFormState>({
    name: '',
    handle: '',
    twitter: '',
    telegram: '',
    tags: '',
  });

  const [addressText, setAddressText] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');
  const [searchText, setSearchText] = useState('');

  const [copiedKind, setCopiedKind] = useState<'all-addresses' | 'all-twitter' | null>(null);
  const [relayCoverageByHandle, setRelayCoverageByHandle] = useState<Record<string, TwitterRelayCoverageView>>({});

  const parsedAddresses = useMemo(() => parseAddressText(addressText), [addressText]);

  const parsedBulkUsers = useMemo(
    () => parseBulkImportText(bulkImportText, users.map((user) => user.handle)),
    [bulkImportText, users]
  );
  const filteredUsers = useMemo(() => filterManageUsers(users, searchText), [users, searchText]);

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
  }, [isClient, users.length]);

  const resetForm = () => {
    setFormData({ name: '', handle: '', twitter: '', telegram: '', tags: '' });
    setAddressText('');
  };

  const handleSave = () => {
    if (!formData.name.trim() || !formData.handle.trim()) return;

    const normalizedTwitter = normalizeTwitterHandle(formData.twitter);

    addUser({
      name: formData.name.trim(),
      handle: formData.handle.trim(),
      avatar: buildUserAvatar(formData.handle.trim(), normalizedTwitter),
      twitter: normalizedTwitter || undefined,
      telegram: formData.telegram.trim() || undefined,
      addresses: expandTrackedAddresses(parsedAddresses),
      totalAssetUsd: 0,
      historicalMaxAssetUsd: 0,
      assetUpdatedAt: null,
      tags: formData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    });

    resetForm();
    setIsCreating(false);
  };

  const handleImportUsers = () => {
    if (parsedBulkUsers.length === 0) return;

    addUsers(
      parsedBulkUsers.map((user) => ({
        ...user,
        addresses: expandTrackedAddresses(user.addresses),
      }))
    );
    setBulkImportText('');
  };

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

  if (!isClient) {
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

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filteredUsers.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                relayCoverage={
                  user.twitter ? relayCoverageByHandle[normalizeTwitterHandle(user.twitter).toLowerCase()] || null : null
                }
                onDelete={() => deleteUser(user.id)}
                onUpdate={(updates) => updateUser(user.id, updates)}
                onRefreshAvatar={() => {
                  if (!user.twitter) return;
                  updateUser(user.id, {
                    avatar: buildUserAvatar(user.handle, user.twitter, `${user.twitter}:${Date.now()}`),
                  });
                }}
              />
            ))}
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

interface UserCardProps {
  user: User;
  relayCoverage: TwitterRelayCoverageView | null;
  onDelete: () => void;
  onUpdate: (updates: Partial<User>) => void;
  onRefreshAvatar: () => void;
}

function UserCard({
  user,
  relayCoverage,
  onDelete,
  onUpdate,
  onRefreshAvatar,
}: UserCardProps) {
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const addressCount = useMemo(() => groupAddressesForDisplay(user.addresses).length, [user.addresses]);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    name: user.name,
    handle: user.handle,
    twitter: user.twitter || '',
    telegram: user.telegram || '',
    tags: user.tags.join(', '),
  });

  const handleSaveProfile = () => {
    if (!profileForm.name.trim() || !profileForm.handle.trim()) return;

    const normalizedTwitter = normalizeTwitterHandle(profileForm.twitter);

    onUpdate({
      name: profileForm.name.trim(),
      handle: profileForm.handle.trim(),
      avatar: buildUserAvatar(profileForm.handle.trim(), normalizedTwitter),
      twitter: normalizedTwitter || undefined,
      telegram: profileForm.telegram.trim() || undefined,
      tags: profileForm.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    });

    setIsEditingProfile(false);
  };

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            <AvatarImage src={getUserAvatar(user)} alt={user.name} />
            <AvatarFallback className="bg-zinc-800 font-medium text-zinc-400">
              {user.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <h3 className="font-medium text-zinc-100">{user.name}</h3>
            <p className="text-sm text-zinc-500">@{user.handle}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {user.twitter ? (
            <button
              onClick={onRefreshAvatar}
              className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="重新获取头像"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          ) : null}
          <button
            onClick={() => {
              if (!isEditingProfile) {
                setProfileForm({
                  name: user.name,
                  handle: user.handle,
                  twitter: user.twitter || '',
                  telegram: user.telegram || '',
                  tags: user.tags.join(', '),
                });
              }

              setIsEditingProfile((value) => !value);
            }}
            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="编辑人物"
          >
            <Edit2 className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
            title="删除人物"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isEditingProfile ? (
        <div className="mt-4 space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs text-zinc-400">名称</Label>
              <Input
                value={profileForm.name}
                onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-zinc-400">Handle</Label>
              <Input
                value={profileForm.handle}
                onChange={(e) => setProfileForm({ ...profileForm, handle: e.target.value })}
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-zinc-400">Twitter</Label>
              <Input
                value={profileForm.twitter}
                onChange={(e) => setProfileForm({ ...profileForm, twitter: e.target.value })}
                placeholder="例如: your_x_handle"
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-zinc-400">Telegram</Label>
              <Input
                value={profileForm.telegram}
                onChange={(e) => setProfileForm({ ...profileForm, telegram: e.target.value })}
                placeholder="例如: your_tg"
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label className="text-xs text-zinc-400">标签</Label>
              <Input
                value={profileForm.tags}
                onChange={(e) => setProfileForm({ ...profileForm, tags: e.target.value })}
                placeholder="逗号分隔"
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setProfileForm({
                  name: user.name,
                  handle: user.handle,
                  twitter: user.twitter || '',
                  telegram: user.telegram || '',
                  tags: user.tags.join(', '),
                });
                setIsEditingProfile(false);
              }}
              className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleSaveProfile}
              disabled={!profileForm.name.trim() || !profileForm.handle.trim()}
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              保存资料
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-4 text-sm text-zinc-400">
            <span className="text-zinc-600">Twitter</span>
            <span>{user.twitter ? `@${user.twitter}` : '未填写'}</span>
            {user.twitter && relayCoverage ? (
              <Badge className="border-0 bg-emerald-500/15 text-xs text-emerald-300">
                Relay {new Date(relayCoverage.latestLastSeenAtMs).toLocaleDateString('zh-CN')}
              </Badge>
            ) : null}
            <span className="text-zinc-600">Telegram</span>
            <span>{user.telegram || '未填写'}</span>
            <span className="text-zinc-600">总资产</span>
            <span>{formatUsdCompact(user.totalAssetUsd)}</span>
            <span className="text-zinc-600">历史最高</span>
            <span>{formatUsdCompact(user.historicalMaxAssetUsd)}</span>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {user.tags.length > 0 ? (
              user.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="border-0 bg-zinc-800 text-xs text-zinc-400">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-zinc-600">暂无标签</span>
            )}
          </div>
        </>
      )}

      <div className="mt-4 border-t border-zinc-800/50 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-3">
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Wallet className="h-4 w-4" />
            <span>{addressCount} 个地址</span>
          </div>
          <Link href="/addresses" className="text-sm text-blue-400 hover:text-blue-300">
            去地址页查看 / 删除
          </Link>
        </div>
      </div>
    </div>
  );
}
