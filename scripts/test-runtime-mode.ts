import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const ecosystemPath = join(repoRoot, 'pm2', 'ecosystem.config.cjs');
  const runtimeMode = readFileSync(join(repoRoot, 'scripts', 'runtime-mode.ts'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(existsSync(ecosystemPath), true, 'pm2/ecosystem.config.cjs should exist');

  const ecosystemConfig = readFileSync(ecosystemPath, 'utf8');
  for (const appName of [
    'pili-web-prod',
    'pili-web-dev',
    'pili-telegram-channel-worker',
    'pili-completeness-worker',
  ]) {
    assert.match(
      ecosystemConfig,
      new RegExp(`name:\\s*['\"]${appName}['\"]`),
      `ecosystem config should define ${appName}`
    );
  }

  assert.match(ecosystemConfig, /npm run start/, 'ecosystem config should run npm run start');
  assert.match(ecosystemConfig, /npm run dev/, 'ecosystem config should run npm run dev');

  const expectedScripts = {
    'runtime:status': 'tsx scripts/runtime-mode.ts status',
    'runtime:dev:on': 'tsx scripts/runtime-mode.ts dev-on',
    'runtime:dev:off': 'tsx scripts/runtime-mode.ts dev-off',
    'test:runtime-mode': 'tsx scripts/test-runtime-mode.ts',
  } satisfies Record<string, string>;

  for (const [scriptName, expectedCommand] of Object.entries(expectedScripts)) {
    assert.equal(
      packageJson.scripts?.[scriptName],
      expectedCommand,
      `package.json should expose ${scriptName}`
    );
  }

  assert.match(runtimeMode, /execFileSync\('pm2', \['jlist'\]/, 'runtime-mode should inspect pm2 jlist');
  assert.match(runtimeMode, /JSON\.parse/, 'runtime-mode should parse pm2 jlist JSON output');
  assert.match(runtimeMode, /name\s*===\s*processName/, 'runtime-mode should check process existence by name');
  assert.doesNotMatch(
    runtimeMode,
    /Process or Namespace["]?\)\s*&&\s*output\.includes\(['"]not found['"]\)/,
    'runtime-mode should not rely on thrown pm2 stop error strings to detect missing processes'
  );

  console.log('runtime mode tests: ok');
}

run();
