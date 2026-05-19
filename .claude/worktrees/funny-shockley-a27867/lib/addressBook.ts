import type { AddressInfo, ChainType, User } from '@/types';

export const EVM_CHAINS: ChainType[] = ['bsc', 'ethereum', 'base'];

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

export function isEvmChain(chain: string | null | undefined): chain is ChainType {
  return chain === 'bsc' || chain === 'ethereum' || chain === 'base';
}

export function isEvmAddress(address: string) {
  return normalize(address).startsWith('0x');
}

export function inferChainFromAddress(address: string): ChainType {
  return isEvmAddress(address) ? 'bsc' : 'solana';
}

export function getAddressNetworkLabel(params: {
  address: string;
  chain: ChainType;
  chains?: readonly ChainType[];
}) {
  const chains = params.chains || [params.chain];
  if (chains.some((chain) => isEvmChain(chain)) || isEvmAddress(params.address)) {
    return 'EVM地址';
  }
  return 'SOL地址';
}

export function expandTrackedAddresses<T extends AddressInfo>(addresses: readonly T[]): T[] {
  const expanded = new Map<string, T>();

  for (const address of addresses) {
    const normalizedAddress = address.address.trim();
    const normalizedAddressLower = normalize(normalizedAddress);
    if (!normalizedAddressLower) {
      continue;
    }

    const nextChains =
      isEvmAddress(normalizedAddress) || isEvmChain(address.chain)
        ? EVM_CHAINS
        : [address.chain];

    for (const chain of nextChains) {
      const key = `${chain}:${normalizedAddressLower}`;
      if (expanded.has(key)) {
        continue;
      }

      expanded.set(key, {
        ...address,
        address: normalizedAddress,
        chain,
      });
    }
  }

  return Array.from(expanded.values());
}

export interface DisplayAddressGroup {
  address: string;
  name: string;
  chain: ChainType;
  chains: ChainType[];
  networkLabel: string;
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
}

export function groupAddressesForDisplay(addresses: readonly AddressInfo[]): DisplayAddressGroup[] {
  const grouped = new Map<string, DisplayAddressGroup>();

  for (const address of addresses) {
    const normalizedAddress = address.address.trim();
    const normalizedAddressLower = normalize(normalizedAddress);
    if (!normalizedAddressLower) {
      continue;
    }

    const evm = isEvmAddress(normalizedAddress) || isEvmChain(address.chain);
    const key = evm ? `evm:${normalizedAddressLower}` : `${address.chain}:${normalizedAddressLower}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        address: normalizedAddress,
        name: address.name,
        chain: address.chain,
        chains: [address.chain],
        networkLabel: getAddressNetworkLabel({
          address: normalizedAddress,
          chain: address.chain,
          chains: [address.chain],
        }),
        totalAssetUsd: typeof address.totalAssetUsd === 'number' ? address.totalAssetUsd : null,
        assetUpdatedAt: typeof address.assetUpdatedAt === 'number' ? address.assetUpdatedAt : null,
      });
      continue;
    }

    if (!existing.chains.includes(address.chain)) {
      existing.chains.push(address.chain);
      existing.chains.sort((left, right) => EVM_CHAINS.indexOf(left) - EVM_CHAINS.indexOf(right));
    }

    if (typeof address.totalAssetUsd === 'number') {
      existing.totalAssetUsd = (existing.totalAssetUsd || 0) + address.totalAssetUsd;
    }

    if (typeof address.assetUpdatedAt === 'number') {
      existing.assetUpdatedAt = Math.max(existing.assetUpdatedAt || 0, address.assetUpdatedAt);
    }

    existing.networkLabel = getAddressNetworkLabel({
      address: existing.address,
      chain: existing.chain,
      chains: existing.chains,
    });
  }

  return Array.from(grouped.values());
}

export function formatUsersForAddressExport(users: readonly User[]) {
  return users
    .flatMap((user) =>
      groupAddressesForDisplay(user.addresses).map((address) => `${address.address}:${user.name}${address.name}`)
    )
    .join('\n');
}

function toGmgnChainSegment(chain: string | null | undefined) {
  if (chain === 'solana') return 'sol';
  if (chain === 'bsc') return 'bsc';
  if (chain === 'ethereum') return 'eth';
  if (chain === 'base') return 'base';
  return null;
}

export function buildGmgnTokenUrl(chain: string | null | undefined, tokenAddress: string) {
  const chainSegment = toGmgnChainSegment(chain);
  const normalizedAddress = tokenAddress.trim();
  if (!chainSegment || !normalizedAddress) {
    return null;
  }
  return `https://gmgn.ai/${chainSegment}/token/${encodeURIComponent(normalizedAddress)}`;
}

export function buildGmgnAddressUrl(chain: string | null | undefined, address: string) {
  const chainSegment = toGmgnChainSegment(chain);
  const normalizedAddress = address.trim();
  if (!chainSegment || !normalizedAddress) {
    return null;
  }
  return `https://gmgn.ai/${chainSegment}/address/${encodeURIComponent(normalizedAddress)}`;
}
