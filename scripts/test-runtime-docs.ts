import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function run() {
  const repoRoot = process.cwd();
  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  assert.match(agents, /`pili-web-prod`/, 'AGENTS.md should mention pili-web-prod');
  assert.match(agents, /`pili-web-dev`/, 'AGENTS.md should mention pili-web-dev');
  assert.match(
    agents,
    /run a production build, and only if the build succeeds start `pili-web-prod`/,
    'AGENTS.md should require a production build before switching back'
  );
  assert.match(
    agents,
    /do not stop or restart background workers unless explicitly asked/,
    'AGENTS.md should say not to stop or restart background workers unless explicitly asked'
  );

  assert.match(readme, /^## Runtime Modes$/m, 'README.md should contain a Runtime Modes section');
  assert.match(readme, /npm run runtime:status/, 'README.md should document npm run runtime:status');
  assert.match(readme, /npm run runtime:dev:on/, 'README.md should document npm run runtime:dev:on');
  assert.match(readme, /npm run runtime:dev:off/, 'README.md should document npm run runtime:dev:off');
  assert.match(
    readme,
    /pm2-managed production web mode/,
    'README.md should describe pm2-managed daily usage'
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
