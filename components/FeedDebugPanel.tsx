'use client';

import { useState } from 'react';

interface FeedDebugPanelProps {
  totalInDatabase: number;
  apiFeedLength: number;
  lastUpdate: Date | null;
}

interface DiagnosticData {
  totalInDatabase: number;
  apiResponseBeforeFilter: number;
  apiResponseAfterFilter: number;
  suspiciousSendersCount: number;
  sampleSuspiciousSenders: string[];
  sampleFilteredItems: Array<{
    txHash: string;
    txAction: string;
    uncertainFrom: boolean;
    chain: string;
    fromAddress: string;
    toAddress: string;
    token: string;
    value: string;
    timestamp: number;
  }>;
  databaseStats: {
    receiveTransactions: number;
    receiveWithUncertainFrom: number;
    receiveWithoutUncertainFrom: number;
    byTxAction: Record<string, number>;
  };
}

export function FeedDebugPanel({ totalInDatabase, apiFeedLength, lastUpdate }: FeedDebugPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiagnostics = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/diagnostics');
      const data = await response.json();
      if (data.ok) {
        setDiagnostics(data.result);
      } else {
        setError(data.error || '获取诊断信息失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取诊断信息失败');
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    if (!isOpen && !diagnostics) {
      fetchDiagnostics();
    }
    setIsOpen(!isOpen);
  };

  const formatAddress = (address: string) => {
    if (!address) return 'N/A';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {!isOpen ? (
        <button
          onClick={handleClick}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2"
        >
          <span>🔍 调试信息</span>
          {apiFeedLength === 0 && totalInDatabase > 0 && (
            <span className="bg-red-500 px-2 py-1 rounded text-xs">⚠️ 有数据未显示</span>
          )}
        </button>
      ) : (
        <div className="bg-gray-900 text-white p-4 rounded-lg shadow-2xl max-w-2xl max-h-[80vh] overflow-auto">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold">数据过滤诊断</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="space-y-3 text-sm">
            <div className="bg-gray-800 p-3 rounded">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">数据库总记录数:</span>
                <span className="font-bold text-green-400">{totalInDatabase}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="text-gray-400">API返回数据量:</span>
                <span className="font-bold">{apiFeedLength}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="text-gray-400">最后更新:</span>
                <span className="text-xs">{lastUpdate?.toLocaleString('zh-CN') || '未更新'}</span>
              </div>
            </div>

            {apiFeedLength === 0 && totalInDatabase > 0 && (
              <div className="bg-red-900/50 p-3 rounded border border-red-500">
                <div className="font-bold text-red-300 mb-2">⚠️ 检测到数据被过滤</div>
                <div className="text-red-200 text-xs">
                  数据库中有 {totalInDatabase} 条记录，但前端显示 0 条。这可能是由于投毒过滤逻辑导致的。
                </div>
              </div>
            )}

            {loading && (
              <div className="text-center text-gray-400 py-4">加载详细诊断信息...</div>
            )}

            {error && (
              <div className="bg-red-900/50 p-3 rounded border border-red-500 text-red-200">
                {error}
              </div>
            )}

            {diagnostics && (
              <>
                <div className="bg-gray-800 p-3 rounded">
                  <div className="font-bold mb-2">服务端过滤统计</div>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-400">过滤前:</span>
                      <span>{diagnostics.apiResponseBeforeFilter}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">过滤后:</span>
                      <span>{diagnostics.apiResponseAfterFilter}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">被过滤:</span>
                      <span className="text-red-400">
                        {diagnostics.apiResponseBeforeFilter - diagnostics.apiResponseAfterFilter}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">可疑发送方数量:</span>
                      <span className="text-yellow-400">{diagnostics.suspiciousSendersCount}</span>
                    </div>
                  </div>
                </div>

                <div className="bg-gray-800 p-3 rounded">
                  <div className="font-bold mb-2">数据库统计</div>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-400">receive 交易总数:</span>
                      <span>{diagnostics.databaseStats.receiveTransactions}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">含 uncertainFrom:</span>
                      <span className="text-yellow-400">
                        {diagnostics.databaseStats.receiveWithUncertainFrom}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">不含 uncertainFrom:</span>
                      <span className="text-green-400">
                        {diagnostics.databaseStats.receiveWithoutUncertainFrom}
                      </span>
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-700">
                      <div className="text-gray-400 mb-1">按交易类型分布:</div>
                      {Object.entries(diagnostics.databaseStats.byTxAction).map(([action, count]) => (
                        <div key={action} className="flex justify-between text-xs">
                          <span className="text-gray-500">{action}:</span>
                          <span>{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {diagnostics.sampleSuspiciousSenders.length > 0 && (
                  <div className="bg-gray-800 p-3 rounded">
                    <div className="font-bold mb-2">可疑发送方示例 (前10个)</div>
                    <div className="space-y-1 max-h-40 overflow-auto">
                      {diagnostics.sampleSuspiciousSenders.map((sender) => {
                        const [chain, address] = sender.split('|');
                        return (
                          <div key={sender} className="text-xs bg-gray-700 p-2 rounded">
                            <div className="flex justify-between">
                              <span className="text-gray-400">{chain}:</span>
                              <span className="font-mono">{formatAddress(address)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {diagnostics.sampleFilteredItems.length > 0 && (
                  <div className="bg-gray-800 p-3 rounded">
                    <div className="font-bold mb-2">被过滤的交易示例</div>
                    <div className="space-y-2 max-h-60 overflow-auto">
                      {diagnostics.sampleFilteredItems.map((item) => (
                        <div key={item.txHash} className="text-xs bg-gray-700 p-2 rounded">
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-gray-400">交易:</span>
                            <span className="font-mono">{formatAddress(item.txHash)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-gray-400">
                            <div>链: {item.chain}</div>
                            <div>动作: {item.txAction}</div>
                            <div>代币: {item.token}</div>
                            <div>金额: {item.value}</div>
                            <div className="col-span-2">
                              发送方: <span className="font-mono">{formatAddress(item.fromAddress)}</span>
                            </div>
                            <div className="col-span-2">
                              接收方: <span className="font-mono">{formatAddress(item.toAddress)}</span>
                            </div>
                            <div>uncertainFrom: {item.uncertainFrom ? '是' : '否'}</div>
                            <div>时间: {formatTimestamp(item.timestamp)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-blue-900/50 p-3 rounded border border-blue-500">
                  <div className="font-bold text-blue-300 mb-2">💡 调试建议</div>
                  <div className="text-blue-200 text-xs space-y-2">
                    <div>
                      <strong>1. 临时禁用过滤:</strong> 设置环境变量{' '}
                      <code className="bg-gray-800 px-1 py-0.5 rounded">DISABLE_POISON_FILTER=true</code>
                      重启服务器，查看数据是否正常显示。
                    </div>
                    <div>
                      <strong>2. 检查过滤阈值:</strong> 当前阈值为发送给{' '}
                      {3} 个以上接收方，每个接收方收到 {3} 次以上交易。如果阈值过严格，可以调整{' '}
                      <code className="bg-gray-800 px-1 py-0.5 rounded">
                        SNAPSHOT_POISON_SENDER_FANOUT_MIN_*
                      </code>{' '}
                      常量。
                    </div>
                    <div>
                      <strong>3. 添加白名单:</strong> 如果识别出某些地址是合法的DEX聚合器，可以将它们添加到白名单中以避免误过滤。
                    </div>
                  </div>
                </div>

                <button
                  onClick={fetchDiagnostics}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded"
                >
                  刷新诊断信息
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
