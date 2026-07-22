function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function buildTelegramMonitorTxAggregateKey(
  chain: string | null | undefined,
  trackedWalletAddress: string | null | undefined,
  txHash: string | null | undefined,
  tokenAddress?: string | null | undefined
) {
  const normalizedChain = normalize(chain);
  const normalizedTracked = normalize(trackedWalletAddress);
  const normalizedTxHash = normalize(txHash);
  const normalizedToken = normalize(tokenAddress);

  if (!normalizedChain || !normalizedTracked || !normalizedTxHash) {
    return null;
  }

  if (!normalizedToken) {
    return `xxyy-monitor:${normalizedChain}:${normalizedTracked}:${normalizedTxHash}`;
  }

  return `xxyy-monitor:${normalizedChain}:${normalizedTracked}:${normalizedTxHash}:${normalizedToken}`;
}
