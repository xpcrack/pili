'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { User, ChainType, CHAIN_OPTIONS } from '@/types';
import { useUsersDataStore } from '@/store/usersDataStore';
import { useIsClient } from '@/hooks/useIsClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { buildUserAvatar, getUserAvatar, normalizeTwitterHandle } from '@/lib/userProfile';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Wallet,
  ChevronDown,
  ChevronUp,
  X,
  Save,
  AlertCircle,
  Edit2,
} from 'lucide-react';

interface AddressEntry {
  address: string;
  name: string;
  chain: ChainType;
}

interface UserDraft {
  name: string;
  handle: string;
  avatar: string;
  twitter?: string;
  telegram?: string;
  addresses: AddressEntry[];
  tags: string[];
}

interface ProfileFormState {
  name: string;
  handle: string;
  twitter: string;
  telegram: string;
  tags: string;
  currentChainAssetTotal: string;
}

const CHAIN_VALUES = new Set(CHAIN_OPTIONS.map((option) => option.value));

function inferChainFromAddress(address: string): ChainType {
  return address.trim().toLowerCase().startsWith('0x') ? 'bsc' : 'solana';
}

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

function parseAddressText(text: string): AddressEntry[] {
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
      name: addressName || `地址 ${result.length + 1}`,
      chain: hasExplicitChain ? maybeChain : inferChainFromAddress(address),
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
        tags: [],
      });
    }

    const currentUser = groupedUsers.get(userKey);

    if (!currentUser) continue;

    currentUser.addresses.push({
      address,
      name: aliasSuffix || `地址 ${currentUser.addresses.length + 1}`,
      chain: hasExplicitChain ? maybeChain : inferChainFromAddress(address),
    });
  }

  return Array.from(groupedUsers.values());
}

function parseAssetTotalInput(value: string) {
  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

export default function ManagePage() {
  const { users, addUser, addUsers, updateUser, deleteUser, removeAddress } = useUsersDataStore();
  const isClient = useIsClient();

  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState<ProfileFormState>({
    name: '',
    handle: '',
    twitter: '',
    telegram: '',
    tags: '',
    currentChainAssetTotal: '',
  });

  const [addressText, setAddressText] = useState('');
  const [bulkImportText, setBulkImportText] = useState('');

  const [editingAddressUserId, setEditingAddressUserId] = useState<string | null>(null);
  const [editingAddressText, setEditingAddressText] = useState('');

  const parsedAddresses = useMemo(() => parseAddressText(addressText), [addressText]);

  const parsedBulkUsers = useMemo(
    () => parseBulkImportText(bulkImportText, users.map((user) => user.handle)),
    [bulkImportText, users]
  );

  const resetForm = () => {
    setFormData({
      name: '',
      handle: '',
      twitter: '',
      telegram: '',
      tags: '',
      currentChainAssetTotal: '',
    });
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
      addresses: parsedAddresses,
      tags: formData.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      currentChainAssetTotal: parseAssetTotalInput(formData.currentChainAssetTotal),
    });

    resetForm();
    setIsCreating(false);
  };

  const handleImportUsers = () => {
    if (parsedBulkUsers.length === 0) return;

    addUsers(parsedBulkUsers);
    setBulkImportText('');
  };

  const handleAddAddressesToUser = (user: User) => {
    const newAddresses = parseAddressText(editingAddressText);

    if (newAddresses.length > 0) {
      updateUser(user.id, {
        addresses: [...user.addresses, ...newAddresses],
      });
    }

    setEditingAddressText('');
    setEditingAddressUserId(null);
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
      <header className="sticky top-0 z-50 border-b border-zinc-800/50 bg-zinc-950/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-zinc-200"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>返回看板</span>
            </Link>
            <div className="h-6 w-px bg-zinc-800" />
            <h1 className="text-lg font-semibold text-zinc-100">人物管理</h1>
          </div>

          <Button
            onClick={() => setIsCreating(true)}
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            <Plus className="mr-1 h-4 w-4" />
            手动新建
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
        <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900/50 p-6">
          <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-lg font-medium text-zinc-100">批量导入人物</h2>
              <p className="text-sm text-zinc-400">
                每行一个地址，系统会按同名人物自动归组，并自动识别 BSC / Solana 地址。
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
                alice，并把这条地址记为 <code>#7</code>。`0x` 开头会识别为 BSC，其它地址识别为 Solana。
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
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color}20`,
                                color: CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color,
                              }}
                            >
                              {address.chain}
                            </span>
                            <span className="truncate text-zinc-300">{address.name}</span>
                            <span className="truncate text-xs text-zinc-600">
                              {address.address.slice(0, 10)}...{address.address.slice(-6)}
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
              <div className="space-y-2 md:col-span-2">
                <Label className="text-zinc-300">当前链上资产总额</Label>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={formData.currentChainAssetTotal}
                  onChange={(e) => setFormData({ ...formData, currentChainAssetTotal: e.target.value })}
                  placeholder="例如: 128000"
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
                  自动识别: `0x...` 为 BSC，其它为 Solana
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
                    名称可选；链会按地址自动识别。为兼容旧数据，仍然接受末尾补 `:bsc` 或 `:solana`。
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
                              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color}20`,
                                color: CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color,
                              }}
                            >
                              {address.chain}
                            </span>
                            <span className="flex-1 truncate text-zinc-300">{address.name}</span>
                            <span className="max-w-[120px] truncate text-xs text-zinc-600">
                              {address.address.slice(0, 12)}...{address.address.slice(-6)}
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
          <h2 className="text-sm font-medium text-zinc-400">已关注人物 ({users.length})</h2>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {users.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                isEditingAddresses={editingAddressUserId === user.id}
                editingAddressText={editingAddressUserId === user.id ? editingAddressText : ''}
                onDelete={() => deleteUser(user.id)}
                onRemoveAddress={(address) => removeAddress(user.id, address)}
                onUpdate={(updates) => updateUser(user.id, updates)}
                onStartEditingAddresses={() => {
                  setEditingAddressUserId(user.id);
                  setEditingAddressText('');
                }}
                onChangeEditingAddressText={setEditingAddressText}
                onCancelEditingAddresses={() => {
                  setEditingAddressUserId(null);
                  setEditingAddressText('');
                }}
                onAddAddresses={() => handleAddAddressesToUser(user)}
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
        </section>
      </main>
    </div>
  );
}

interface UserCardProps {
  user: User;
  isEditingAddresses: boolean;
  editingAddressText: string;
  onDelete: () => void;
  onRemoveAddress: (address: string) => void;
  onUpdate: (updates: Partial<User>) => void;
  onStartEditingAddresses: () => void;
  onChangeEditingAddressText: (text: string) => void;
  onCancelEditingAddresses: () => void;
  onAddAddresses: () => void;
}

function UserCard({
  user,
  isEditingAddresses,
  editingAddressText,
  onDelete,
  onRemoveAddress,
  onUpdate,
  onStartEditingAddresses,
  onChangeEditingAddressText,
  onCancelEditingAddresses,
  onAddAddresses,
}: UserCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormState>({
    name: user.name,
    handle: user.handle,
    twitter: user.twitter || '',
    telegram: user.telegram || '',
    tags: user.tags.join(', '),
    currentChainAssetTotal: String(user.currentChainAssetTotal ?? 0),
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
      currentChainAssetTotal: parseAssetTotalInput(profileForm.currentChainAssetTotal),
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
          <button
            onClick={() => {
              if (!isEditingProfile) {
                setProfileForm({
                  name: user.name,
                  handle: user.handle,
                  twitter: user.twitter || '',
                  telegram: user.telegram || '',
                  tags: user.tags.join(', '),
                  currentChainAssetTotal: String(user.currentChainAssetTotal ?? 0),
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
            <div className="space-y-2 md:col-span-2">
              <Label className="text-xs text-zinc-400">当前链上资产总额</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={profileForm.currentChainAssetTotal}
                onChange={(e) => setProfileForm({ ...profileForm, currentChainAssetTotal: e.target.value })}
                className="border-zinc-800 bg-zinc-900 text-zinc-100"
              />
              <p className="text-[11px] text-zinc-500">
                历史最高值：{user.historicalMaxChainAssetTotal ?? 0}
              </p>
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
                  currentChainAssetTotal: String(user.currentChainAssetTotal ?? 0),
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
            <span className="text-zinc-600">Telegram</span>
            <span>{user.telegram || '未填写'}</span>
            <span className="text-zinc-600">当前资产</span>
            <span>{user.currentChainAssetTotal ?? 0}</span>
            <span className="text-zinc-600">历史峰值</span>
            <span>{user.historicalMaxChainAssetTotal ?? 0}</span>
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
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200"
          >
            <Wallet className="h-4 w-4" />
            <span>{user.addresses.length} 个地址</span>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {!isEditingAddresses && (
            <button
              onClick={() => {
                onStartEditingAddresses();
                setExpanded(true);
              }}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              + 添加地址
            </button>
          )}
        </div>

        {expanded && (
          <div className="mt-3 space-y-2">
            {user.addresses.length === 0 && !isEditingAddresses && (
              <p className="py-4 text-center text-sm text-zinc-600">暂无地址</p>
            )}

            {user.addresses.map((address) => (
              <div
                key={address.address}
                className="flex items-center justify-between rounded-lg bg-zinc-950/50 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color}20`,
                      color: CHAIN_OPTIONS.find((option) => option.value === address.chain)?.color,
                    }}
                  >
                    {address.chain}
                  </span>
                  <span className="truncate text-sm text-zinc-300">{address.name}</span>
                  <span className="truncate text-xs text-zinc-600">
                    {address.address.slice(0, 8)}...{address.address.slice(-6)}
                  </span>
                </div>
                <button
                  onClick={() => onRemoveAddress(address.address)}
                  className="ml-2 p-1 text-zinc-600 hover:text-red-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {isEditingAddresses && (
              <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="space-y-2">
                  <Label className="text-xs text-zinc-400">批量添加地址</Label>
                  <textarea
                    value={editingAddressText}
                    onChange={(e) => onChangeEditingAddressText(e.target.value)}
                    rows={3}
                    placeholder={`0x123...abc:主钱包
9x8y...:Sol钱包`}
                    className="w-full resize-none rounded bg-zinc-900 p-2 font-mono text-sm text-zinc-100 outline-none ring-1 ring-zinc-800 transition-colors focus:ring-zinc-700"
                  />
                  <p className="text-[10px] text-zinc-500">格式: address:name，链会自动识别</p>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onCancelEditingAddresses}
                      className="border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      onClick={onAddAddresses}
                      disabled={!editingAddressText.trim()}
                      className="bg-blue-600 text-white hover:bg-blue-700"
                    >
                      添加
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
