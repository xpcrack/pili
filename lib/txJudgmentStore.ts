import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Activity } from '@/types';

const STORE_DIR = path.join(process.cwd(), '.data');
const STORE_FILE = path.join(STORE_DIR, 'tx-judgments.json');
const STORE_VERSION = 1;
const MAX_RECORDS = 50000;

export interface TxJudgmentRecord {
  key: string;
  chain: string;
  address: string;
  txHash: string;
  txAction: NonNullable<Activity['metadata']['txAction']>;
  token?: string;
  value?: string;
  tokenAddress?: string;
  fromAddress?: string;
  toAddress?: string;
  uncertainFrom: boolean;
  updatedAt: number;
}

interface TxJudgmentStoreFile {
  version: number;
  updatedAt: number;
  records: TxJudgmentRecord[];
}

let storeCache: Map<string, TxJudgmentRecord> | null = null;
let loadPromise: Promise<Map<string, TxJudgmentRecord>> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function normalize(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function buildKey(chain: string, address: string, txHash: string) {
  return `${normalize(chain)}|${normalize(address)}|${normalize(txHash)}`;
}

function cloneRecord(record: TxJudgmentRecord): TxJudgmentRecord {
  return { ...record };
}

function isValidRecord(record: Partial<TxJudgmentRecord>): record is TxJudgmentRecord {
  return (
    typeof record.key === 'string' &&
    typeof record.chain === 'string' &&
    typeof record.address === 'string' &&
    typeof record.txHash === 'string' &&
    typeof record.txAction === 'string' &&
    typeof record.updatedAt === 'number' &&
    typeof record.uncertainFrom === 'boolean'
  );
}

async function persistStore(store: Map<string, TxJudgmentRecord>) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const records = Array.from(store.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS);
  const payload: TxJudgmentStoreFile = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    records,
  };
  const tempFile = `${STORE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(payload), 'utf8');
  await fs.rename(tempFile, STORE_FILE);
}

async function loadStore() {
  if (storeCache) {
    return storeCache;
  }
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    const initialStore = new Map<string, TxJudgmentRecord>();
    try {
      const raw = await fs.readFile(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TxJudgmentStoreFile>;
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const candidate of records) {
        if (!isValidRecord(candidate)) {
          continue;
        }
        initialStore.set(candidate.key, cloneRecord(candidate));
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn('[txJudgmentStore] failed to load store:', error);
      }
    }
    storeCache = initialStore;
    return initialStore;
  })();

  return loadPromise;
}

export async function readTxJudgment(chain: string, address: string, txHash: string) {
  const store = await loadStore();
  const key = buildKey(chain, address, txHash);
  const found = store.get(key);
  return found ? cloneRecord(found) : null;
}

export async function upsertTxJudgments(records: Array<Omit<TxJudgmentRecord, 'key' | 'updatedAt'>>) {
  if (records.length === 0) {
    return;
  }
  const store = await loadStore();
  let changed = false;
  const now = Date.now();

  for (const input of records) {
    const chain = normalize(input.chain);
    const address = normalize(input.address);
    const txHash = normalize(input.txHash);
    if (!chain || !address || !txHash) {
      continue;
    }
    const key = buildKey(chain, address, txHash);
    const next: TxJudgmentRecord = {
      key,
      chain,
      address,
      txHash,
      txAction: input.txAction,
      token: input.token,
      value: input.value,
      tokenAddress: input.tokenAddress,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      uncertainFrom: input.uncertainFrom,
      updatedAt: now,
    };

    const prev = store.get(key);
    if (
      prev &&
      prev.txAction === next.txAction &&
      prev.token === next.token &&
      prev.value === next.value &&
      prev.tokenAddress === next.tokenAddress &&
      prev.fromAddress === next.fromAddress &&
      prev.toAddress === next.toAddress &&
      prev.uncertainFrom === next.uncertainFrom
    ) {
      continue;
    }

    changed = true;
    store.set(key, next);
  }

  if (!changed) {
    return;
  }

  writeQueue = writeQueue
    .then(() => persistStore(store))
    .catch((error) => {
      console.warn('[txJudgmentStore] failed to persist store:', error);
    });

  await writeQueue;
}

export async function readTxJudgmentStoreVersion() {
  try {
    const stats = await fs.stat(STORE_FILE);
    return stats.mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[txJudgmentStore] failed to stat store:', error);
    }
    return 0;
  }
}
