import type { ChainType } from '@/types';

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function normalizeAddress(value: string) {
  return value.trim();
}

export class InvalidTrackedAddressError extends Error {
  readonly address: string;
  readonly chain: ChainType;

  constructor(address: string, chain: ChainType) {
    super(`${chain} 地址格式无效: ${address}`);
    this.name = 'InvalidTrackedAddressError';
    this.address = address;
    this.chain = chain;
  }
}

export function isValidTrackedAddress(address: string, chain: ChainType) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return false;
  }

  if (chain === 'solana') {
    return SOLANA_ADDRESS_PATTERN.test(normalizedAddress);
  }

  return EVM_ADDRESS_PATTERN.test(normalizedAddress);
}

export function assertValidTrackedAddress(address: string, chain: ChainType) {
  const normalizedAddress = normalizeAddress(address);
  if (!isValidTrackedAddress(normalizedAddress, chain)) {
    throw new InvalidTrackedAddressError(normalizedAddress, chain);
  }

  return normalizedAddress;
}

export function repairMalformedTrackedAddress(address: string, chain: ChainType) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return null;
  }

  if (isValidTrackedAddress(normalizedAddress, chain)) {
    return normalizedAddress;
  }

  const repairPattern =
    chain === 'solana'
      ? /^([1-9A-HJ-NP-Za-km-z]{32,44})#.+$/
      : /^(0x[a-fA-F0-9]{40})#.+$/;
  const repairedAddress = normalizedAddress.match(repairPattern)?.[1] ?? null;

  if (!repairedAddress || !isValidTrackedAddress(repairedAddress, chain)) {
    return null;
  }

  return repairedAddress;
}
