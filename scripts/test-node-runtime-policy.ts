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

  console.log('node runtime policy tests: ok');
}

run();
