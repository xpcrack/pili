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
  /** 单代理（兼容旧签名）或代理池：网络错误时按顺序 failover 到下一个。 */
  proxyUrl?: string | string[] | null;
  timeoutMs?: number;
  /** 网络错误（ECONNRESET 等代理抖动）最多尝试次数，默认 3。 */
  maxAttempts?: number;
  /** 一次调用里每个网络错误（含 failover 切换）都会回调；用于 bridge 断流告警。 */
  onNetworkFailure?: (info: { attempt: number; proxy: string | null; error: string }) => void;
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

/**
 * 代理池：优先读 TELEGRAM_BOT_API_PROXY_POOL（逗号分隔多值），
 * 没有则回退单值链 TELEGRAM_BOT_API_PROXY → HTTPS_PROXY → …。
 */
export function readTelegramBotApiProxyList(env: NodeJS.ProcessEnv = process.env): string[] {
  const pool = env.TELEGRAM_BOT_API_PROXY_POOL?.trim();
  if (pool) {
    const list = pool
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (list.length) return list;
  }
  const one = readTelegramBotApiProxyUrl(env);
  return one ? [one] : [];
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
  const proxyList = Array.isArray(options.proxyUrl)
    ? options.proxyUrl.map((value) => value.trim()).filter(Boolean)
    : options.proxyUrl?.trim()
      ? [options.proxyUrl.trim()]
      : [];
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 45_000);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as TelegramBotApiClientOptions['fetchImpl']);
  const createAgent =
    options.createProxyAgent ?? ((url: string) => new ProxyAgent(url));
  const onNetworkFailure = options.onNetworkFailure;
  // 可变的 dispatcher：网络错误后重建（ProxyAgent 连接池可能残留已失效的
  // 代理隧道——Clash 切节点后旧连接全死，复用一个静态 dispatcher 会永远
  // ECONNRESET；重建代理 + 重试才能自愈）。
  // 2026-09-08: 升级为代理池 failover——单代理隧道死亡（当晚 Clash 主端口到
  // api.telegram.org 断流 2h）时按顺序切到池里下一个代理，不再死磕一根。
  let dispatcher: Dispatcher | undefined =
    proxyList.length ? createAgent(proxyList[0]) : undefined;
  let proxyIndex = 0;

  function isTransientNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.message.startsWith(`Telegram `)) return false; // 业务错误（409 等）
    const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''} ${(error.cause as { code?: string } | undefined)?.code ?? ''}`;
    return /ECONNRESET|socket disconnected|ETIMEDOUT|ECONNREFUSED|UND_ERR_SOCKET|network|TLS|reset by peer|EPIPE|aborted due to timeout|timeout/i.test(
      text
    );
  }

  function rotateProxy() {
    if (proxyList.length === 0) {
      dispatcher = undefined;
      return null;
    }
    proxyIndex = (proxyIndex + 1) % proxyList.length;
    dispatcher = createAgent(proxyList[proxyIndex]);
    return proxyList[proxyIndex];
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
        const described = describeNetworkError(error);
        if (!isTransientNetworkError(error) || attempt >= maxAttempts) {
          onNetworkFailure?.({
            attempt,
            proxy: proxyList[proxyIndex] ?? null,
            error: described,
          });
          break;
        }
        // failover：重建代理并切到池中下一个（单代理=同端口重建，效果同旧逻辑）。
        const nextProxy = rotateProxy();
        onNetworkFailure?.({ attempt, proxy: nextProxy ?? proxyList[proxyIndex] ?? null, error: described });
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
    throw new Error(`Telegram ${method} network failed: ${describeNetworkError(lastError)}`, {
      cause: lastError,
    });
  };
}
