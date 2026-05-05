import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

async function run() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pilipili-completeness-api-'));
  const previousDbPath = process.env.PILIPILI_DB_PATH;
  const previousDataDir = process.env.PILIPILI_DATA_DIR;
  const previousAdminToken = process.env.ADMIN_API_TOKEN;
  process.env.PILIPILI_DATA_DIR = tempDir;
  process.env.PILIPILI_DB_PATH = path.join(tempDir, 'test.sqlite');
  process.env.ADMIN_API_TOKEN = 'test-admin-token';

  try {
    const { saveSystemConfig } = await import('../lib/server/systemConfigRepo');
    const { saveCompletenessGlobalState, saveCompletenessSourceState } = await import('../lib/server/completenessRepo');
    const route = await import('../app/api/completeness/route');

    saveSystemConfig({
      completenessStartMs: 1_712_000_000_000,
    });
    saveCompletenessGlobalState({
      configuredStartMs: 1_712_000_000_000,
      globalProvenStartMs: null,
      status: 'partial',
      activeRunId: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    saveCompletenessSourceState({
      source: 'twitter',
      requestedStartMs: 1_712_000_000_000,
      provenStartMs: 1_712_500_000_000,
      provenEndMs: 1_713_000_000_000,
      status: 'blocked',
      failureCount: 4,
      lastSuccessAt: null,
      lastFailureAt: 1_713_000_000_000,
      blockedReason: 'provider budget',
      checkpointJson: '{"cursor":"tw-123"}',
    });

    const getResponse = await route.GET();
    assert.equal(getResponse.status, 200);
    const getPayload = await getResponse.json();
    assert.equal(getPayload.ok, true);
    assert.equal(getPayload.completeness.globalState.configuredStartMs, 1_712_000_000_000);
    assert.equal(
      getPayload.completeness.sourceStates.find((item: { source: string }) => item.source === 'twitter')?.source,
      'twitter'
    );

    const clearResponse = await route.POST(
      new NextRequest('http://localhost:3005/api/completeness', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': 'test-admin-token',
        },
        body: JSON.stringify({
          action: 'clear-source-checkpoint',
          source: 'twitter',
        }),
      })
    );
    assert.equal(clearResponse.status, 200);
    const clearPayload = await clearResponse.json();
    assert.equal(clearPayload.ok, true);
    const clearedTwitterState = clearPayload.completeness.sourceStates.find((item: { source: string }) => item.source === 'twitter');
    assert.equal(clearedTwitterState?.checkpointJson, null);
    assert.equal(clearedTwitterState?.provenStartMs, null);

    console.log('completeness api tests: ok');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.PILIPILI_DB_PATH;
    } else {
      process.env.PILIPILI_DB_PATH = previousDbPath;
    }

    if (previousDataDir === undefined) {
      delete process.env.PILIPILI_DATA_DIR;
    } else {
      process.env.PILIPILI_DATA_DIR = previousDataDir;
    }

    if (previousAdminToken === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = previousAdminToken;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
