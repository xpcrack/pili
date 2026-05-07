import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface CliFlags {
  root: string;
  filter: string | null;
  bail: boolean;
  verbose: boolean;
  timeoutMs: number;
}

interface TestResult {
  name: string;
  file: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 60;

function printHelp() {
  console.log(`Usage: tsx scripts/lib/runTests.ts [--flags]

Flags:
  --root=<dir>       Directory to scan (default: scripts)
  --filter=<substr>  Only run tests whose basename contains <substr> (case-insensitive)
  --bail             Stop at first failure
  --verbose          Print every test's stdout/stderr
  --timeout=<sec>    Per-test timeout (default: ${DEFAULT_TIMEOUT_SEC})
  -h, --help         Show this help`);
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    root: 'scripts',
    filter: null,
    bail: false,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_SEC * 1000,
  };
  for (const arg of argv) {
    if (arg === '--bail') flags.bail = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--filter=')) {
      flags.filter = arg.slice('--filter='.length);
    } else if (arg.startsWith('--root=')) {
      flags.root = arg.slice('--root='.length);
    } else if (arg.startsWith('--timeout=')) {
      const sec = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (!Number.isFinite(sec) || sec <= 0) {
        console.error(`runTests: invalid --timeout value: ${arg}`);
        process.exit(2);
      }
      flags.timeoutMs = sec * 1000;
    } else {
      console.error(`runTests: unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

function discoverTests(root: string, filter: string | null): string[] {
  const lowerFilter = filter ? filter.toLowerCase() : null;
  const entries = readdirSync(root, { withFileTypes: true });
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.startsWith('test-')) continue;
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (lowerFilter && !name.toLowerCase().includes(lowerFilter)) continue;
    matched.push(path.join(root, name));
  }
  matched.sort();
  return matched;
}

function runOne(file: string, timeoutMs: number, verbose: boolean): Promise<TestResult> {
  const name = path.basename(file).replace(/\.tsx?$/, '');
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('npx', ['tsx', file], {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ./scripts/server-only-shim.cjs`.trim(),
      },
      stdio: verbose ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    if (!verbose) {
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve({
        name,
        file,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        name,
        file,
        exitCode: -1,
        stdout,
        stderr: stderr + (error instanceof Error ? error.message : String(error)),
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function reportPass(name: string, durationMs: number) {
  console.log(`  ✓ ${name} (${durationMs}ms)`);
}

function reportFail(result: TestResult, timeoutSec: number) {
  if (result.timedOut) {
    console.log(`  ✗ ${result.name} (timed out after ${timeoutSec}s)`);
  } else {
    console.log(`  ✗ ${result.name} (${result.durationMs}ms)`);
  }
  if (result.stdout.trim()) {
    console.log(indent(result.stdout));
  }
  if (result.stderr.trim()) {
    console.log(indent(result.stderr));
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const files = discoverTests(flags.root, flags.filter);

  if (files.length === 0) {
    const where = flags.filter ? ` matching '${flags.filter}'` : '';
    console.error(`runTests: no tests found under ${flags.root}${where}`);
    process.exit(1);
  }

  const timeoutSec = Math.round(flags.timeoutMs / 1000);
  console.log(
    `Running ${files.length} test${files.length === 1 ? '' : 's'} serially with ${timeoutSec}s timeout each.\n`
  );

  const results: TestResult[] = [];
  const startedAt = Date.now();
  for (const file of files) {
    const result = await runOne(file, flags.timeoutMs, flags.verbose);
    results.push(result);
    if (result.exitCode === 0 && !result.timedOut) {
      reportPass(result.name, result.durationMs);
    } else {
      reportFail(result, timeoutSec);
      if (flags.bail) break;
    }
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const passed = results.filter((r) => r.exitCode === 0 && !r.timedOut).length;
  const failed = results.filter((r) => r.exitCode !== 0 || r.timedOut);

  console.log('\n──────────────────────────────────────');
  console.log(`PASS: ${passed}   FAIL: ${failed.length}   TIME: ${totalSec}s`);
  console.log('──────────────────────────────────────');

  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const result of failed) {
      console.log(`  - ${result.name}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error(`runTests: fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
