import { buildGmgnAddressUrl, groupAddressesForDisplay, isEvmChain } from '@/lib/addressBook';
import type { ChainType, User } from '@/types';

const EVM_DISPLAY_CHAINS: ChainType[] = ['bsc', 'ethereum', 'base'];

export interface AddressManagementRow {
  userId: string;
  userName: string;
  addressName: string;
  displayName: string;
  address: string;
  primaryChain: ChainType;
  chains: ChainType[];
  networkLabel: 'EVM地址' | 'SOL地址';
  totalAssetUsd: number | null;
  assetUpdatedAt: number | null;
  latestActivityAt: number | null;
  gmgnUrl: string | null;
}

function normalize(value: string | null | undefined) {
  return (value || '').trim().toLowerCase();
}

function buildChainAddressKey(chain: string, address: string) {
  return `${normalize(chain)}:${normalize(address)}`;
}

function readLatestActivityAt(
  latestActivityByChainAddress: ReadonlyMap<string, number>,
  chain: string,
  address: string
) {
  const key = buildChainAddressKey(chain, address);
  const value = latestActivityByChainAddress.get(key);
  return typeof value === 'number' ? value : null;
}

function compareRows(left: AddressManagementRow, right: AddressManagementRow) {
  const byDisplayName = left.displayName.localeCompare(right.displayName, 'zh-CN');
  if (byDisplayName !== 0) {
    return byDisplayName;
  }

  const leftIsEvm = left.primaryChain !== 'solana';
  const rightIsEvm = right.primaryChain !== 'solana';
  if (leftIsEvm !== rightIsEvm) {
    return leftIsEvm ? -1 : 1;
  }

  return left.address.localeCompare(right.address);
}

export function buildAddressManagementRows(
  users: readonly User[],
  latestActivityByChainAddress: ReadonlyMap<string, number>
): AddressManagementRow[] {
  const rows = users.flatMap((user) =>
    groupAddressesForDisplay(user.addresses).map((addressGroup) => {
      const evmChains = addressGroup.chains.filter(isEvmChain);
      const isEvm = evmChains.length > 0;
      const chains = isEvm
        ? EVM_DISPLAY_CHAINS.filter((chain) => evmChains.includes(chain))
        : ['solana' satisfies ChainType];
      const primaryChain = isEvm ? 'bsc' : 'solana';
      const latestActivityAt = chains.reduce<number | null>((latest, chain) => {
        const next = readLatestActivityAt(latestActivityByChainAddress, chain, addressGroup.address);
        if (typeof next !== 'number') {
          return latest;
        }
        return typeof latest === 'number' ? Math.max(latest, next) : next;
      }, null);

      return {
        userId: user.id,
        userName: user.name,
        addressName: addressGroup.name,
        displayName: `${user.name}${addressGroup.name}`,
        address: addressGroup.address,
        primaryChain,
        chains,
        networkLabel: isEvm ? 'EVM地址' : 'SOL地址',
        totalAssetUsd: typeof addressGroup.totalAssetUsd === 'number' ? addressGroup.totalAssetUsd : null,
        assetUpdatedAt: typeof addressGroup.assetUpdatedAt === 'number' ? addressGroup.assetUpdatedAt : null,
        latestActivityAt,
        gmgnUrl: buildGmgnAddressUrl(isEvm ? 'bsc' : 'solana', addressGroup.address),
      };
    })
  );

  return rows.sort(compareRows);
}
