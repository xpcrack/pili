import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8').trim();
}

function run() {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const agents = readRepoFile('AGENTS.md');
  const readme = readRepoFile('README.md');
  const troubleshooting = readRepoFile('TROUBLESHOOTING.md');

  assert.equal(readRepoFile('.nvmrc'), '24.11.1', '.nvmrc should pin Node 24.11.1');
  assert.equal(readRepoFile('.node-version'), '24.11.1', '.node-version should pin Node 24.11.1');
  assert.equal(
    packageJson.engines?.node,
    '>=24.11.1 <25',
    'package.json should constrain the repo to Node 24.x'
  );
  assert.equal(
    packageJson.scripts?.['test:node-runtime-policy'],
    'tsx scripts/test-node-runtime-policy.ts',
    'package.json should expose the node runtime policy regression test'
  );
  assert.match(
    packageJson.scripts?.test || '',
    /\bnpm run test:node-runtime-policy\b/,
    'npm test should include the node runtime policy regression test'
  );

  assert.match(
    agents,
    /Use Node `24\.11\.1` for this repo\./,
    'AGENTS.md should declare the pinned Node version'
  );
  assert.match(
    agents,
    /Do not switch to Node `25\+` unless you first reinstall or rebuild native dependencies and then verify `npm run build` and `npm test` both pass\./,
    'AGENTS.md should warn agents not to jump to Node 25+ without revalidation'
  );

  assert.match(readme, /## Runtime/, 'README.md should expose a Runtime section near the top');
  assert.match(
    readme,
    /Use Node `24\.11\.1` for this repo\./,
    'README.md should document the pinned Node version'
  );
  assert.match(
    readme,
    /npm rebuild better-sqlite3/,
    'README.md should point to the native module recovery command'
  );

  assert.match(
    troubleshooting,
    /This repo is pinned to Node `24\.11\.1`\./,
    'TROUBLESHOOTING.md should explain the pinned runtime'
  );
  assert.match(
    troubleshooting,
    /npm rebuild better-sqlite3/,
    'TROUBLESHOOTING.md should document the rebuild command'
  );
  assert.match(
    troubleshooting,
    /NODE_MODULE_VERSION/,
    'TROUBLESHOOTING.md should mention the ABI mismatch symptom'
  );

  console.log('node runtime policy tests: ok');
}

run();
