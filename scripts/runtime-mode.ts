import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type RuntimeModeCommand = 'status' | 'dev-on' | 'dev-off' | 'refresh';
type Pm2Process = { name?: string };

const repoRoot = process.cwd();
const ecosystemPath = join(repoRoot, 'pm2', 'ecosystem.config.cjs');

function printUsage() {
  console.error('Usage: tsx scripts/runtime-mode.ts <status|dev-on|dev-off|refresh>');
}

function runPm2(args: string[]) {
  execFileSync('pm2', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function readPm2Processes() {
  const output = execFileSync('pm2', ['jlist'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return JSON.parse(output) as Pm2Process[];
}

function hasPm2Process(processName: string) {
  return readPm2Processes().some(({ name }) => name === processName);
}

function stopIfPresent(processName: string) {
  if (!hasPm2Process(processName)) {
    return;
  }

  runPm2(['stop', processName]);
}

function startPm2Process(processName: string) {
  runPm2(['start', ecosystemPath, '--only', processName]);
}

function restartPm2Process(processName: string) {
  runPm2(['restart', ecosystemPath, '--only', processName]);
}

function reloadPm2Process(processName: string) {
  runPm2(['reload', ecosystemPath, '--only', processName]);
}

function startOrRestart(processName: string) {
  if (hasPm2Process(processName)) {
    restartPm2Process(processName);
    return;
  }

  startPm2Process(processName);
}

function startOrReload(processName: string) {
  if (hasPm2Process(processName)) {
    reloadPm2Process(processName);
    return;
  }

  startPm2Process(processName);
}

function runNpm(args: string[]) {
  execFileSync('npm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function run(command: RuntimeModeCommand) {
  if (command === 'status') {
    runPm2(['status']);
    return;
  }

  if (command === 'dev-on') {
    stopIfPresent('pili');
    stopIfPresent('pili-web-prod');
    startOrRestart('pili-web-dev');
    return;
  }

  if (command === 'refresh') {
    stopIfPresent('pili');
    runNpm(['run', 'build']);
    startOrReload('pili-web-prod');
    return;
  }

  stopIfPresent('pili');
  stopIfPresent('pili-web-dev');
  runNpm(['run', 'build']);
  startOrRestart('pili-web-prod');
}

const command = process.argv[2] as RuntimeModeCommand | undefined;

if (!command || !['status', 'dev-on', 'dev-off', 'refresh'].includes(command)) {
  printUsage();
  process.exit(1);
}

run(command);
