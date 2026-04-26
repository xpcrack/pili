import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const pagePath = join(process.cwd(), 'app/page.tsx');
  const source = readFileSync(pagePath, 'utf8');

  assert.match(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*getRemoteFeedSearchKeyword\(searchFilters\.keyword\)\s*\)/,
    'Home page should only forward safe remote-search keywords into useActivityPolling'
  );
  assert.doesNotMatch(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*''\s*\)/,
    'Home page should not hardcode an empty search query for feed polling'
  );

  console.log('global search wiring tests: ok');
}

run();
