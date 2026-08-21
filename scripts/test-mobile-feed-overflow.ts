import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function main() {
  const pageSource = readFileSync('app/page.tsx', 'utf8');
  assert.match(
    pageSource,
    /id="feed-list"[^>]*className="[^"]*overflow-x-auto[^"]*"/,
    'the 700px trade grid must scroll inside feed-list instead of widening the mobile document'
  );
  console.log('mobile feed overflow tests: ok');
}

main();
