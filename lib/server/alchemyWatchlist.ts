/**
 * Keep pili-owned Alchemy Address Activity webhooks equal to tracked_users wallets.
 * Never reuse newone webhook ids — shared ids will delete each other's addresses.
 */
import 'server-only';

const API = 'https://dashboard.alchemy.com/api';
const PAGE_SIZE = 100;

export type AlchemyWebhookIds = {
  eth?: string;
  base?: string;
  bsc?: string;
  sol?: string;
  /** Optional; only when Dashboard exposes Robinhood Address Activity. */
  robinhood?: string;
};

export type AlchemyWatchlistSyncSummary = {
  desired_evm: number;
  desired_sol: number;
  webhooks: Array<{ chain: keyof AlchemyWebhookIds; added: number; removed: number; skipped?: boolean }>;
};

export function readPiliAlchemyWebhookIdsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AlchemyWebhookIds {
  return {
    eth: trimEnv(env.PILI_ALCHEMY_WEBHOOK_ETH),
    base: trimEnv(env.PILI_ALCHEMY_WEBHOOK_BASE),
    bsc: trimEnv(env.PILI_ALCHEMY_WEBHOOK_BSC),
    sol: trimEnv(env.PILI_ALCHEMY_WEBHOOK_SOL),
    robinhood: trimEnv(env.PILI_ALCHEMY_WEBHOOK_RH || env.PILI_ALCHEMY_WEBHOOK_ROBINHOOD),
  };
}

export function hasPiliOwnedWebhookIds(ids: AlchemyWebhookIds) {
  return Boolean(ids.eth || ids.base || ids.bsc || ids.sol || ids.robinhood);
}

function trimEnv(value: string | undefined) {
  const trimmed = (value || '').trim();
  return trimmed || undefined;
}

async function alchemy<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'X-Alchemy-Token': token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Alchemy ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

async function listWebhookAddresses(token: string, webhookId: string): Promise<string[]> {
  const all: string[] = [];
  let after = '';
  do {
    const params = new URLSearchParams({ webhook_id: webhookId, limit: String(PAGE_SIZE) });
    if (after) params.set('after', after);
    const page = await alchemy<{
      data?: string[];
      pagination?: { cursors?: { after?: string } };
    }>(token, `/webhook-addresses?${params}`);
    all.push(...(page.data ?? []));
    after = page.pagination?.cursors?.after ?? '';
  } while (after);
  return all;
}

async function syncOne(
  token: string,
  webhookId: string,
  desired: string[]
): Promise<{ added: number; removed: number }> {
  const current = await listWebhookAddresses(token, webhookId);
  const normalize = (address: string) => (address.startsWith('0x') ? address.toLowerCase() : address);
  const wanted = new Map(desired.map((address) => [normalize(address), address]));
  const have = new Map(current.map((address) => [normalize(address), address]));
  const add = [...wanted].filter(([key]) => !have.has(key)).map(([, address]) => address);
  const remove = [...have].filter(([key]) => !wanted.has(key)).map(([, address]) => address);
  if (add.length || remove.length) {
    await alchemy(token, '/update-webhook-addresses', {
      method: 'PATCH',
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: add,
        addresses_to_remove: remove,
      }),
    });
  }
  return { added: add.length, removed: remove.length };
}

export function splitTrackedAddresses(addresses: string[]) {
  const active = addresses.map((address) => address.trim()).filter(Boolean);
  const evm = [
    ...new Set(
      active
        .filter((address) => /^0x[0-9a-f]{40}$/i.test(address))
        .map((address) => address.toLowerCase())
    ),
  ];
  const sol = [...new Set(active.filter((address) => !address.toLowerCase().startsWith('0x')))];
  return { evm, sol };
}

export async function syncAlchemyWatchlist(opts: {
  token: string;
  webhook_ids: AlchemyWebhookIds;
  addresses: string[];
}): Promise<AlchemyWatchlistSyncSummary> {
  const { evm, sol } = splitTrackedAddresses(opts.addresses);
  const desired: Record<keyof AlchemyWebhookIds, string[]> = {
    eth: evm,
    base: evm,
    bsc: evm,
    sol,
    robinhood: evm,
  };

  const webhooks: AlchemyWatchlistSyncSummary['webhooks'] = [];
  for (const chain of ['eth', 'base', 'bsc', 'sol', 'robinhood'] as const) {
    const webhookId = opts.webhook_ids[chain];
    if (!webhookId) {
      webhooks.push({ chain, added: 0, removed: 0, skipped: true });
      continue;
    }
    webhooks.push({
      chain,
      ...(await syncOne(opts.token, webhookId, desired[chain])),
    });
  }

  return { desired_evm: evm.length, desired_sol: sol.length, webhooks };
}
