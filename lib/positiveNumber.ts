/** Parse a positive finite amount from a number or comma-separated string. */
export function parsePositiveFiniteNumber(value: string | number | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  // B6: 完整字符串校验，不用 parseFloat 前缀解析——"123abc" 之前会被静默
  // 当成 123 进入交易金额/PnL。千分位逗号是合法输入（注释明确允许），
  // 但必须符合 1-3 位首组 + 每组三位的格式，"1,2,3" 不接受。
  const normalized = value.trim().replaceAll(',', '');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
