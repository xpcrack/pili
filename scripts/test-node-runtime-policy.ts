import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8').trim();
}

function readMarkedBlock(content: string, startMarker: string, endMarker: string) {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  assert.notEqual(startIndex, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(endIndex, -1, `Missing end marker: ${endMarker}`);
  assert.ok(endIndex > startIndex, `${endMarker} should appear after ${startMarker}`);

  return content.slice(startIndex, endIndex + endMarker.length);
}

function readSection(content: string, startHeading: string, endHeading?: string) {
  const startIndex = content.indexOf(startHeading);

  assert.notEqual(startIndex, -1, `Missing section heading: ${startHeading}`);

  if (!endHeading) {
    return content.slice(startIndex);
  }

  const endIndex = content.indexOf(endHeading);
  assert.notEqual(endIndex, -1, `Missing section heading: ${endHeading}`);
  assert.ok(endIndex > startIndex, `${endHeading} should appear after ${startHeading}`);

  return content.slice(startIndex, endIndex);
}

function readSectionUntilNextTopLevelHeading(content: string, startHeading: string) {
  const startIndex = content.indexOf(startHeading);

  assert.notEqual(startIndex, -1, `Missing section heading: ${startHeading}`);

  const rest = content.slice(startIndex + startHeading.length);
  const nextTopLevelHeadingOffset = rest.search(/\n# /);

  if (nextTopLevelHeadingOffset === -1) {
    return content.slice(startIndex);
  }

  return content.slice(startIndex, startIndex + startHeading.length + nextTopLevelHeadingOffset);
}

function run() {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const agents = readRepoFile('AGENTS.md');
  const readme = readRepoFile('README.md');
  const troubleshooting = readRepoFile('TROUBLESHOOTING.md');
  const agentsRuntimeBlock = readMarkedBlock(agents, '<!-- BEGIN:runtime-rules -->', '<!-- END:runtime-rules -->');
  const readmeRuntimeBlock = readSection(readme, '## Runtime', '## Getting Started');
  const troubleshootingTopSection = readSectionUntilNextTopLevelHeading(
    troubleshooting,
    '## Node runtime and better-sqlite3'
  );

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
    agentsRuntimeBlock,
    /Node `24\.11\.1`/,
    'AGENTS.md runtime block should declare the pinned Node version'
  );
  assert.match(
    agentsRuntimeBlock,
    /Node `25\+`/,
    'AGENTS.md runtime block should warn about Node 25+'
  );
  assert.match(
    agentsRuntimeBlock,
    /npm run build/,
    'AGENTS.md runtime block should require build verification'
  );
  assert.match(
    agentsRuntimeBlock,
    /npm test/,
    'AGENTS.md runtime block should require test verification'
  );

  assert.match(
    readmeRuntimeBlock,
    /Node `24\.11\.1`/,
    'README.md Runtime section should document the pinned Node version'
  );
  assert.match(
    readmeRuntimeBlock,
    /nvm use/,
    'README.md Runtime section should include the nvm use command'
  );
  assert.match(
    readmeRuntimeBlock,
    /npm rebuild better-sqlite3/,
    'README.md Runtime section should point to the native module recovery command'
  );
  assert.ok(
    readme.indexOf('## Runtime') < readme.indexOf('## Getting Started'),
    'README.md should place the Runtime section before Getting Started'
  );

  assert.match(
    troubleshootingTopSection,
    /Node `24\.11\.1`/,
    'TROUBLESHOOTING.md top section should explain the pinned runtime'
  );
  assert.match(
    troubleshootingTopSection,
    /NODE_MODULE_VERSION/,
    'TROUBLESHOOTING.md top section should mention the ABI mismatch symptom'
  );
  assert.match(
    troubleshootingTopSection,
    /npm rebuild better-sqlite3/,
    'TROUBLESHOOTING.md top section should document the rebuild command'
  );
  assert.match(
    troubleshootingTopSection,
    /npm test/,
    'TROUBLESHOOTING.md top section should include the verification command'
  );

  console.log('node runtime policy tests: ok');
}

run();
