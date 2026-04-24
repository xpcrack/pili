import 'server-only';

function normalizeEnvValue(value: string | undefined | null) {
  const trimmed = (value || '').trim();
  return trimmed || '';
}

export function resolveTelegramBotToken() {
  return (
    normalizeEnvValue(process.env.tgbot_out_token) ||
    normalizeEnvValue(process.env.TELEGRAM_RELAY_BOT_TOKEN) ||
    normalizeEnvValue(process.env.TELEGRAM_BRIDGE_BOT_TOKEN)
  );
}
