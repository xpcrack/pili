import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    /\bnpm run test:time-format\b/,
    'npm test should include the time-format regression coverage'
  );
  assert.match(
    testScript,
    /\bnpm run test:trade-usd\b/,
    'npm test should include the trade-usd regression coverage'
  );
  assert.match(
    testScript,
    /\bnpm run test:telegram-monitor-reconciliation\b/,
    'npm test should include the telegram monitor reconciliation regression coverage'
  );

  console.log('tooling config tests: ok');
}

run();
