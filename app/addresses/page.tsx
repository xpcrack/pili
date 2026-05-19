'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Copy, ExternalLink, Trash2 } from 'lucide-react';

import { useMainPageSession } from '@/components/MainPageSessionProvider';
import { TopNav } from '@/components/TopNav';
import { Button } from '@/components/ui/button';
import type { AddressManagementRow } from '@/lib/addressManagement';
import { formatUsdCompact } from '@/lib/assetFormat';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';
import { useUsersDataStore } from '@/store/usersDataStore';

interface AddressesPayload {
  ok: boolean;
  rows?: AddressManagementRow[];
  error?: string;
}

export const ADDRESSES_PAGE_FETCH_URL = '/api/addresses';
export const DELETE_ADDRESS_CONFIRMATION_TEXT = '删除地址，不会删除人物。';

export default function AddressesPage() {
  const removeAddress = useUsersDataStore((state) => state.removeAddress);
  const { state, setAddressesSnapshot, invalidateManage } = useMainPageSession();
  const cachedSnapshot = state.addresses;
  const [rows, setRows] = useState<AddressManagementRow[]>(() => cachedSnapshot?.rows || []);
  const [loading, setLoading] = useState(() => !cachedSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const flashNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 1500);
  };

  const loadRows = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(ADDRESSES_PAGE_FETCH_URL, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as AddressesPayload | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      setRows(payload.rows);
      setAddressesSnapshot({
        rows: payload.rows,
        cachedAt: Date.now(),
      });
    } catch (nextError) {
      if (!cachedSnapshot) {
        setRows([]);
      }
      setError(nextError instanceof Error ? nextError.message : '读取地址列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRows();
  }, []);

  const handleCopy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setError(null);
      setCopiedAddress(address);
      flashNotice('地址已复制');
      window.setTimeout(() => {
        setCopiedAddress((current) => (current === address ? null : current));
      }, 1200);
    } catch {
      setError('复制地址失败');
    }
  };

  const handleExport = async () => {
    const text = rows.map((row) => `${row.address}:${row.displayName}`).join('\n');
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setError(null);
      flashNotice('已复制全部地址');
    } catch {
      setError('导出地址失败');
    }
  };

  const handleDelete = async (row: AddressManagementRow) => {
    if (!window.confirm(`${DELETE_ADDRESS_CONFIRMATION_TEXT}\n\n确认删除 ${row.displayName} 吗？`)) {
      return;
    }

    const key = `${row.userId}:${row.address}`;
    setDeletingKey(key);
    setError(null);

    try {
      const response = await fetch(`/api/users/${row.userId}/addresses`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: row.address }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }

      removeAddress(row.userId, row.address);
      setRows((currentRows) => {
        const nextRows = currentRows.filter(
          (currentRow) => !(currentRow.userId === row.userId && currentRow.address === row.address)
        );
        setAddressesSnapshot({
          rows: nextRows,
          cachedAt: Date.now(),
        });
        return nextRows;
      });
      invalidateManage();
      flashNotice('地址已删除');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '删除地址失败');
    } finally {
      setDeletingKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950">
      <TopNav active="addresses" />

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <section className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">地址管理</h2>
            <p className="mt-1 text-sm text-zinc-500">浏览器原生搜索即可，地址详情与删除已从人物页拆分出来。</p>
          </div>

          <Button
            onClick={() => void handleExport()}
            disabled={rows.length === 0}
            className="bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
          >
            <Copy className="mr-1.5 h-4 w-4" />
            导出全部地址
          </Button>
        </section>

        {error ? (
          <section className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </section>
        ) : null}

        {notice ? (
          <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {notice}
          </section>
        ) : null}

        {loading && rows.length === 0 ? (
          <section className="space-y-2 rounded-2xl border border-zinc-800/70 bg-zinc-900/40 p-4">
            {[0, 1, 2, 3, 4].map((item) => (
              <div key={item} className="h-12 animate-pulse rounded-xl bg-zinc-800/70" />
            ))}
          </section>
        ) : null}

        <section className="overflow-x-auto rounded-2xl border border-zinc-800/70 bg-zinc-900/40">
          <table className="w-full min-w-[840px] table-auto text-sm">
            <thead className="bg-zinc-900/90 text-zinc-300">
              <tr className="border-b border-zinc-800/80">
                <th className="px-3 py-3 text-left font-medium">名字</th>
                <th className="px-3 py-3 text-left font-medium">地址</th>
                <th className="px-3 py-3 text-right font-medium">上次交易时间</th>
                <th className="px-3 py-3 text-right font-medium">总资产</th>
                <th className="px-3 py-3 text-center font-medium">GMGN</th>
                <th className="px-3 py-3 text-center font-medium">删除</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const deleting = deletingKey === `${row.userId}:${row.address}`;

                return (
                  <tr key={`${row.userId}:${row.address}`} className="border-b border-zinc-800/70 text-zinc-200">
                    <td className="px-3 py-3">
                      <div className="font-medium text-zinc-100">{row.displayName}</div>
                      <div className="mt-1 text-xs text-zinc-500">{row.networkLabel}</div>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => void handleCopy(row.address)}
                        className="max-w-[340px] truncate text-left font-mono text-xs text-zinc-400 hover:text-zinc-200"
                      >
                        {row.address}
                        {copiedAddress === row.address ? ' · 已复制' : ''}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-zinc-300">
                      {row.latestActivityAt ? formatRelativeTimeCompact(row.latestActivityAt) : '-'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-zinc-100">
                      {typeof row.totalAssetUsd === 'number' ? formatUsdCompact(row.totalAssetUsd) : '-'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {row.gmgnUrl ? (
                        <a
                          href={row.gmgnUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex text-blue-400 hover:text-blue-300"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      ) : (
                        <span className="text-zinc-600">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => void handleDelete(row)}
                        disabled={deleting}
                        className="rounded p-1 text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {!loading && rows.length === 0 ? (
          <section className="rounded-2xl border-2 border-dashed border-zinc-800 py-16 text-center">
            <AlertCircle className="mx-auto mb-3 h-12 w-12 text-zinc-600" />
            <p className="mb-2 text-zinc-500">暂无地址</p>
            <p className="text-sm text-zinc-600">先到人物页导入或新建人物地址。</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
