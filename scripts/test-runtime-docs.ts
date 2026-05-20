import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  assert.match(agents, /`pili-web-prod`/, 'AGENTS.md should mention pili-web-prod');
  assert.match(agents, /production-only daily runtime expectation/, 'AGENTS.md should state production-only daily runtime expectation');
  assert.match(agents, /`runtime:refresh`/, 'AGENTS.md should mention runtime:refresh');
  assert.match(
    agents,
    /build must succeed before replacing the running web process/,
    'AGENTS.md should require successful build before replacing production web process'
  );
  assert.match(
    agents,
    /do not restart workers by default unless user asks/,
    'AGENTS.md should say not to restart workers by default'
  );

  assert.match(readme, /^## Runtime Setup$/m, 'README.md should contain a Runtime Setup section');
  assert.match(readme, /npm run runtime:status/, 'README.md should document npm run runtime:status');
  assert.match(readme, /npm run runtime:refresh/, 'README.md should document npm run runtime:refresh');
  assert.match(
    readme,
    /pm2-managed production web steady state/,
    'README.md should describe pm2-managed production steady state'
  );
  assert.match(
    readme,
    /refresh only rebuilds and replaces the production web process `pili-web-prod`/,
    'README.md should explain refresh targets web process only'
  );
  assert.match(
    readme,
    /workers are intentionally left running during refresh/,
    'README.md should explain workers are left running during refresh'
  );
  assert.match(
    readme,
    /same `.env.local`, `.data`, and SQLite DB/,
    'README.md should explain shared .env.local, .data, and SQLite DB usage'
  );
  assert.match(
    readme,
    /If you are actively editing code without pm2, `npm run dev` still works locally at \[http:\/\/localhost:3005\]\(http:\/\/localhost:3005\)/,
    'README.md should include the localhost:3005 fallback dev mode'
  );
  assert.match(
    readme,
    /`npm run build` and `npm run start` are the underlying local equivalent \/ fallback/,
    'README.md should clarify manual build/start as the local equivalent or fallback'
  );

  console.log('runtime docs tests: ok');
}

run();
