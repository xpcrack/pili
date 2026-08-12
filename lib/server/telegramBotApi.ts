import 'server-only';

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

type TelegramApiResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

type TelegramFetchInit = RequestInit & { dispatcher?: Dispatcher };

export type TelegramBotApiClientOptions = {
  token: string;
  apiBase?: string;
  proxyUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: (input: string, init: TelegramFetchInit) => Promise<Response>;
  createProxyAgent?: (proxyUrl: string) => Dispatcher;
};

export function readTelegramBotApiProxyUrl(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.TELEGRAM_BOT_API_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.ALL_PROXY?.trim() ||
    null
  );
}

function describeNetworkError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const causeDetail = [cause?.code, cause?.message].filter(Boolean).join(' ');
  return causeDetail ? `${error.message}: ${causeDetail}` : error.message;
}

export function createTelegramBotApiClient(options: TelegramBotApiClientOptions) {
  const token = options.token.trim();
  const apiBase = (options.apiBase || 'https://api.telegram.org').replace(/\/$/, '');
  const proxyUrl = options.proxyUrl?.trim() || null;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 45_000);
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as TelegramBotApiClientOptions['fetchImpl']);
  const dispatcher = proxyUrl
    ? (options.createProxyAgent ?? ((url: string) => new ProxyAgent(url)))(proxyUrl)
    : undefined;

  return async function telegramBotApi<T>(method: string, body?: Record<string, unknown>) {
    const longPollMs = Number(body?.timeout) > 0 ? Number(body?.timeout) * 1_000 + 10_000 : 0;
    try {
      const response = await fetchImpl!(`${apiBase}/bot${token}/${method}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        dispatcher,
        signal: AbortSignal.timeout(Math.max(timeoutMs, longPollMs)),
      });

      const payload = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(
          `Telegram ${method} failed: ${response.status} ${payload?.description || 'unknown error'}`
        );
      }
      return payload.result as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`Telegram ${method} failed:`)) {
        throw error;
      }
      throw new Error(`Telegram ${method} network failed: ${describeNetworkError(error)}`, {
        cause: error,
      });
    }
  };
}
