import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

type RuntimeModeCommand = 'status' | 'dev-on' | 'dev-off' | 'refresh';
type Pm2Process = { name?: string };

const repoRoot = process.cwd();
const ecosystemPath = join(repoRoot, 'pm2', 'ecosystem.config.cjs');

const READY_POLL_INTERVAL_MS = 2_000;
const READY_POLL_MAX_ATTEMPTS = 30;

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
  const cleanOutput = output.replace(/\[[0-9;]*m/g, '');
  const jsonStart = cleanOutput.indexOf('[{');
  const jsonText = jsonStart >= 0 ? cleanOutput.slice(jsonStart) : cleanOutput;

  return JSON.parse(jsonText) as Pm2Process[];
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

function restartPm2Process(processName: string) {
  runPm2(['restart', ecosystemPath, '--only', processName]);
}

function startOrRestart(processName: string) {
  if (hasPm2Process(processName)) {
    restartPm2Process(processName);
    return;
  }

  runPm2(['start', ecosystemPath, '--only', processName]);
}

function runNpm(args: string[]) {
  execFileSync('npm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function waitForReady(timeoutMs = READY_POLL_INTERVAL_MS * READY_POLL_MAX_ATTEMPTS) {
  const start = Date.now();
  const port = process.env.PORT || '3013';
  const url = `http://127.0.0.1:${port}/api/runtime/ready`;

  for (let attempt = 1; attempt <= READY_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const result = execFileSync('curl', ['--silent', '--max-time', '1', url], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: READY_POLL_INTERVAL_MS + 500,
      });
      const json = JSON.parse(result);
      if (json?.ok === true && json?.lifecycle === 'ready') {
        console.log(`[runtime] ready after ${attempt} poll(s), ${Date.now() - start}ms`);
        return true;
      }
    } catch {
      // not ready yet or not running
    }

    if (Date.now() - start >= timeoutMs) break;
    if (attempt < READY_POLL_MAX_ATTEMPTS) {
      execFileSync('sleep', [(READY_POLL_INTERVAL_MS / 1000).toString()], { cwd: repoRoot });
    }
  }

  console.error(`[runtime] readiness poll timed out after ${Date.now() - start}ms`);
  return false;
}

function run(command: RuntimeModeCommand) {
  if (command === 'status') {
    runPm2(['status']);
    return;
  }

  if (command === 'dev-on') {
    // Live mode embeds runtime tasks; stop the prod background worker so
    // position-delta / twitter-identity-backfill don't run in both processes.
    stopIfPresent('pili');
    stopIfPresent('pili-web-prod');
    stopIfPresent('pili-background-worker');
    startOrRestart('pili-web-dev');
    return;
  }

  if (command === 'refresh') {
    // Build FIRST — if it fails the running web stays untouched.
    runNpm(['run', 'build']);
    // build succeeded: replace the running production process
    startOrRestart('pili-web-prod');
    const ready = waitForReady();
    if (!ready) {
      console.error('[runtime] WARNING: pili-web-prod did not become ready within timeout');
      process.exitCode = 1;
    }
    return;
  }

  // dev-off: build FIRST so a failed build never takes the site down.
  runNpm(['run', 'build']);
  stopIfPresent('pili');
  stopIfPresent('pili-web-dev');
  startOrRestart('pili-web-prod');
  // dev-on stopped it; restore the periodic-task owner (restart covers stopped).
  startOrRestart('pili-background-worker');
  const ready = waitForReady();
  if (!ready) {
    console.error('[runtime] WARNING: pili-web-prod did not become ready within timeout');
    process.exitCode = 1;
  }
}

const command = process.argv[2] as RuntimeModeCommand | undefined;

if (!command || !['status', 'dev-on', 'dev-off', 'refresh'].includes(command)) {
  printUsage();
  process.exit(1);
}

run(command);
