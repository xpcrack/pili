export function formatRelativeTimeCompact(timestamp: number, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '暂无动态';
  }

  const diffMs = Math.max(0, now - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) {
    return '刚刚';
  }
  if (diffMs < hourMs) {
    return `${Math.floor(diffMs / minuteMs)}m`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}h`;
  }
  return `${Math.floor(diffMs / dayMs)}d`;
}
