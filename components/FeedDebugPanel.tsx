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
  hiddenByMinUsdCount: number;
  pendingValuationCount: number;
  filterReasonStats: Record<string, number>;
  sampleHiddenOrPendingItems: Array<{
    txHash: string;
    decision: string;
    reasonCode: string;
    reasonText: string;
    computedUsdValue: number | null;
    txAction: string;
    chain: string;
    fromAddress: string;
    toAddress: string;
    token: string;
    value: string;
    quoteToken: string;
    quoteAmount: string;
    timestamp: number | null;
  }>;
  databaseStats: {
    judgmentCount: number;
    visibleCount: number;
    hiddenCount: number;
    pendingCount: number;
    receiveTransactions: number;
    receiveWithUncertainFrom: number;
    receiveWithoutUncertainFrom: number;
    byTxAction: Record<string, number>;
    byDecision: Record<string, number>;
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
                      <span className="text-gray-400">低于 5U 隐藏:</span>
                      <span className="text-red-300">{diagnostics.hiddenByMinUsdCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">待判定估值:</span>
                      <span className="text-amber-300">{diagnostics.pendingValuationCount}</span>
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
                      <span className="text-gray-400">判定总数:</span>
                      <span>{diagnostics.databaseStats.judgmentCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">visible / hidden / pending:</span>
                      <span>
                        {diagnostics.databaseStats.visibleCount} / {diagnostics.databaseStats.hiddenCount} /{' '}
                        {diagnostics.databaseStats.pendingCount}
                      </span>
                    </div>
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
                    <div className="mt-2 pt-2 border-t border-gray-700">
                      <div className="text-gray-400 mb-1">按判定结果分布:</div>
                      {Object.entries(diagnostics.databaseStats.byDecision).map(([decision, count]) => (
                        <div key={decision} className="flex justify-between text-xs">
                          <span className="text-gray-500">{decision}:</span>
                          <span>{count}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-700">
                      <div className="text-gray-400 mb-1">按过滤原因分布:</div>
                      {Object.entries(diagnostics.filterReasonStats).map(([reason, count]) => (
                        <div key={reason} className="flex justify-between text-xs">
                          <span className="text-gray-500">{reason}:</span>
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

                {diagnostics.sampleHiddenOrPendingItems.length > 0 && (
                  <div className="bg-gray-800 p-3 rounded">
                    <div className="font-bold mb-2">hidden / pending 示例</div>
                    <div className="space-y-2 max-h-60 overflow-auto">
                      {diagnostics.sampleHiddenOrPendingItems.map((item) => (
                        <div key={`${item.decision}-${item.txHash}`} className="text-xs bg-gray-700 p-2 rounded">
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-gray-400">交易:</span>
                            <span className="font-mono">{formatAddress(item.txHash)}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1 text-gray-400">
                            <div>链: {item.chain}</div>
                            <div>动作: {item.txAction}</div>
                            <div>判定: {item.decision}</div>
                            <div>原因: {item.reasonCode}</div>
                            <div>代币: {item.token}</div>
                            <div>金额: {item.value}</div>
                            <div>报价币: {item.quoteToken || 'N/A'}</div>
                            <div>报价额: {item.quoteAmount || 'N/A'}</div>
                            <div>估值: {typeof item.computedUsdValue === 'number' ? `$${item.computedUsdValue}` : '待判定'}</div>
                            <div>时间: {item.timestamp ? formatTimestamp(item.timestamp) : 'N/A'}</div>
                            <div className="col-span-2">说明: {item.reasonText}</div>
                            <div className="col-span-2">
                              发送方: <span className="font-mono">{formatAddress(item.fromAddress)}</span>
                            </div>
                            <div className="col-span-2">
                              接收方: <span className="font-mono">{formatAddress(item.toAddress)}</span>
                            </div>
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
                      <strong>1. 调整金额阈值:</strong> 设置环境变量{' '}
                      <code className="bg-gray-800 px-1 py-0.5 rounded">CHAIN_ACTIVITY_MIN_USD_VALUE</code>
                      后重启服务器，可调低或调高最小展示金额。
                    </div>
                    <div>
                      <strong>2. 检查待判定:</strong> pending 说明当前无法可靠换算美元价值；如需更激进，可补充 token 定价来源。
                    </div>
                    <div>
                      <strong>3. 检查投毒阈值:</strong> 当前 legacy 投毒统计仍以发送给 {3} 个以上接收方、每个接收方收到 {3} 次以上交易为口径。如果阈值过严格，可以调整{' '}
                      <code className="bg-gray-800 px-1 py-0.5 rounded">
                        SNAPSHOT_POISON_SENDER_FANOUT_MIN_*
                      </code>{' '}
                      常量。
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
