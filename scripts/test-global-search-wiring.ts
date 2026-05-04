import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const pagePath = join(process.cwd(), 'app/page.tsx');
  const source = readFileSync(pagePath, 'utf8');

  assert.match(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*getRemoteFeedSearchKeyword\(searchFilters\.keyword\)\s*,/,
    'Home page should only forward safe remote-search keywords into useActivityPolling'
  );
  assert.match(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*getRemoteFeedSearchKeyword\(searchFilters\.keyword\)\s*,\s*getRemoteFeedSource\(searchFilters\.typeFilters\)\s*(?:,|\))/,
    'Home page should forward a remote source hint when the local type filters can narrow the remote feed safely'
  );
  assert.match(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*getRemoteFeedSearchKeyword\(searchFilters\.keyword\)\s*,\s*getRemoteFeedSource\(searchFilters\.typeFilters\)\s*,\s*searchFilters\s*\)/,
    'Home page should pass the full search filter state so polling can decide when to scan the whole database'
  );
  assert.doesNotMatch(
    source,
    /useActivityPolling\s*\(\s*selectedUserId\s*,\s*''\s*\)/,
    'Home page should not hardcode an empty search query for feed polling'
  );

  console.log('global search wiring tests: ok');
}

run();
