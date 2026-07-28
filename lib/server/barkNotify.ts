import 'server-only';

/**
 * Bark push, fanned out to every configured device.
 *
 * Extracted from primaryPoolSymbols so trade signals and pool alerts share one
 * sender. Adds a timeout and retries, which the original lacked — a hung
 * api.day.app request used to stall the caller indefinitely.
 */

const DEFAULT_BARK_URLS =
  'https://api.day.app/kZdThYxm7DXZDvXtjyBsNV,https://api.day.app/sUE4eWUoGvY7jKuWUy9oVS';
const ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const MAX_BODY_LENGTH = 500;

export interface BarkPushOptions {
  title: string;
  body: string;
  /** Bark notification group, used for grouping in the iOS notification centre. */
  group?: string;
  /** 'active' shows immediately; 'critical' rings through silent mode. */
  level?: 'active' | 'timeSensitive' | 'passive' | 'critical';
  /** Ring continuously until dismissed. Reserve for signals worth waking up for. */
  call?: boolean;
  /** Tapping the notification opens this URL. */
  targetUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BarkPushResult {
  attempted: number;
  delivered: number;
}

function resolveBarkUrls() {
  const raw = process.env.PILI_BARK_URLS || process.env.NEWONE_NOTIFY_BARK_URL || DEFAULT_BARK_URLS;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function pushOne(base: string, options: BarkPushOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const url = new URL(`${base.replace(/\/$/, '')}/${encodeURIComponent(options.title)}`);
  url.searchParams.set('body', options.body.slice(0, MAX_BODY_LENGTH));
  if (options.group) url.searchParams.set('group', options.group);
  if (options.level) url.searchParams.set('level', options.level);
  if (options.call) url.searchParams.set('call', '1');
  if (options.targetUrl) url.searchParams.set('url', options.targetUrl);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.ok) return true;
    } catch {
      // fall through to retry
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  return false;
}

/** Best-effort push to all devices. Never throws — a failed alert must not break a task. */
export async function pushBark(options: BarkPushOptions): Promise<BarkPushResult> {
  const urls = resolveBarkUrls();
  if (urls.length === 0) return { attempted: 0, delivered: 0 };

  const results = await Promise.allSettled(urls.map((base) => pushOne(base, options)));
  const delivered = results.filter((result) => result.status === 'fulfilled' && result.value).length;

  if (delivered === 0) {
    console.warn(`[bark] all ${urls.length} device(s) failed for "${options.title}"`);
  }
  return { attempted: urls.length, delivered };
}
