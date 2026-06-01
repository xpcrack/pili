import assert from 'node:assert/strict';

import './server-only-shim.cjs';

import {
  DEFAULT_NVIDIA_ENRICHMENT_MODEL,
  resolveNvidiaEnrichmentModel,
} from '../lib/server/nvidiaEnrichmentModel';

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

withEnv('NVIDIA_MODEL', undefined, () => {
  assert.equal(resolveNvidiaEnrichmentModel(), DEFAULT_NVIDIA_ENRICHMENT_MODEL);
  assert.notEqual(DEFAULT_NVIDIA_ENRICHMENT_MODEL, 'qwen/qwen2.5-7b-instruct');
});

withEnv('NVIDIA_MODEL', 'meta/llama-3.1-8b-instruct', () => {
  assert.equal(resolveNvidiaEnrichmentModel(), 'meta/llama-3.1-8b-instruct');
});

withEnv('NVIDIA_MODEL', '   ', () => {
  assert.equal(resolveNvidiaEnrichmentModel(), DEFAULT_NVIDIA_ENRICHMENT_MODEL);
});

console.log('PASS nvidia enrichment config');
