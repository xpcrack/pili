export type FeedTimeDisplayMode = 'relative' | 'absolute';

export interface RelativeTimeState {
  label: string;
  nextUpdateInMs: number | null;
}

const absoluteTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function normalizeFeedTimeDisplayMode(value: string | null | undefined): FeedTimeDisplayMode {
  return value === 'absolute' ? 'absolute' : 'relative';
}

export function getRelativeTimeState(timestamp: number, now = Date.now()): RelativeTimeState {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return {
      label: '暂无动态',
      nextUpdateInMs: null,
    };
  }

  const diffMs = Math.max(0, now - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return {
      label: '刚刚',
      nextUpdateInMs: minuteMs - diffMs,
    };
  }
  if (diffMs < hourMs) {
    return {
      label: `${Math.floor(diffMs / minuteMs)}m`,
      nextUpdateInMs: minuteMs - (diffMs % minuteMs),
    };
  }
  if (diffMs < dayMs) {
    return {
      label: `${Math.floor(diffMs / hourMs)}h`,
      nextUpdateInMs: hourMs - (diffMs % hourMs),
    };
  }
  return {
    label: `${Math.floor(diffMs / dayMs)}d`,
    nextUpdateInMs: dayMs - (diffMs % dayMs),
  };
}

export function formatRelativeTimeCompact(timestamp: number, now = Date.now()) {
  return getRelativeTimeState(timestamp, now).label;
}

export function formatAbsoluteTimeCompact(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '暂无动态';
  }

  const parts = absoluteTimeFormatter.formatToParts(new Date(timestamp));
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${month}-${day} ${hour}:${minute}`;
}
