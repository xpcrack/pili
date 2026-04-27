import 'server-only';

export interface TelegramClientConfig {
  apiId: number;
  apiHash: string;
  sessionString: string | null;
  status: 'missing_credentials' | 'auth_required' | 'ready';
}

export function readTelegramClientConfig(): TelegramClientConfig {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
  const sessionString = (process.env.TELEGRAM_SESSION_STRING || '').trim() || null;

  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
    return {
      apiId: Number.isFinite(apiId) ? apiId : 0,
      apiHash,
      sessionString,
      status: 'missing_credentials',
    };
  }

  if (!sessionString) {
    return {
      apiId,
      apiHash,
      sessionString: null,
      status: 'auth_required',
    };
  }

  return {
    apiId,
    apiHash,
    sessionString,
    status: 'ready',
  };
}
