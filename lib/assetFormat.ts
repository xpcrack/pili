const usdCompactFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  notation: 'compact',
});

const usdStandardFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatUsdCompact(value: number) {
  return usdCompactFormatter.format(value);
}

export function formatTradeAmountUsdLabel(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '金额未知';
  }

  return formatUsdCompact(value);
}

export function formatUsd(value: number) {
  return usdStandardFormatter.format(value);
}

export function formatUsdOrDash(value: number | null) {
  if (typeof value !== 'number') {
    return '--';
  }
  return formatUsdCompact(value);
}

const tokenAmountFormatter = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumSignificantDigits: 4,
});

function trimTrailingZeros(value: string) {
  if (!value.includes('.')) {
    return value;
  }
  return value.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function formatSignificant(value: number) {
  return trimTrailingZeros(tokenAmountFormatter.format(value));
}

export function formatTokenAmount(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return '0';
  }

  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseFloat(String(value).trim().replace(/,/gu, ''));
  if (!Number.isFinite(numeric)) {
    return '0';
  }

  const sign = numeric < 0 ? '-' : '';
  const abs = Math.abs(numeric);

  if (abs === 0) {
    return '0';
  }

  if (abs >= 1e12) {
    return `${sign}${formatSignificant(abs / 1e12)}T`;
  }
  if (abs >= 1e9) {
    return `${sign}${formatSignificant(abs / 1e9)}B`;
  }
  if (abs >= 1e6) {
    return `${sign}${formatSignificant(abs / 1e6)}M`;
  }
  if (abs >= 1e3) {
    return `${sign}${formatSignificant(abs / 1e3)}K`;
  }

  return `${sign}${formatSignificant(abs)}`;
}
