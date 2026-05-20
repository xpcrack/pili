import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type RuntimeModeCommand = 'status' | 'dev-on' | 'dev-off';

const repoRoot = process.cwd();
const ecosystemPath = join(repoRoot, 'pm2', 'ecosystem.config.cjs');

function printUsage() {
  console.error('Usage: tsx scripts/runtime-mode.ts <status|dev-on|dev-off>');
}

function runPm2(args: string[]) {
  execFileSync('pm2', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function stopIfPresent(processName: string) {
  try {
    runPm2(['stop', processName]);
  } catch (error) {
    const output = String(error);
    if (output.includes('Process or Namespace') && output.includes('not found')) {
      return;
    }

    throw error;
  }
}

function startOrRestart(processName: string) {
  try {
    runPm2(['restart', ecosystemPath, '--only', processName]);
  } catch {
    runPm2(['start', ecosystemPath, '--only', processName]);
  }
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
    stopIfPresent('pili-web-prod');
    startOrRestart('pili-web-dev');
    return;
  }

  stopIfPresent('pili-web-dev');
  runNpm(['run', 'build']);
  startOrRestart('pili-web-prod');
}

const command = process.argv[2] as RuntimeModeCommand | undefined;

if (!command || !['status', 'dev-on', 'dev-off'].includes(command)) {
  printUsage();
  process.exit(1);
}

run(command);
