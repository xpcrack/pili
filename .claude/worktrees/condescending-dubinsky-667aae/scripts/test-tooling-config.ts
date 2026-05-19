import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const eslintConfig = readFileSync(join(repoRoot, 'eslint.config.mjs'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.match(
    eslintConfig,
    /["']\.worktrees\/\*\*["']/,
    'eslint config should ignore checked-in .worktrees copies'
  );

  const testScript = packageJson.scripts?.test || '';
  assert.match(
    testScript,
    /scripts\/lib\/runTests\.ts/,
    'npm test should invoke the discovery-based runner so all test-*.ts files are picked up automatically'
  );

  // Files the runner auto-discovers, asserted to still exist (and therefore run under npm test):
  const requiredTestFiles = [
    'scripts/test-time-format.ts',
    'scripts/test-trade-usd.ts',
    'scripts/test-telegram-monitor-reconciliation.ts',
    'scripts/test-telegram-agent-authorization.ts',
  ];
  for (const relPath of requiredTestFiles) {
    assert.equal(
      existsSync(join(repoRoot, relPath)),
      true,
      `${relPath} must exist; the runner auto-includes it in npm test`
    );
  }

  console.log('tooling config tests: ok');
}

run();
