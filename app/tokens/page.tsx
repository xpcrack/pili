'use client';

import { useCallback, useEffect, useState } from 'react';
import { TopNav } from '@/components/TopNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatRelativeTimeCompact } from '@/lib/timeFormat';
import { RefreshCw, Trash2, Plus, Download, Upload } from 'lucide-react';

interface Token {
  id: number;
  chain: string;
  contract_address: string;
  tags: string;
  imported_at: number;
  price: number | null;
  market_cap: number | null;
  price_change_24h: number | null;
  ticker: string | null;
  last_buy_at: number | null;
}

const CHAIN_LABELS: Record<string, { label: string; color: string }> = {
  solana: { label: 'SOL', color: 'bg-purple-500/20 text-purple-300' },
  ethereum: { label: 'ETH', color: 'bg-blue-500/20 text-blue-300' },
  bsc: { label: 'BSC', color: 'bg-yellow-500/20 text-yellow-300' },
  base: { label: 'BASE', color: 'bg-blue-600/20 text-blue-200' },
  hyperevm: { label: 'HyperEVM', color: 'bg-pink-500/20 text-pink-300' },
  hypercore: { label: 'HyperCore', color: 'bg-cyan-500/20 text-cyan-300' },
};

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importChain, setImportChain] = useState('hypercore');
  const [newAddress, setNewAddress] = useState('');
  const [newChain, setNewChain] = useState('hypercore');
  const [newTags, setNewTags] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tokens');
      const data = await res.json();
      setTokens(data.items ?? []);
    } catch (err) {
      console.error('Fetch tokens error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const handleAdd = async () => {
    if (!newAddress.trim()) return;

    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: newChain,
          contractAddress: newAddress.trim(),
          tags: newTags.trim() ? newTags.trim().split(/\s+/) : [],
        }),
      });

      if (res.ok) {
        setNewAddress('');
        setNewTags('');
        fetchTokens();
      }
    } catch (err) {
      console.error('Add token error:', err);
    }
  };

  const handleBulkImport = async () => {
    if (!importText.trim()) return;

    try {
      const res = await fetch('/api/tokens/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: importText, chain: importChain }),
      });

      if (res.ok) {
        const data = await res.json();
        alert(`导入完成: ${data.added} 新增, ${data.skipped} 跳过`);
        setImportText('');
        setImportOpen(false);
        fetchTokens();
      }
    } catch (err) {
      console.error('Bulk import error:', err);
    }
  };

  const handleDelete = async (ids: number[]) => {
    if (!confirm(`确定删除 ${ids.length} 个代币?`)) return;

    try {
      const res = await fetch('/api/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });

      if (res.ok) {
        setSelectedIds(new Set());
        fetchTokens();
      }
    } catch (err) {
      console.error('Delete tokens error:', err);
    }
  };

  const toggleSelect = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === tokens.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tokens.map(t => t.id)));
    }
  };

  const formatPrice = (price: number | null) => {
    if (price === null) return '-';
    if (price < 0.0001) return price.toExponential(2);
    if (price < 1) return price.toFixed(6);
    return price.toFixed(2);
  };

  const formatMarketCap = (mcap: number | null) => {
    if (mcap === null) return '-';
    if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
    if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
    if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(2)}K`;
    return `$${mcap.toFixed(2)}`;
  };

  const formatChange = (change: number | null) => {
    if (change === null) return '-';
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  };

  return (
    <div className="flex min-h-screen flex-col">
      <TopNav active="tokens" />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold">代币监控</h2>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(!importOpen)}
            >
              <Upload className="mr-1 h-4 w-4" />
              批量导入
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchTokens}
              disabled={loading}
            >
              <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            {selectedIds.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(Array.from(selectedIds))}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                删除 ({selectedIds.size})
              </Button>
            )}
          </div>
        </div>

        {/* Bulk Import Panel */}
        {importOpen && (
          <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="mb-3 text-sm font-medium">批量导入</h3>
            <p className="mb-2 text-xs text-zinc-400">
              格式: 每行一个代币，格式为 `地址-tag1 tag2` 或 `代币名`（HyperCore）
            </p>
            <div className="mb-3 flex gap-2">
              <select
                value={importChain}
                onChange={e => setImportChain(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
              >
                <option value="hypercore">HyperCore (代币名，如 PURR)</option>
                <option value="hyperevm">HyperEVM (合约地址)</option>
                <option value="solana">Solana</option>
                <option value="ethereum">Ethereum</option>
                <option value="bsc">BSC</option>
                <option value="base">Base</option>
              </select>
            </div>
            <textarea
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={
                importChain === 'hypercore'
                  ? 'PURR\nHFUN\nPOINTS'
                  : '0x1234...-meme highrisk\n0x5678...'
              }
              className="mb-3 h-32 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono"
            />
            <Button size="sm" onClick={handleBulkImport}>
              导入
            </Button>
          </div>
        )}

        {/* Add Single Token */}
        <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="mb-3 text-sm font-medium">添加代币</h3>
          <div className="flex gap-2">
            <select
              value={newChain}
              onChange={e => setNewChain(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="hypercore">HyperCore</option>
              <option value="hyperevm">HyperEVM</option>
              <option value="solana">Solana</option>
              <option value="ethereum">Ethereum</option>
              <option value="bsc">BSC</option>
              <option value="base">Base</option>
            </select>
            <Input
              placeholder={newChain === 'hypercore' ? '代币名 (如 PURR)' : '合约地址'}
              value={newAddress}
              onChange={e => setNewAddress(e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder="tags (空格分隔)"
              value={newTags}
              onChange={e => setNewTags(e.target.value)}
              className="w-48"
            />
            <Button size="sm" onClick={handleAdd}>
              <Plus className="mr-1 h-4 w-4" />
              添加
            </Button>
          </div>
        </div>

        {/* Token Table */}
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50">
                <th className="px-3 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === tokens.length && tokens.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="px-3 py-3 text-left">代币</th>
                <th className="px-3 py-3 text-left">链</th>
                <th className="px-3 py-3 text-left">Tags</th>
                <th className="px-3 py-3 text-right">价格</th>
                <th className="px-3 py-3 text-right">24h</th>
                <th className="px-3 py-3 text-right">上次买入</th>
                <th className="px-3 py-3 text-right">市值</th>
                <th className="px-3 py-3 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map(token => {
                const chainInfo = CHAIN_LABELS[token.chain] ?? { label: token.chain, color: 'bg-zinc-500/20 text-zinc-300' };
                const isSelected = selectedIds.has(token.id);

                return (
                  <tr
                    key={token.id}
                    className={`border-b border-zinc-800/50 hover:bg-zinc-900/30 ${isSelected ? 'bg-zinc-800/30' : ''}`}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(token.id)}
                      />
                    </td>
                    <td className="px-3 py-3 font-medium">
                      {token.ticker ?? token.contract_address}
                      {token.ticker && token.ticker !== token.contract_address && (
                        <span className="ml-2 text-xs text-zinc-500">{token.contract_address}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs ${chainInfo.color}`}>
                        {chainInfo.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-zinc-400">{token.tags || '-'}</td>
                    <td className="px-3 py-3 text-right font-mono">{formatPrice(token.price)}</td>
                    <td className={`px-3 py-3 text-right font-mono ${
                      (token.price_change_24h ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {formatChange(token.price_change_24h)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-zinc-300">
                      {typeof token.last_buy_at === 'number' && token.last_buy_at > 0
                        ? formatRelativeTimeCompact(token.last_buy_at)
                        : '-'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-zinc-400">
                      {formatMarketCap(token.market_cap)}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        onClick={() => handleDelete([token.id])}
                        className="text-zinc-500 hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}

              {tokens.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-zinc-500">
                    {loading ? '加载中...' : '暂无代币，点击上方添加'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
