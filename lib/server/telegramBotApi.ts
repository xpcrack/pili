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
  /** 网络错误（ECONNRESET 等代理抖动）最多尝试次数，默认 3。 */
  maxAttempts?: number;
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
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as TelegramBotApiClientOptions['fetchImpl']);
  const createAgent =
    options.createProxyAgent ?? ((url: string) => new ProxyAgent(url));
  // 可变的 dispatcher：网络错误后重建（ProxyAgent 连接池可能残留已失效的
  // 代理隧道——Clash 切节点后旧连接全死，复用一个静态 dispatcher 会永远
  // ECONNRESET；重建代理 + 重试才能自愈）。
  let dispatcher = proxyUrl ? createAgent(proxyUrl) : undefined;

  function isTransientNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.message.startsWith(`Telegram `)) return false; // 业务错误（409 等）
    const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''} ${(error.cause as { code?: string } | undefined)?.code ?? ''}`;
    return /ECONNRESET|socket disconnected|ETIMEDOUT|ECONNREFUSED|UND_ERR_SOCKET|network|TLS|reset by peer|EPIPE/i.test(
      text
    );
  }

  return async function telegramBotApi<T>(method: string, body?: Record<string, unknown>) {
    const longPollMs = Number(body?.timeout) > 0 ? Number(body?.timeout) * 1_000 + 10_000 : 0;
    const deadlineMs = Math.max(timeoutMs, longPollMs);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl!(`${apiBase}/bot${token}/${method}`, {
          method: body ? 'POST' : 'GET',
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          dispatcher,
          signal: AbortSignal.timeout(deadlineMs),
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
        lastError = error;
        if (!isTransientNetworkError(error) || attempt >= maxAttempts) break;
        // 重建代理：丢弃可能残留死隧道的旧连接池，再退避重试。
        dispatcher = proxyUrl ? createAgent(proxyUrl) : undefined;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    throw new Error(`Telegram ${method} network failed: ${describeNetworkError(lastError)}`, {
      cause: lastError,
    });
  };
}
