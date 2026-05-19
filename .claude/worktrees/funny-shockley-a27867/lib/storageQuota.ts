export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  // Cross-browser quota errors:
  // - code 22: QuotaExceededError (most browsers)
  // - code 1014: NS_ERROR_DOM_QUOTA_REACHED (Firefox)
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}
