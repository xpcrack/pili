import 'server-only';

function normalize(value: string | null | undefined) {
  return (value || '').trim();
}

export function readTelegramApprovalAdminUserIds() {
  return new Set(
    normalize(process.env.TELEGRAM_APPROVAL_ADMIN_USER_IDS)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function isTelegramApprovalAdmin(userId: string) {
  return readTelegramApprovalAdminUserIds().has(normalize(userId));
}
