import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function run() {
  const source = readFileSync(new URL('../hooks/useSelectedUserDetails.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /new Map<string,\s*UserDetailsSuccessPayload>\(\)/,
    'hook should allocate a per-user in-memory cache map'
  );
  assert.match(
    source,
    /cacheRef\.current\.get\(userId\)/,
    'hook should read cached details by selected user id'
  );
  assert.match(
    source,
    /cacheRef\.current\.set\(userId,\s*payload\)/,
    'hook should cache successful payloads by selected user id'
  );
  assert.match(
    source,
    /setRefreshing\(Boolean\(cached\)\)/,
    'hook should only enter refreshing mode when cached details already exist'
  );

  console.log('selected user details hook contract tests: ok');
}

void run();
