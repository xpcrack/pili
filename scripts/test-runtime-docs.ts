import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  assert.match(agents, /pm2/i, 'AGENTS.md should mention pm2 runtime management');
  assert.match(
    agents,
    /switch to development mode|development mode/i,
    'AGENTS.md should explain switching to development mode'
  );
  assert.match(
    agents,
    /switch back to production mode|production mode/i,
    'AGENTS.md should explain switching back to production mode'
  );
  assert.match(
    agents,
    /do not restart workers by default|do not stop\/restart background workers unless explicitly asked|workers stay running/i,
    'AGENTS.md should tell AI not to restart workers by default'
  );

  assert.match(readme, /^## Runtime Modes$/m, 'README.md should contain a Runtime Modes section');
  assert.match(readme, /npm run runtime:dev:on/, 'README.md should document npm run runtime:dev:on');
  assert.match(readme, /npm run runtime:dev:off/, 'README.md should document npm run runtime:dev:off');
  assert.match(
    readme,
    /npm run start|production web runtime|production web mode/i,
    'README.md should explain npm run start / production web runtime'
  );

  console.log('runtime docs tests: ok');
}

run();
