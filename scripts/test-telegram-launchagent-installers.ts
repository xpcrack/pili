import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readText(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertInstallerExists(relativePath: string, label: string) {
  const absolutePath = path.join(repoRoot, relativePath);
  assert.equal(existsSync(absolutePath), true, `expected installer script for ${label}: ${relativePath}`);
  const contents = readFileSync(absolutePath, 'utf8');
  assert.match(contents, /launchctl bootstrap/, `${label} installer should bootstrap the launch agent`);
  assert.match(contents, /launchctl kickstart -k/, `${label} installer should kickstart the launch agent`);
}

async function main() {
  assertInstallerExists('scripts/install-telegram-bridge-launchagent.sh', 'telegram-bridge');
  assertInstallerExists('scripts/install-telegram-channel-sync-launchagent.sh', 'telegram-channel-sync');

  const packageJson = JSON.parse(readText('package.json')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    typeof packageJson.scripts?.['telegram:bridge:install-launchagent'],
    'string',
    'package.json should expose a telegram:bridge:install-launchagent script'
  );
  assert.equal(
    typeof packageJson.scripts?.['telegram:channel:install-launchagent'],
    'string',
    'package.json should expose a telegram:channel:install-launchagent script'
  );

  console.log('telegram launchagent installer tests: ok');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
